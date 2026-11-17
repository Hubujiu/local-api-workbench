"""Real filesystem comparisons; synthetic transitions are NOT native uninstall proof."""
import hashlib
import json
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_portable_download import make_directory, HEAD
from test_portable_windows_stage import package, snapshot
from verify_windows_first_install import APP_DIR
from verify_windows_lifecycle import capture, verify, overlaps
from windows_install_record import RECORD_NAME, record_bytes, record_digest


class WindowsLifecycleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.local = self.root / 'Local'; self.local.mkdir()
        self.app = self.local / APP_DIR
        self.files = package(); make_directory(self.app, self.files)
        self.digest = hashlib.sha256(self.files['build-manifest.json']).hexdigest()
        self.profile = self.root / 'Roaming' / 'local-api-workbench'
        self.profile.mkdir(parents=True)
        (self.profile / 'project.json').write_text('{"synthetic":"preserve"}')
        (self.profile / 'empty').mkdir()
        self.sentinel = self.local / 'other-app'; self.sentinel.mkdir()
        (self.sentinel / 'keep').write_bytes(b'neighbor')
        self.protected = [self.profile, self.sentinel]
        self.baseline = self.root / 'baseline.json'
        self.save_baseline()

    def save_baseline(self):
        receipt = capture(self.local, self.protected, HEAD, '0.1.0', self.digest)
        self.baseline.write_text(json.dumps(receipt))
        self.baseline_hash = hashlib.sha256(self.baseline.read_bytes()).hexdigest()

    def check(self, state='uninstalled', **kwargs):
        return verify(self.local, self.protected, self.baseline, self.baseline_hash, state, **kwargs)

    def test_uninstall_reinstall_and_next_payload_comparisons_are_read_only(self):
        # Only this test simulates transitions. Production utility never removes files.
        shutil.rmtree(self.app)
        before = snapshot(self.root)
        receipt = self.check()
        self.assertEqual(snapshot(self.root), before)
        self.assertFalse(receipt['operationExecuted']); self.assertFalse(receipt['nativeLifecycleVerified'])
        self.assertEqual(receipt['protectedFiles'], 2)
        for files, head, version in [(self.files, HEAD, '0.1.0'), (package('0.1.1', 'b' * 40), 'b' * 40, '0.1.1')]:
            make_directory(self.app, files)
            before = snapshot(self.root)
            receipt = self.check('installed', head=head, version=version,
                                 manifest_sha256=hashlib.sha256(files['build-manifest.json']).hexdigest())
            self.assertEqual(receipt['installed']['head'], head)
            self.assertEqual(snapshot(self.root), before)
            shutil.rmtree(self.app)

    def test_old_foreign_modified_and_partial_installs_do_not_pass(self):
        with self.assertRaisesRegex(ValueError, 'remains'): self.check()
        with self.assertRaisesRegex(ValueError, 'Wrong build head'):
            capture(self.local, self.protected, 'b' * 40, '0.1.0', self.digest)
        (self.app / 'LocalAPI.exe').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            capture(self.local, self.protected, HEAD, '0.1.0', self.digest)
        (self.app / 'LocalAPI.exe').unlink()
        with self.assertRaises(ValueError):
            self.check('installed', head=HEAD, version='0.1.0', manifest_sha256=self.digest)

    def test_pending_file_empty_directory_and_broken_link_refused(self):
        shutil.rmtree(self.app)
        pending = self.local / (APP_DIR + '.pending')
        pending.write_bytes(b'partial')
        with self.assertRaisesRegex(ValueError, 'remains'): self.check()
        pending.unlink(); pending.mkdir()
        with self.assertRaisesRegex(ValueError, 'remains'): self.check()
        pending.rmdir()
        try: pending.symlink_to(self.root / 'absent')
        except OSError: return  # Native Windows may not grant symlink privileges.
        with self.assertRaisesRegex(ValueError, 'remains'): self.check()

    def test_profile_changed_added_deleted_empty_directory_and_neighbor_detected(self):
        shutil.rmtree(self.app)
        target = self.profile / 'project.json'; old = target.read_bytes()
        target.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'differs'): self.check()
        target.write_bytes(old)
        extra = self.profile / 'added'; extra.mkdir()
        with self.assertRaisesRegex(ValueError, 'differs'): self.check()
        extra.rmdir(); (self.profile / 'empty').rmdir()
        with self.assertRaisesRegex(ValueError, 'differs'): self.check()
        (self.profile / 'empty').mkdir(); (self.sentinel / 'keep').unlink()
        with self.assertRaisesRegex(ValueError, 'synthetic file'): self.check()

    def test_baseline_digest_wrong_account_and_protected_selection_refused(self):
        shutil.rmtree(self.app)
        self.baseline.write_bytes(self.baseline.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'): self.check()
        self.baseline_hash = hashlib.sha256(self.baseline.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'differs'):
            verify(self.local, [self.profile], self.baseline, self.baseline_hash, 'uninstalled')
        other = self.root / 'other-local'; other.mkdir()
        with self.assertRaisesRegex(ValueError, 'another LOCALAPPDATA'):
            verify(other, self.protected, self.baseline, self.baseline_hash, 'uninstalled')

    def test_overlap_case_alias_and_missing_data_refused(self):
        for protected in ([self.app], [self.local], [self.profile, self.profile], [self.root]):
            with self.assertRaisesRegex(ValueError, 'disjoint'):
                capture(self.local, protected, HEAD, '0.1.0', self.digest)
        self.assertTrue(overlaps(PureWindowsPath('C:/Local/APP'), PureWindowsPath('c:/local/app/sub')))
        self.assertFalse(overlaps(PureWindowsPath('C:/Local/APP'), PureWindowsPath('c:/local/application')))
        with self.assertRaises(OSError):
            capture(self.local, [self.root / 'absent'], HEAD, '0.1.0', self.digest)

    def test_read_errors_and_links_fail_closed(self):
        def denied(*args, onerror, **kwargs):
            onerror(PermissionError('fixture denied')); yield
        with patch('verify_portable_download.os.walk', side_effect=denied):
            with self.assertRaises(PermissionError): self.check()
        linked = self.profile / 'linked'
        try: linked.symlink_to(self.sentinel, target_is_directory=True)
        except OSError: self.skipTest('Symlink privileges unavailable')
        with self.assertRaises(ValueError): self.check()

    def test_invalid_baseline_and_entry_limits(self):
        self.baseline.write_text('{"kind":"wrong"}')
        self.baseline_hash = hashlib.sha256(self.baseline.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'kind'): self.check()
        self.save_baseline()
        with patch('verify_portable_download.MAX_ENTRIES', 2):
            with self.assertRaisesRegex(ValueError, 'Entry limit'): self.check()

    def test_capture_size_limit_and_canonical_directory_alias(self):
        with patch('verify_windows_lifecycle.MAX_MANIFEST', 20):
            with self.assertRaisesRegex(ValueError, 'Baseline size limit'):
                capture(self.local, self.protected, HEAD, '0.1.0', self.digest)
        # Model Windows' canonical 8.3/alternate spelling expansion on Linux.
        # Native Windows path resolution still needs its own acceptance run.
        alias = self.root / 'SHORTAPP'; alias.mkdir()
        original = Path.resolve
        def resolve(path, *args, **kwargs):
            return self.app if path == alias else original(path, *args, **kwargs)
        with patch.object(Path, 'resolve', resolve):
            with self.assertRaisesRegex(ValueError, 'disjoint'):
                capture(self.local, [alias], HEAD, '0.1.0', self.digest)

    def test_record_bearing_capture_reinstall_and_legacy_are_explicit(self):
        # The initial baseline is the legacy #258-style fixture, without a record.
        legacy = json.loads(self.baseline.read_text())
        self.assertNotIn('installRecordSha256', legacy['installed'])
        self.assertNotIn('installRecordSha256', self.check('installed', head=HEAD, version='0.1.0',
                                                        manifest_sha256=self.digest)['installed'])
        record = record_bytes(HEAD, '0.1.0', self.digest)
        digest = record_digest(HEAD, '0.1.0', self.digest)
        (self.app / RECORD_NAME).write_bytes(record)
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            capture(self.local, self.protected, HEAD, '0.1.0', self.digest)
        baseline = capture(self.local, self.protected, HEAD, '0.1.0', self.digest, digest)
        self.assertEqual(baseline['installed']['installRecordSha256'], digest)
        self.assertFalse(baseline['installed']['deletionAuthorized'])
        self.baseline.write_text(json.dumps(baseline))
        self.baseline_hash = hashlib.sha256(self.baseline.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            self.check('installed', head=HEAD, version='0.1.0', manifest_sha256=self.digest)
        result = self.check('installed', head=HEAD, version='0.1.0', manifest_sha256=self.digest,
                            install_record_sha256=digest)
        self.assertEqual(result['previousInstalled']['installRecordSha256'], digest)
        self.assertEqual(result['installed']['installRecordSha256'], digest)
        with self.assertRaisesRegex(ValueError, 'does not match contract'):
            self.check('installed', head=HEAD, version='0.1.0', manifest_sha256=self.digest,
                       install_record_sha256='0' * 64)
        shutil.rmtree(self.app)
        self.assertIsNone(self.check()['installed'])
        with self.assertRaisesRegex(ValueError, 'does not accept'):
            self.check(install_record_sha256=digest)
        # A new target requires its own independent pin, not the baseline pin.
        files = package('0.1.1', 'b' * 40)
        make_directory(self.app, files)
        manifest = hashlib.sha256(files['build-manifest.json']).hexdigest()
        new_record = record_digest('b' * 40, '0.1.1', manifest)
        (self.app / RECORD_NAME).write_bytes(record_bytes('b' * 40, '0.1.1', manifest))
        result = self.check('installed', head='b' * 40, version='0.1.1', manifest_sha256=manifest,
                            install_record_sha256=new_record)
        self.assertEqual(result['installed']['installRecordSha256'], new_record)
        self.assertEqual(result['previousInstalled']['installRecordSha256'], digest)

    def test_cli_record_pin_reaches_capture_and_installed_verifier(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/verify_windows_lifecycle.py'
        digest = record_digest(HEAD, '0.1.0', self.digest)
        (self.app / RECORD_NAME).write_bytes(record_bytes(HEAD, '0.1.0', self.digest))
        common = ['--local-app-data', str(self.local), '--protect', str(self.profile),
                  '--protect', str(self.sentinel), '--payload-head', HEAD, '--version', '0.1.0',
                  '--manifest-sha256', self.digest, '--install-record-sha256', digest]
        result = subprocess.run([sys.executable, str(script), 'capture', *common], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.baseline.write_text(result.stdout)
        self.baseline_hash = hashlib.sha256(self.baseline.read_bytes()).hexdigest()
        args = [sys.executable, str(script), 'verify', *common, '--baseline', str(self.baseline),
                '--baseline-sha256', self.baseline_hash, '--state', 'installed']
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['installed']['installRecordSha256'], digest)

    def test_cli_success_and_failure_stdout_contract(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/verify_windows_lifecycle.py'
        args = [sys.executable, str(script), 'verify', '--local-app-data', str(self.local),
                '--protect', str(self.profile), '--protect', str(self.sentinel), '--baseline', str(self.baseline),
                '--baseline-sha256', self.baseline_hash, '--state', 'uninstalled']
        failed = subprocess.run(args, capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0); self.assertEqual(failed.stdout, '')
        shutil.rmtree(self.app)
        ok = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(json.loads(ok.stdout)['expectedState'], 'uninstalled')
        # Missing capture identity must produce a controlled failure, not a success receipt.
        failed = subprocess.run([sys.executable, str(script), 'capture', '--local-app-data', str(self.local),
                                 '--protect', str(self.profile)], capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0); self.assertEqual(failed.stdout, '')
        self.assertNotIn('Traceback', failed.stderr)
