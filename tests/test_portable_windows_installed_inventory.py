import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_portable_download import make_directory, HEAD
from test_portable_windows_stage import package, snapshot
from verify_windows_first_install import APP_DIR, verify_first_install


class WindowsInstalledInventoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.parent = Path(temp.name).resolve()
        self.root = self.parent / APP_DIR
        self.files = package()
        make_directory(self.root, self.files)
        self.digest = hashlib.sha256(self.files['build-manifest.json']).hexdigest()

    def verify(self, head=HEAD, version='0.1.0', digest=None):
        return verify_first_install(self.parent, head, version, self.digest if digest is None else digest)

    def test_receipt_and_adjacent_data_unchanged(self):
        (self.parent / 'existing-project.json').write_text('synthetic')
        before = snapshot(self.parent)
        receipt = self.verify()
        self.assertEqual(snapshot(self.parent), before)
        self.assertEqual(receipt['filesIncludingManifest'], len(self.files))
        self.assertEqual(receipt['manifestSha256'], self.digest)
        self.assertEqual(receipt['head'], HEAD)
        self.assertFalse(receipt['installerExecutionVerified'])
        self.assertFalse(receipt['signatureVerified'])

    def test_pending_entry_and_unexpected_empty_directory_refused(self):
        pending = self.parent / (APP_DIR + '.pending')
        pending.write_bytes(b'interrupted')
        with self.assertRaisesRegex(ValueError, 'Pending'):
            self.verify()
        pending.unlink()
        extra = self.root / 'extra-empty'
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, 'Unexpected installed directory'):
            self.verify()

    def test_missing_or_modified_file_and_extra_file_refused(self):
        extra = self.root / 'extra.txt'
        extra.write_text('extra')
        with self.assertRaisesRegex(ValueError, 'Complete manifest mismatch'):
            self.verify()
        extra.unlink()
        app = self.root / 'resources/app/public/app.js'
        original = app.read_bytes()
        app.write_bytes(b'not original')
        with self.assertRaisesRegex(ValueError, 'Complete manifest mismatch'):
            self.verify()
        app.write_bytes(original)
        app.unlink()
        with self.assertRaisesRegex(ValueError, 'Complete manifest mismatch'):
            self.verify()

    def test_untrusted_manifest_and_wrong_build_refused(self):
        with self.assertRaisesRegex(ValueError, 'Wrong build head'):
            self.verify(head='b' * 40)
        with self.assertRaisesRegex(ValueError, 'Wrong requested version'):
            self.verify(version='0.2.0')
        rewritten = package(mutation=lambda files, _: files.update({'LocalAPI.exe': b'wrong'}))
        make_directory(self.root, rewritten)
        with self.assertRaisesRegex(ValueError, 'Installed manifest digest mismatch'):
            self.verify()

    def test_inaccessible_walk_is_not_silently_skipped(self):
        def inaccessible(*args, onerror, **kwargs):
            onerror(PermissionError('fixture: denied'))
            yield
        with patch('verify_portable_download.os.walk', side_effect=inaccessible):
            with self.assertRaisesRegex(PermissionError, 'fixture: denied'):
                self.verify()

    def test_cli_failure_has_no_success_receipt(self):
        command = [
            sys.executable, str(Path(__file__).resolve().parents[1] / 'scripts/verify_windows_first_install.py'),
            '--local-app-data', str(self.parent), '--payload-head', HEAD,
            '--version', '0.1.0', '--manifest-sha256', self.digest,
        ]
        ok = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(json.loads(ok.stdout)['kind'], 'windows-first-install-file-inventory')
        (self.root / 'LocalAPI.exe').unlink()
        failed = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stdout, '')
        self.assertIn('File inventory verification failed', failed.stderr)
