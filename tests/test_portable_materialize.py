import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import materialize_portable_download as materializer
from test_portable_download import HEAD, fixture, make_directory, make_tar


class MaterializeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.download = self.root / 'download'
        self.download.mkdir()
        self.target = self.root / 'ready'

    def tearDown(self):
        self.temp.cleanup()

    def package(self, platform='linux', files=None, extra=()):
        files = fixture(platform) if files is None else files
        if platform == 'win32':
            make_directory(self.download / 'LocalAPI', files)
        else:
            label = {'linux': 'Linux', 'darwin': 'macOS'}[platform]
            make_tar(self.download / ('LocalAPI-' + label + '.tar.gz'), files, extra)
            make_directory(self.download / 'LocalAPI', {'build-manifest.json': files['build-manifest.json']})
        return files

    @unittest.skipIf(sys.platform == 'win32', 'Unix archive mode preservation runs on Linux/macOS')
    def test_unix_materialization_rechecks_exact_manifest_and_modes(self):
        files = self.package()
        result = materializer.materialize_download(self.download, self.target, 'linux', HEAD)
        self.assertEqual(result['head'], HEAD)
        self.assertEqual(result['root'], str(self.target))
        self.assertEqual((self.target / 'LocalAPI').stat().st_mode & 0o777, 0o755)
        for name, data in files.items():
            self.assertEqual((self.target / name).read_bytes(), data)

    @unittest.skipIf(sys.platform == 'win32', 'Unix archive mode preservation runs on Linux/macOS')
    def test_mac_layout(self):
        self.package('darwin')
        materializer.materialize_download(self.download, self.target, 'darwin', HEAD)
        self.assertTrue((self.target / 'LocalAPI.app/Contents/MacOS/Electron').is_file())

    def test_windows_copy_has_no_source_mutation(self):
        files = self.package('win32')
        materializer.materialize_download(self.download, self.target, 'win32', HEAD)
        for name, data in files.items():
            self.assertEqual((self.target / name).read_bytes(), data)
            self.assertEqual((self.download / 'LocalAPI' / name).read_bytes(), data)

    def test_existing_destination_never_overwritten(self):
        self.package('win32')
        self.target.mkdir()
        sentinel = self.target / 'keep'; sentinel.write_text('preserve')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            materializer.materialize_download(self.download, self.target, 'win32', HEAD)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_windows_source_growth_is_bounded(self):
        self.package('win32')
        original = materializer.inventory_directory
        def grow_after_inventory(path):
            result = original(path)
            (path / 'LocalAPI.exe').write_bytes(b'x' * (result.total + 1))
            return result
        with mock.patch.object(materializer, 'inventory_directory', side_effect=grow_after_inventory):
            with self.assertRaisesRegex(ValueError, 'Source byte limit changed'):
                materializer.materialize_download(self.download, self.target, 'win32', HEAD)

    def test_materialized_identity_checked_after_copy(self):
        self.package('win32')
        original = materializer.inventory_directory
        def corrupt_output_inventory(path):
            result = original(path)
            if path == self.target:
                result.manifest = b'{}'
            return result
        with mock.patch.object(materializer, 'inventory_directory', side_effect=corrupt_output_inventory):
            with self.assertRaisesRegex(ValueError, 'Materialized manifest changed'):
                materializer.materialize_download(self.download, self.target, 'win32', HEAD)

    def test_wrong_head_no_output(self):
        self.package()
        with self.assertRaisesRegex(ValueError, 'Wrong build head'):
            materializer.materialize_download(self.download, self.target, 'linux', 'b' * 40)
        self.assertFalse(self.target.exists())

    @unittest.skipIf(sys.platform == 'win32', 'Symlink creation requires Windows privileges')
    def test_destination_ancestor_link_rejected(self):
        self.package()
        alias = self.root / 'alias'; alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'plain directory'):
            materializer.materialize_download(self.download, alias / 'ready', 'linux', HEAD)
        self.assertFalse(self.target.exists())

    @unittest.skipIf(sys.platform == 'win32', 'Symlink creation requires Windows privileges')
    def test_safe_symlink_created_only_after_files(self):
        files = fixture()
        m = json.loads(files['build-manifest.json'])
        m['files'].append({'path': 'alias', 'sha256': hashlib.sha256(files['LocalAPI']).hexdigest()})
        m['files'].sort(key=lambda row: row['path'])
        m['links'] = [{'path': 'alias', 'target': 'LocalAPI', 'resolved': 'LocalAPI', 'resolvedType': 'file'}]
        files['build-manifest.json'] = json.dumps(m).encode()
        link = tarfile.TarInfo('LocalAPI/alias'); link.type = tarfile.SYMTYPE; link.linkname = 'LocalAPI'; link.mode = 0o777
        self.package(files=files, extra=[(link, None)])
        materializer.materialize_download(self.download, self.target, 'linux', HEAD)
        self.assertTrue((self.target / 'alias').is_symlink())
        self.assertEqual((self.target / 'alias').read_bytes(), files['LocalAPI'])

    def test_malicious_members_rejected_before_output(self):
        for name, kind, target in [('LocalAPI/../escape', tarfile.REGTYPE, ''),
                                   ('LocalAPI/escape', tarfile.SYMTYPE, '../../outside'),
                                   ('LocalAPI/device', tarfile.CHRTYPE, ''),
                                   ('LocalAPI/hard', tarfile.LNKTYPE, 'LocalAPI/LocalAPI')]:
            with self.subTest(name=name):
                item = tarfile.TarInfo(name); item.type = kind; item.linkname = target
                self.package(extra=[(item, b'' if kind == tarfile.REGTYPE else None)])
                with self.assertRaises(ValueError):
                    materializer.materialize_download(self.download, self.target, 'linux', HEAD)
                self.assertFalse(self.target.exists())
                self.assertFalse((self.root / 'outside').exists())

    @unittest.skipIf(sys.platform == 'win32', 'Unix archive mode preservation runs on Linux/macOS')
    def test_archive_change_between_validation_and_copy_fails_closed(self):
        files = self.package()
        original = materializer.inventory_archive
        def replace_after_inventory(path):
            result = original(path)
            changed = dict(files); changed['LocalAPI'] = b'wrong launcher'
            make_tar(path, changed)
            return result
        with mock.patch.object(materializer, 'inventory_archive', side_effect=replace_after_inventory):
            with self.assertRaisesRegex(ValueError, 'Source changed'):
                materializer.materialize_download(self.download, self.target, 'linux', HEAD)

    @unittest.skipIf(sys.platform == 'win32', 'Unix archive mode preservation runs on Linux/macOS')
    def test_no_special_permissions_restored(self):
        self.package()
        original = materializer.inventory_archive
        def special_mode(path):
            result = original(path); result.modes['LocalAPI'] |= 0o4000
            return result
        with mock.patch.object(materializer, 'inventory_archive', side_effect=special_mode):
            with self.assertRaisesRegex(ValueError, 'Special permission'):
                materializer.materialize_download(self.download, self.target, 'linux', HEAD)
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main()
