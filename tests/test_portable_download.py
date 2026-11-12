import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('gate', Path(__file__).resolve().parents[1] / 'scripts/verify_portable_download.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
HEAD = 'a' * 40


def fixture(platform='linux'):
    exe = {'linux': 'LocalAPI', 'darwin': 'LocalAPI.app/Contents/MacOS/Electron', 'win32': 'LocalAPI.exe'}[platform]
    app = 'LocalAPI.app/Contents/Resources/app/' if platform == 'darwin' else 'resources/app/'
    files = {exe: b'executable fixture'}
    for name in ('package.json', 'desktop/main.mjs', 'src/runtime.mjs', 'public/app.js'):
        files[app + name] = b'not executable test data'
    manifest = {'head': HEAD, 'platform': platform, 'arch': 'x64', 'integrityVersion': 1, 'links': [], 'files': [{'path': n, 'sha256': hashlib.sha256(b).hexdigest()} for n, b in sorted(files.items())]}
    files['build-manifest.json'] = json.dumps(manifest).encode()
    return files


def make_directory(root, files):
    for name, data in files.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        p.chmod(0o755 if name in ('LocalAPI', 'LocalAPI.app/Contents/MacOS/Electron') else 0o644)


def make_tar(path, files, extra=()):
    with tarfile.open(path, 'w:gz') as out:
        dirs = {'LocalAPI'}
        for name in files:
            parts = ('LocalAPI/' + name).split('/')
            dirs.update('/'.join(parts[:i]) for i in range(1, len(parts)))
        for name in sorted(dirs):
            i = tarfile.TarInfo(name); i.type = tarfile.DIRTYPE; i.mode = 0o755; out.addfile(i)
        for name, data in files.items():
            i = tarfile.TarInfo('LocalAPI/' + name); i.size = len(data); i.mode = 0o755 if name in ('LocalAPI', 'LocalAPI.app/Contents/MacOS/Electron') else 0o644; out.addfile(i, io.BytesIO(data))
        for i, data in extra:
            out.addfile(i, io.BytesIO(data) if data is not None else None)


class DownloadGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_windows_reparse_package_root(self):
        fake = SimpleNamespace(st_mode=0o40755, st_file_attributes=0x400)
        with mock.patch.object(gate.Path, 'lstat', return_value=fake):
            with self.assertRaisesRegex(ValueError, 'Windows reparse root'):
                gate.inventory_directory(self.root)

    def test_windows_download_tree(self):
        make_directory(self.root / 'LocalAPI', fixture('win32'))
        result = gate.verify_download(self.root, 'win32', HEAD)
        self.assertEqual(result['files'], 5)

    def test_both_unix_archives_and_metadata(self):
        for platform, label in [('linux', 'Linux'), ('darwin', 'macOS')]:
            with self.subTest(platform=platform):
                root = self.root / platform; root.mkdir()
                files = fixture(platform)
                make_tar(root / ('LocalAPI-' + label + '.tar.gz'), files)
                make_directory(root / 'LocalAPI', {'build-manifest.json': files['build-manifest.json']})
                self.assertEqual(gate.verify_download(root, platform, HEAD)['platform'], platform)

    def test_missing_extra_and_changed_files(self):
        for mutation in ('missing', 'extra', 'changed'):
            with self.subTest(mutation=mutation):
                files = fixture('win32')
                if mutation == 'missing': del files['resources/app/public/app.js']
                elif mutation == 'extra': files['unexpected.txt'] = b'extra'
                else: files['resources/app/public/app.js'] = b'changed'
                root = self.root / mutation; make_directory(root, files)
                with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
                    gate.inventory_directory(root).verify(HEAD, 'win32')

    def test_manifest_order_matches_javascript_utf16(self):
        files = fixture('win32')
        files['resources/app/\ue000.txt'] = b'private-use'
        files['resources/app/\U00010000.txt'] = b'supplementary'
        m = json.loads(files.pop('build-manifest.json'))
        m['files'] = [{'path': n, 'sha256': hashlib.sha256(files[n]).hexdigest()}
                      for n in sorted(files, key=lambda n: n.encode('utf-16-be'))]
        files['build-manifest.json'] = json.dumps(m).encode()
        make_directory(self.root / 'LocalAPI', files)
        self.assertEqual(gate.verify_download(self.root, 'win32', HEAD)['files'], 7)

    def test_wrong_identity(self):
        root = self.root / 'package'; make_directory(root, fixture('win32'))
        inv = gate.inventory_directory(root)
        for head, platform in [('b' * 40, 'win32'), (HEAD, 'linux')]:
            with self.assertRaisesRegex(ValueError, 'Wrong'):
                inv.verify(head, platform)

    def test_manifest_duplicate_or_unsorted_files_rejected(self):
        files = fixture('win32'); manifest = json.loads(files['build-manifest.json'])
        manifest['files'].append(manifest['files'][0])
        files['build-manifest.json'] = json.dumps(manifest).encode(); make_directory(self.root, files)
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            gate.inventory_directory(self.root).verify(HEAD, 'win32')

    def test_archive_traversal_duplicate_and_special_entries(self):
        for name, kind in [('LocalAPI/../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('LocalAPI/LocalAPI', tarfile.REGTYPE), ('LocalAPI/device', tarfile.CHRTYPE), ('LocalAPI/hard', tarfile.LNKTYPE)]:
            with self.subTest(name=name):
                i = tarfile.TarInfo(name); i.type = kind; i.linkname = 'LocalAPI/LocalAPI'
                file = self.root / 'bad.tar.gz'; make_tar(file, fixture(), [(i, b'')])
                with self.assertRaises(ValueError): gate.inventory_archive(file)

    def test_truncated_gzip(self):
        p = self.root / 'bad.tar.gz'; make_tar(p, fixture()); p.write_bytes(p.read_bytes()[:-5])
        with self.assertRaises((EOFError, OSError, tarfile.TarError)): gate.inventory_archive(p)

    def test_decompressed_metadata_and_tail_count_toward_limit(self):
        p = self.root / 'padding.tar.gz'
        make_tar(p, fixture())
        decoded = gzip.decompress(p.read_bytes())
        original = gate.MAX_BYTES
        try:
            gate.MAX_BYTES = len(decoded) + 1024
            p.write_bytes(gzip.compress(decoded + b'\0' * 16384))
            with self.assertRaisesRegex(ValueError, 'Decompressed archive byte limit'):
                gate.inventory_archive(p)
        finally:
            gate.MAX_BYTES = original

    def test_oversized_extension_header_rejected_before_body(self):
        i = tarfile.TarInfo('pax'); i.type = tarfile.XHDTYPE; i.size = 1024 * 1024 + 1
        p = self.root / 'metadata.tar.gz'
        p.write_bytes(gzip.compress(i.tobuf()))
        with self.assertRaisesRegex(ValueError, 'Tar metadata size limit'):
            gate.inventory_archive(p)

    def test_mode_loss(self):
        make_directory(self.root, fixture()); inv = gate.inventory_directory(self.root); inv.modes['LocalAPI'] = 0o644
        with self.assertRaisesRegex(ValueError, 'executable mode'): inv.verify(HEAD, 'linux')

    def test_metadata_difference(self):
        files = fixture(); make_tar(self.root / 'LocalAPI-Linux.tar.gz', files)
        make_directory(self.root / 'LocalAPI', {'build-manifest.json': b'{}'})
        with self.assertRaisesRegex(ValueError, 'Outer/inner'): gate.verify_download(self.root, 'linux', HEAD)

    def test_link_escape_cycle_dangling(self):
        for target in ('../../outside', '/etc/passwd', 'a', 'missing', 'C:/outside'):
            with self.subTest(target=target):
                inv = gate.Inventory(); inv.add('a', 'symlink', 0o777, target=target)
                with self.assertRaises(ValueError): inv.links()

    def test_safe_link_chain(self):
        inv = gate.Inventory(); inv.add('dir', 'directory', 0o755)
        inv.add('dir/file', 'file', 0o644, io.BytesIO(b'x'), 1)
        inv.add('dir/alias', 'symlink', 0o777, target='file'); inv.add('alias', 'symlink', 0o777, target='dir/alias')
        self.assertEqual([x['resolved'] for x in inv.links()], ['dir/file', 'dir/file'])

    def test_bad_names_and_limits(self):
        for name in ('../a', '/a', 'a//b', 'a/./b', 'C:/a', 'a\\b', 'a\0b'):
            with self.assertRaises(ValueError): gate.Inventory().add(name, 'directory', 0o755)
        with self.assertRaisesRegex(ValueError, 'Byte limit'): gate.Inventory().add('a', 'file', 0o644, io.BytesIO(), gate.MAX_BYTES + 1)
        with self.assertRaisesRegex(ValueError, 'Manifest size'): gate.Inventory().add('build-manifest.json', 'file', 0o644, io.BytesIO(), gate.MAX_MANIFEST + 1)

    def test_expected_commit_must_be_exact(self):
        with self.assertRaisesRegex(ValueError, 'exact commit'): gate.verify_download(self.root, 'win32', 'main')

    def test_missing_launcher_and_entrypoint_even_with_consistent_manifest(self):
        for missing in ('LocalAPI.exe', 'resources/app/desktop/main.mjs'):
            files = fixture('win32'); del files[missing]
            m = json.loads(files['build-manifest.json']);m['files'] = [x for x in m['files'] if x['path'] != missing];files['build-manifest.json'] = json.dumps(m).encode()
            root = self.root / missing.replace('/', '_');make_directory(root, files)
            with self.assertRaisesRegex(ValueError, 'Missing'): gate.inventory_directory(root).verify(HEAD, 'win32')


if __name__ == '__main__':
    unittest.main()
