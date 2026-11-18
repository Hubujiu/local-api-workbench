import json
import os
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch
import test_portable_installed_product_journey as base
from test_portable_installed_product_journey import digest
from prepare_product_rollback_fixture import add_to_bundle, create_fault
from prepare_windows_lifecycle_msi import export_table


@unittest.skipUnless(os.environ.get('LOCALAPI_MSI_TOOLS'), 'Verified authoring toolchain required')
class ProductRollbackTests(unittest.TestCase):
    setUp = base.InstalledProductBundleTests.setUp
    build = base.InstalledProductBundleTests.build
    invoke = base.InstalledProductBundleTests.invoke
    def test_explicit_clone_preserves_default_msi_and_payload(self):
        old, new = self.build('old', '0.1.0', real_compile=True), self.build('new', '0.1.1', real_compile=True)
        bundled = self.invoke(old, new)
        root = Path(bundled['plan']).parent
        before = digest(new/'LocalAPI-lifecycle-UNSIGNED.msi')
        pin = add_to_bundle(root, new, before, digest(new/'build-input.json'), os.environ['LOCALAPI_MSI_TOOLS'])
        self.assertEqual(pin, digest(root/'product-plan.json'))
        self.assertEqual(before, digest(new/'LocalAPI-lifecycle-UNSIGNED.msi'))
        self.assertEqual(before, digest(root/'new/LocalAPI-lifecycle-UNSIGNED.msi'))
        plan = json.loads((root/'product-plan.json').read_text())
        fault = root/plan['rollbackFixture']['msi']['file']
        self.assertNotEqual(before, digest(fault))
        evidence = json.loads((root/plan['rollbackFixture']['receipt']['file']).read_text())
        self.assertTrue(evidence['payloadUnchanged']); self.assertTrue(evidence['allOtherTablesUnchanged'])
        self.assertFalse(evidence['nativeRollbackVerified'])
        self.assertNotEqual(evidence['faultPackageCode'], evidence['originalPackageCode'])
        tools = Path(os.environ['LOCALAPI_MSI_TOOLS'])
        self.assertEqual(export_table(tools/'msiinfo', new/'LocalAPI-lifecycle-UNSIGNED.msi', 'CustomAction')[1], [])
        self.assertEqual(export_table(tools/'msiinfo', fault, 'CustomAction')[1][0][:2], ['ProductRollbackProbe','19'])
        helper = (Path(__file__).resolve().parent/'helpers/installed-product-contract.mjs').as_uri()
        command = ['node','--input-type=module','-e', 'const {loadProductPlan}=await import(process.argv[1]); const p=await loadProductPlan(process.argv[2],process.argv[3]); if(!p.rollbackFixture) throw Error("Missing fault");', helper, str(root/'product-plan.json'), pin]
        subprocess.run(command,check=True,capture_output=True)
        with fault.open('ab') as stream: stream.write(b'UNEXPECTED FAULT MUTATION')
        failed = subprocess.run(command,capture_output=True,text=True)
        self.assertNotEqual(failed.returncode,0)
        self.assertIn('Fault artifact digest mismatch',failed.stderr)
        with self.assertRaisesRegex(ValueError,'Bundle must pin'):
            add_to_bundle(root,new,before,digest(new/'build-input.json'),tools)

    def test_mutated_normal_package_refused_before_fault_output(self):
        new = self.build('new', '0.1.1', real_compile=True)
        pin = digest(new/'LocalAPI-lifecycle-UNSIGNED.msi')
        with (new/'LocalAPI-lifecycle-UNSIGNED.msi').open('ab') as file: file.write(b'UNEXPECTED NORMAL ARTIFACT MUTATION')
        with self.assertRaisesRegex(ValueError,'Independent MSI digest mismatch'):
            create_fault(new,pin,digest(new/'build-input.json'),self.root/'fault',os.environ['LOCALAPI_MSI_TOOLS'])
        self.assertFalse((self.root/'fault').exists())

    def test_unexpected_mutation_in_fault_clone_rejected(self):
        new = self.build('new', '0.1.1', real_compile=True)
        import prepare_product_rollback_fixture as module
        original = module.import_table
        def tamper(tool, msi, target, headers, rows):
            if target.name == 'CustomAction.idt': rows[0][1] = '51'
            return original(tool,msi,target,headers,rows)
        # Mutate only on-disk import, leaving expected comparison untouched.
        def tamper_copy(tool, msi, target, headers, rows):
            return tamper(tool,msi,target,headers,[row[:] for row in rows])
        with patch.object(module,'import_table',side_effect=tamper_copy), self.assertRaisesRegex(ValueError,'Unexpected fault table mutation'):
            create_fault(new,digest(new/'LocalAPI-lifecycle-UNSIGNED.msi'),digest(new/'build-input.json'),self.root/'fault',os.environ['LOCALAPI_MSI_TOOLS'])

    def test_changed_payload_stream_refused(self):
        new = self.build('new', '0.1.1', real_compile=True)
        import prepare_product_rollback_fixture as module
        original = module.import_table
        def mutate_stream(tool, msi, target, headers, rows):
            original(tool,msi,target,headers,rows)
            if target.name == 'InstallExecuteSequence.idt':
                changed = target.parent/'changed.cab'; changed.write_bytes(b'not the original product payload')
                subprocess.run([str(tool),str(msi),'-a','payload.cab',str(changed)],check=True,capture_output=True)
        with patch.object(module,'import_table',side_effect=mutate_stream), self.assertRaisesRegex(ValueError,'Fault changed payload stream'):
            create_fault(new,digest(new/'LocalAPI-lifecycle-UNSIGNED.msi'),digest(new/'build-input.json'),self.root/'fault',os.environ['LOCALAPI_MSI_TOOLS'])
