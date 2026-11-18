import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import download_pinned_windows_baseline as baseline
from test_portable_windows_stage import package, HEAD


def sha(data):
    return hashlib.sha256(data).hexdigest()


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        files = package()
        self.portable = self.zip('portable.zip', {'LocalAPI/' + k: v for k, v in files.items()})
        self.metadata = self.zip('metadata.zip', {'dist/LocalAPI/build-manifest.json': files['build-manifest.json']})
        self.lock = dict(schemaVersion=1, repository='Hubujiu/local-api-workbench', runId=123, head=HEAD,
                         manifestSha256=sha(files['build-manifest.json']),
                         portable=dict(id=1, name='portable', sha256=sha(self.portable.read_bytes())),
                         metadata=dict(id=2, name='metadata', sha256=sha(self.metadata.read_bytes())))

    def zip(self, name, files):
        path = self.root / name
        with zipfile.ZipFile(path, 'w') as archive:
            for key, value in files.items():
                archive.writestr(key, value)
        return path

    def extract(self):
        return baseline.extract_verified(self.portable, self.metadata, self.lock, self.root / 'out')

    def info(self):
        return dict(id=1, name='portable', expired=False, digest='sha256:' + self.lock['portable']['sha256'],
                    workflow_run=dict(id=123, head_sha=HEAD))

    def test_valid_flat_inventory(self):
        result = self.extract()
        self.assertEqual(result['head'], HEAD)
        self.assertTrue((self.root / 'out/LocalAPI.exe').is_file())
        self.assertFalse((self.root / 'out/LocalAPI').exists())

    def test_api_identity_all_fields_required(self):
        baseline.validate_artifact(self.info(), self.lock, 'portable')
        for key, value in [('id', 3), ('name', 'wrong'), ('expired', True), ('digest', 'sha256:' + '0'*64),
                           ('workflow_run', dict(id=4, head_sha=HEAD)), ('workflow_run', dict(id=123, head_sha='b'*40))]:
            info = self.info(); info[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                baseline.validate_artifact(info, self.lock, 'portable')

    def test_raw_pins_and_independent_manifest(self):
        for key in ('portable', 'metadata'):
            saved = self.lock[key]['sha256']; self.lock[key]['sha256'] = '0'*64
            with self.assertRaises(ValueError): self.extract()
            self.assertFalse((self.root / 'out').exists())
            self.lock[key]['sha256'] = saved
        self.metadata = self.zip('other.zip', {'dist/LocalAPI/build-manifest.json': b'wrong'})
        self.lock['metadata']['sha256'] = sha(self.metadata.read_bytes())
        with self.assertRaises(ValueError): self.extract()
        self.assertFalse((self.root / 'out').exists())

    def test_unsafe_zip_entries(self):
        cases = [{'../escape': b'x'}, {'/absolute': b'x'}, {'C:/drive': b'x'}, {'a\\b': b'x'},
                 {'a': b'x', 'a/b': b'x'}, {'A/x': b'x', 'a/y': b'x'}, {'NUL.txt': b'x'}, {'x.': b'x'}]
        for i, files in enumerate(cases):
            path = self.zip(f'unsafe-{i}.zip', files)
            with self.subTest(files=files), self.assertRaises(ValueError):
                baseline.checked_zip(path, sha(path.read_bytes()))

    def test_link_and_entry_limits(self):
        path = self.root / 'link.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            entry = zipfile.ZipInfo('link'); entry.create_system = 3; entry.external_attr = 0o120777 << 16
            archive.writestr(entry, '../outside')
        with self.assertRaises(ValueError): baseline.checked_zip(path, sha(path.read_bytes()))
        with patch.object(baseline, 'MAX_ENTRIES', 1), self.assertRaises(ValueError):
            baseline.checked_zip(self.portable, self.lock['portable']['sha256'])
        with patch.object(baseline, 'MAX_BYTES', 1), self.assertRaises(ValueError):
            baseline.checked_zip(self.portable, self.lock['portable']['sha256'])

    def test_token_not_forwarded_to_blob(self):
        body = self.portable.read_bytes(); calls = []; info = self.info()
        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                if len(calls) == 1: return io.BytesIO(json.dumps(info).encode())
                if len(calls) == 2:
                    raise urllib.error.HTTPError(request.full_url, 302, 'redirect',
                                                 {'Location': 'https://test.blob.core.windows.net/file?sig=secret'}, None)
                return io.BytesIO(body)
        baseline.download_artifact(self.lock, 'portable', self.root / 'download.zip', 'test-token', Opener())
        self.assertEqual(calls[0].get_header('Authorization'), 'Bearer test-token')
        self.assertEqual(calls[1].get_header('Authorization'), 'Bearer test-token')
        self.assertIsNone(calls[2].get_header('Authorization'))
        self.assertIsNone(baseline.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other'))

    def test_redirect_allowlist(self):
        info = self.info()
        for url in ['http://test.blob.core.windows.net/x', 'https://evil.example/x', 'https://user@test.blob.core.windows.net/x', 'https://test.blob.core.windows.net:444/x']:
            class Opener:
                def open(self, request, timeout):
                    if not request.full_url.endswith('/zip'): return io.BytesIO(json.dumps(info).encode())
                    raise urllib.error.HTTPError(request.full_url, 302, 'redirect', {'Location': url}, None)
            with self.subTest(url=url), self.assertRaises(ValueError):
                baseline.download_artifact(self.lock, 'portable', self.root / 'rejected.zip', 'token', Opener())

    def test_content_manifest_mismatch(self):
        files = package(); files['LocalAPI.exe'] = b'changed'
        self.portable = self.zip('changed.zip', {'LocalAPI/' + k: v for k, v in files.items()})
        self.lock['portable']['sha256'] = sha(self.portable.read_bytes())
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'): self.extract()

    def test_download_size_cap(self):
        body = self.portable.read_bytes(); info = self.info()
        class Opener:
            count = 0
            def open(self, request, timeout):
                self.count += 1
                if self.count == 1: return io.BytesIO(json.dumps(info).encode())
                if self.count == 2:
                    raise urllib.error.HTTPError(request.full_url, 302, 'redirect',
                                                 {'Location': 'https://test.blob.core.windows.net/file'}, None)
                return io.BytesIO(body)
        with patch.object(baseline, 'MAX_ZIP', 10), self.assertRaisesRegex(ValueError, 'size limit'):
            baseline.download_artifact(self.lock, 'portable', self.root / 'bounded.zip', 'token', Opener())

    def test_existing_or_aliased_destination(self):
        out = self.root / 'out'; out.mkdir()
        with self.assertRaises(ValueError): self.extract()
        self.assertEqual(list(out.iterdir()), [])


if __name__ == '__main__': unittest.main()
