"""Generated metadata + full payload verification; never execute an installer."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from test_portable_download import make_directory, HEAD
from test_portable_windows_stage import package, snapshot
from prepare_windows_first_install import prepare
from verify_windows_first_install import verify_first_install
from windows_install_record import APP_DIR, RECORD_NAME, record_bytes, record_digest


class InstallRecordTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.payload = self.root / 'payload'
        self.files = package(); make_directory(self.payload, self.files)
        self.digest = hashlib.sha256(self.files['build-manifest.json']).hexdigest()
        self.build = self.root / 'build'
        self.record = record_bytes(HEAD, '0.1.0', self.digest)
        self.record_hash = hashlib.sha256(self.record).hexdigest()
        self.local = self.root / 'local'; self.local.mkdir()
        self.installed = self.local / APP_DIR

    def generate(self):
        return prepare(self.payload, self.payload / 'build-manifest.json', self.build, HEAD, '0.1.0', self.digest)

    def install_fixture(self, record=True):
        make_directory(self.installed, self.files)
        if record: (self.installed / RECORD_NAME).write_bytes(self.record)

    def verify(self, digest=None):
        return verify_first_install(self.local, HEAD, '0.1.0', self.digest, self.record_hash if digest is None else digest)

    def test_deterministic_record_in_build_receipt_and_last_extraction(self):
        before = snapshot(self.payload); script = self.generate().read_text()
        self.assertEqual(snapshot(self.payload), before)
        self.assertEqual((self.build / RECORD_NAME).read_bytes(), self.record)
        receipt = json.loads((self.build / 'build-input.json').read_text())
        self.assertEqual(receipt['installRecordSha256'], self.record_hash)
        self.assertEqual(receipt['installRecordBytes'], len(self.record))
        self.assertEqual(receipt['installRecord'], RECORD_NAME)
        last = script.rindex('  File ')
        self.assertIn(RECORD_NAME, script[last:script.index('\n', last)])
        self.assertLess(last, script.index('MoveFileExW'))
        for forbidden in ['Delete ', 'RMDir', 'WriteReg', 'ExecWait', 'WriteUninstaller']:
            self.assertNotIn(forbidden, script)
        self.assertFalse(json.loads(self.record)['deletionAuthorized'])

    def test_record_namespace_file_directory_and_case_alias_rejected_before_write(self):
        for index, name in enumerate((RECORD_NAME, RECORD_NAME.upper(), RECORD_NAME + '/unexpected')):
            files = package(mutation=lambda f, m: f.update({name: b'foreign'}))
            payload = self.root / ('fixture-' + str(index))
            make_directory(payload, files)
            digest = hashlib.sha256(files['build-manifest.json']).hexdigest()
            with self.assertRaisesRegex(ValueError, 'reserved install record'):
                prepare(payload, payload / 'build-manifest.json', self.build, HEAD, '0.1.0', digest)
            self.assertFalse(self.build.exists())

    def test_old_receipt_compatible_but_new_record_requires_explicit_pin(self):
        self.install_fixture(False)
        old = verify_first_install(self.local, HEAD, '0.1.0', self.digest)
        self.assertNotIn('installRecordSha256', old)
        with self.assertRaisesRegex(ValueError, 'record missing'): self.verify()
        (self.installed / RECORD_NAME).write_bytes(self.record)
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            verify_first_install(self.local, HEAD, '0.1.0', self.digest)
        before = snapshot(self.local); result = self.verify()
        self.assertEqual(snapshot(self.local), before)
        self.assertEqual(result['filesIncludingManifest'], len(self.files) + 1)
        self.assertEqual(result['totalInstalledBytes'], sum(map(len, self.files.values())) + len(self.record))
        self.assertFalse(result['deletionAuthorized'])

    def test_wrong_record_tamper_and_additional_files_never_accepted(self):
        self.install_fixture()
        with self.assertRaisesRegex(ValueError, 'does not match contract'): self.verify('0' * 64)
        (self.installed / RECORD_NAME).write_bytes(record_bytes('b' * 40, '0.1.0', self.digest))
        with self.assertRaisesRegex(ValueError, 'digest mismatch'): self.verify()
        (self.installed / RECORD_NAME).write_bytes(self.record)
        (self.installed / 'foreign').write_bytes(b'not managed')
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'): self.verify()
        (self.installed / 'foreign').unlink()
        (self.installed / 'LocalAPI.exe').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'): self.verify()

    def test_record_does_not_hide_pending_or_empty_foreign_directory(self):
        self.install_fixture()
        pending = self.local / (APP_DIR + '.pending'); pending.mkdir()
        with self.assertRaisesRegex(ValueError, 'Pending'): self.verify()
        pending.rmdir(); (self.installed / 'extra-empty').mkdir()
        with self.assertRaisesRegex(ValueError, 'Unexpected installed directory'): self.verify()

    def test_record_identity_changes_are_bound(self):
        self.assertEqual(record_digest(HEAD, '0.1.0', self.digest), self.record_hash)
        for args in [('b' * 40, '0.1.0', self.digest), (HEAD, '0.1.1', self.digest), (HEAD, '0.1.0', 'f' * 64)]:
            self.assertNotEqual(record_digest(*args), self.record_hash)
