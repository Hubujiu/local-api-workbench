import sys
import hashlib
from pathlib import Path
import tempfile
import unittest
from test_portable_windows_stage import package, snapshot
from test_portable_download import make_directory, HEAD
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from prepare_windows_first_install import prepare

class FirstInstallTests(unittest.TestCase):
    def test_exact_payload_generation_no_execution_or_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); payload = root / 'payload'; output = root / 'build'
            make_directory(payload, package())
            before = snapshot(payload)
            script = prepare(payload, payload / 'build-manifest.json', output, HEAD, '0.1.0', hashlib.sha256((payload / 'build-manifest.json').read_bytes()).hexdigest()).read_text()
            self.assertEqual(snapshot(payload), before)
            self.assertFalse((output / 'LocalAPI-first-install-UNSIGNED.exe').exists())
            for required in ['CRCCheck force', 'RequestExecutionLevel user', 'IfSilent refuse',
                             'CreateDirectoryW', 'GetFileAttributesW', '& 0x400', 'Page components',
                             'ReadEnvStr $0 LOCAL_API_DESKTOP_DATA', 'GetDriveTypeW', 'SetOverwrite off',
                             'IfErrors failed', 'SetErrorLevel 4', 'SetErrorLevel 5']:
                self.assertIn(required, script)
            self.assertEqual(script.count('StrCpy $INSTDIR $FixedTarget'), 2)
            self.assertNotIn('Page directory', script)
            for forbidden in ['Exec ', 'ExecWait', 'RMDir', 'Delete ', 'WriteReg', 'WriteUninstaller']:
                self.assertNotIn(forbidden, script)
            self.assertEqual(script.count('  File "/oname='), len(before))
            self.assertEqual(script.count('  IfFileExists '), len(before))
            self.assertEqual(script.count('  IfErrors failed'), 2 * len(before))
            with self.assertRaises(ValueError):
                prepare(payload, payload / 'build-manifest.json', output, HEAD, '0.1.0', hashlib.sha256((payload / 'build-manifest.json').read_bytes()).hexdigest())

    def test_wrong_manifest_head_version_rejected_without_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); payload = root / 'payload'; output = root / 'build'
            make_directory(payload, package())
            for manifest, head, version in [(root / 'other.json', HEAD, '0.1.0'),
                (payload / 'build-manifest.json', 'b'*40, '0.1.0'),
                (payload / 'build-manifest.json', HEAD, '0.2.0')]:
                with self.assertRaises(ValueError): prepare(payload, manifest, output, head, version, hashlib.sha256((payload / 'build-manifest.json').read_bytes()).hexdigest())
                self.assertFalse(output.exists())

    def test_manifest_digest_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); payload = root / 'payload'; output = root / 'build'
            make_directory(payload, package())
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                prepare(payload, payload / 'build-manifest.json', output, HEAD, '0.1.0', '0'*64)
            self.assertFalse(output.exists())

    def test_literal_dollar_inst_dir_filename_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); payload = root / 'payload'
            make_directory(payload, package(mutation=lambda f,m: f.update({'resources/app/$INSTDIR/$INSTDIR.txt': b'literal'})))
            manifest = payload / 'build-manifest.json'
            with self.assertRaisesRegex(ValueError, 'Dollar-bearing payload paths unsupported'):
                prepare(payload, manifest, root / 'build', HEAD, '0.1.0', hashlib.sha256(manifest.read_bytes()).hexdigest())
            self.assertFalse((root / 'build').exists())
