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
            self.assertEqual(script.count('StrCpy $INSTDIR $PendingTarget'), 2)
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

    def test_pending_promotion_guard_order_and_no_replace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); payload = root / 'payload'
            make_directory(payload, package()); manifest = payload / 'build-manifest.json'
            script = prepare(payload, manifest, root / 'build', HEAD, '0.1.0', hashlib.sha256(manifest.read_bytes()).hexdigest()).read_text()
            section = script.split('Section "First install only', 1)[1]
            reserve = section.index('CreateDirectoryW')
            self.assertLess(section.index('Call CheckAncestors'), reserve)
            self.assertEqual(section[:reserve].count('Call RequireMissing'), 2)
            self.assertIn('StrCpy $2 $PendingTarget', section[:reserve])
            last_file = section.rindex('  File ')
            promotion = section.index('MoveFileExW(w r2, w r3, i 0)')
            between = section[last_file:promotion]
            for guard in ['SetCurrentDirectoryW(w r2) i .r0', 'Call CheckAncestors', 'Call RequireMissing',
                          'StrCpy $2 $PendingTarget', 'GetFileAttributesW', '& 0x400', '& 0x10', 'StrCpy $3 $FixedTarget']:
                self.assertIn(guard, between)
            self.assertLess(promotion, section.index('Payload copy and no-replace publication completed'))
            self.assertIn('IntCmp $0 0 failed', section[promotion:])
            self.assertIn('GetFileAttributesW(w r2) i .r0 ?e', script)
            self.assertIn('IntCmp $1 2 missing_ok missing_refused missing_refused', script)
            self.assertNotIn('StrCpy $INSTDIR $FixedTarget', script)
            self.assertNotIn('SetOverwrite on', script)
            self.assertNotIn('SetOutPath "$LOCALAPPDATA"', script)
            self.assertEqual(script.count('  SetOutPath '), script.count('  File '))
            self.assertTrue(all(line.startswith('  SetOutPath "$INSTDIR') for line in script.splitlines() if 'SetOutPath ' in line))
            self.assertLess(between.index('Call CheckAncestors'), between.index('SetCurrentDirectoryW'))
            self.assertIn('IntCmp $0 0 failed', between[between.index('SetCurrentDirectoryW'):])
