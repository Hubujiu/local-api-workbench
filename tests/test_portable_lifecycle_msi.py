import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from test_portable_download import HEAD, make_directory
from test_portable_windows_stage import package
from prepare_windows_lifecycle_msi import NS, prepare, compile_msi, validate
from build_windows_lifecycle_fixture import build


class LifecycleMsiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self, version='0.1.0', sub='payload'):
        files = package(version); path = self.root / sub; make_directory(path, files)
        return path, hashlib.sha256(files['build-manifest.json']).hexdigest()

    def test_upgrade_identity_and_stable_components(self):
        first, digest = self.source()
        old = prepare(first, self.root / 'old', HEAD, '0.1.0', digest)
        newer, digest = self.source('0.2.0', 'new-payload')
        new = prepare(newer, self.root / 'new', HEAD, '0.2.0', digest)
        self.assertEqual(old['upgradeCode'], new['upgradeCode'])
        self.assertEqual(old['directory'], new['directory'])
        self.assertNotEqual(old['productCode'], new['productCode'])
        def components(folder):
            root = ET.parse(self.root / folder / 'candidate.wxs')
            return {n.attrib['Id']: n.attrib['Guid'] for n in root.findall('.//{' + NS + '}Component')}
        self.assertEqual(components('old'), components('new'))
        source = (self.root / 'new/candidate.wxs').read_text()
        self.assertIn('After="InstallInitialize"', source)
        self.assertIn('SAMEORNEWERPRODUCTS', source)
        self.assertNotIn('CustomAction', source)
        self.assertNotIn('RemoveFile', source)
        self.assertNotIn('LocalAPI-FirstInstall-Candidate', source)
        self.assertFalse(old['nativeLifecycleVerified'])

    def test_fixture_family_isolated_from_product_and_each_other(self):
        payload, digest = self.source()
        records = [prepare(payload, self.root / ('out' + str(i)), HEAD, '0.1.0', digest, f) for i, f in enumerate([None, '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])]
        for key in ['upgradeCode', 'productCode', 'directory']:
            self.assertEqual(len(set(r[key] for r in records)), 3)

    def test_bad_version_and_identity_before_output(self):
        payload, digest = self.source()
        for version in ['1.0', '01.0.0', '256.0.0', '1.0.65536', '1.0.0-beta']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                prepare(payload, self.root / 'out', HEAD, version, digest)
            self.assertFalse((self.root / 'out').exists())
        with self.assertRaisesRegex(ValueError, 'digest'):
            prepare(payload, self.root / 'out', HEAD, '0.1.0', '0' * 64)

    @unittest.skipUnless(os.environ.get('LOCALAPI_MSI_TOOLS'), 'Verified Linux MSI toolchain not configured')
    def test_real_compilation_upgrade_transaction_and_mutations(self):
        payload, digest = self.source()
        receipt = prepare(payload, self.root / 'build', HEAD, '0.1.0', digest)
        msi = compile_msi(self.root / 'build', os.environ['LOCALAPI_MSI_TOOLS'])
        evidence = json.loads((self.root / 'build/compiled-evidence.json').read_text())
        self.assertEqual(evidence['msiSha256'], hashlib.sha256(msi.read_bytes()).hexdigest())
        self.assertFalse(evidence['nativeLifecycleVerified'])
        tables = evidence['tables']
        mutations = [
            ('Upgrade', lambda rows: next(r for r in rows if r[-1] == 'OLDERPRODUCTS').__setitem__(4, '258')),
            ('Upgrade', lambda rows: rows[1].__setitem__(1, '99.0.0')),
            ('Component', lambda rows: rows[0].__setitem__(3, '256')),
            ('Registry', lambda rows: rows[0].__setitem__(1, '2')),
            ('Directory', lambda rows: rows[0].__setitem__(2, 'foreign')),
            ('DrLocator', lambda rows: rows[0].__setitem__(2, 'C:\\foreign')),
            ('File', lambda rows: rows[0].__setitem__(2, 'foreign.exe')),
            ('InstallExecuteSequence', lambda rows: next(r for r in rows if r[0] == 'RemoveExistingProducts').__setitem__(2, '1401')),
            ('InstallExecuteSequence', lambda rows: rows.append(['DisableRollback', '', '1402'])),
            ('LaunchCondition', lambda rows: rows.pop()),
        ]
        for table, mutate in mutations:
            changed = copy.deepcopy(tables); mutate(changed[table])
            with self.subTest(table=table), self.assertRaises(ValueError): validate(receipt, changed)

    @unittest.skipUnless(os.environ.get('LOCALAPI_MSI_TOOLS'), 'Verified Linux MSI toolchain not configured')
    def test_two_real_inert_packages_for_native_job(self):
        plan = build(self.root / 'fixture', os.environ['LOCALAPI_MSI_TOOLS'])
        self.assertFalse(plan['productAcceptance'])
        self.assertFalse(plan['nativeLifecycleVerified'])
        for item in plan['packages']:
            path = self.root / 'fixture' / item['package']
            self.assertLess(path.stat().st_size, 1024 * 1024)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item['sha256'])
            self.assertEqual(len(item['fileHashes']), 7)
        self.assertNotEqual(plan['packages'][0]['productCode'], plan['packages'][1]['productCode'])
