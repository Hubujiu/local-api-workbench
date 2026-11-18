"""Bundler trust/shape tests use synthetic PE bytes, never execute a product."""
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from test_portable_download import HEAD, make_directory
from test_portable_windows_stage import package
from prepare_windows_lifecycle_msi import prepare as author, compile_msi
from prepare_installed_product_journey import prepare, require_x64_pe

FAMILY = '7428840e-d0d2-441d-8e92-b80dc2e779e4'


def pe_stub():
    data = bytearray(256); data[:2] = b'MZ'; struct.pack_into('<I', data, 60, 64)
    data[64:68] = b'PE\0\0'; struct.pack_into('<H', data, 68, 0x8664)
    struct.pack_into('<H', data, 86, 2); struct.pack_into('<H', data, 88, 0x20b)
    return bytes(data)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class InstalledProductBundleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()

    def build(self, label, version, family=FAMILY, *, text=False, real_compile=False):
        source = self.root / (label + '-payload'); build = self.root / label
        files = package(version, mutation=lambda f, m: f.update({'LocalAPI.exe': b'inert text' if text else pe_stub()}))
        make_directory(source, files)
        receipt = author(source, build, HEAD, version, hashlib.sha256(files['build-manifest.json']).hexdigest(), family)
        if real_compile:
            compile_msi(build, os.environ['LOCALAPI_MSI_TOOLS'])
        else:
            # Deliberately fake package/evidence. Tests mock table validation only to
            # isolate receipt/input pin checks; this is not MSI acceptance evidence.
            (build / 'LocalAPI-lifecycle-UNSIGNED.msi').write_bytes(b'FAKE MSI FOR PIN CONTRACT TEST')
            (build / 'compiled-evidence.json').write_text(json.dumps({'msiSha256': digest(build / 'LocalAPI-lifecycle-UNSIGNED.msi'), 'tables': {}}))
            make_directory(build / 'extracted' / receipt['directory'], files)
        return build

    def invoke(self, old, new, output=None, **changes):
        values = dict(old=old, new=new, old_digest=digest(old / 'LocalAPI-lifecycle-UNSIGNED.msi'),
                      new_digest=digest(new / 'LocalAPI-lifecycle-UNSIGNED.msi'), output=output or self.root / 'bundle',
                      old_receipt_digest=digest(old / 'build-input.json'), new_receipt_digest=digest(new / 'build-input.json'))
        values.update(changes)
        return prepare(**values)

    def test_pinned_bundle_has_exact_copies_and_no_native_acceptance(self):
        old, new = self.build('old', '0.1.0'), self.build('new', '0.2.0')
        with patch('prepare_installed_product_journey.validate') as validate:
            result = self.invoke(old, new)
        self.assertEqual(validate.call_count, 2)
        self.assertFalse(result['nativeProductVerified'])
        plan_path = Path(result['plan']); self.assertEqual(digest(plan_path), result['planSha256'])
        plan = json.loads(plan_path.read_text())
        for item in plan['packages']:
            for key in ['msi', 'receipt']:
                self.assertEqual(digest(plan_path.parent / item[key]['file']), item[key]['sha256'])
        self.assertEqual((plan_path.parent / 'old/build-input.json').read_bytes(), (old / 'build-input.json').read_bytes())

    def test_external_receipt_pin_cannot_be_replaced_by_self_reported_metadata(self):
        old, new = self.build('old', '0.1.0'), self.build('new', '0.2.0')
        original = digest(old / 'build-input.json')
        (old / 'build-input.json').write_text((old / 'build-input.json').read_text() + ' ')
        with patch('prepare_installed_product_journey.validate'), self.assertRaisesRegex(ValueError, 'receipt digest'):
            self.invoke(old, new, old_receipt_digest=original)
        self.assertFalse((self.root / 'bundle').exists())

    def test_package_pin_and_hash_format_fail_before_output(self):
        old, new = self.build('old', '0.1.0'), self.build('new', '0.2.0')
        for changes in [{'old_digest': '0' * 64}, {'new_digest': '../other'}, {'old_receipt_digest': '0' * 64}]:
            with patch('prepare_installed_product_journey.validate'), self.assertRaises(ValueError):
                self.invoke(old, new, **changes)
            self.assertFalse((self.root / 'bundle').exists())

    def test_inert_text_and_modified_extracted_payload_refused(self):
        old, new = self.build('old', '0.1.0', text=True), self.build('new', '0.2.0')
        with patch('prepare_installed_product_journey.validate'), self.assertRaisesRegex(ValueError, 'PE launcher'):
            self.invoke(old, new)
        old = self.build('pe-old', '0.1.0')
        receipt = json.loads((old / 'build-input.json').read_text())
        (old / 'extracted' / receipt['directory'] / 'LocalAPI.exe').write_bytes(b'changed')
        with patch('prepare_installed_product_journey.validate'), self.assertRaisesRegex(ValueError, 'Extracted payload'):
            self.invoke(old, new)
        self.assertFalse((self.root / 'bundle').exists())

    def test_version_and_family_separation(self):
        old = self.build('old', '0.2.0')
        downgrade = self.build('lower', '0.1.0')
        other = self.build('other', '0.3.0', '11111111-1111-4111-8111-111111111111')
        production = self.build('production', '0.3.0', None)
        for new, error in [(downgrade, 'higher'), (other, 'One isolated'), (production, 'UUIDv4')]:
            with patch('prepare_installed_product_journey.validate'), self.assertRaisesRegex(ValueError, error):
                self.invoke(old, new)
            self.assertFalse((self.root / 'bundle').exists())

    def test_source_symlink_and_overlapping_output_refused(self):
        old, new = self.build('old', '0.1.0'), self.build('new', '0.2.0')
        alias = self.root / 'alias'
        try: alias.symlink_to(old, target_is_directory=True)
        except (OSError, NotImplementedError):
            # Windows CI may not allow symlink creation without Developer Mode.
            alias = None
        if alias:
            with self.assertRaisesRegex(ValueError, 'Aliased'):
                self.invoke(alias, new)
        with self.assertRaisesRegex(ValueError, 'Disjoint'):
            self.invoke(old, new, output=old / 'bundle')

    def test_pe_shape_rejects_wrong_machine_and_invalid_offsets(self):
        exe = self.root / 'file.exe'; exe.write_bytes(pe_stub()); require_x64_pe(exe)
        for position, value, fmt in [(68, 0x14c, '<H'), (60, 0xffffffff, '<I'), (88, 0x10b, '<H')]:
            data = bytearray(pe_stub()); struct.pack_into(fmt, data, position, value); exe.write_bytes(data)
            with self.assertRaises(ValueError): require_x64_pe(exe)

    @unittest.skipUnless(os.environ.get('LOCALAPI_MSI_TOOLS'), 'Verified Linux authoring toolchain not configured')
    def test_actual_compiled_package_binding_without_any_execution(self):
        old = self.build('old', '0.1.0', real_compile=True)
        new = self.build('new', '0.2.0', real_compile=True)
        result = self.invoke(old, new)
        self.assertFalse(result['nativeProductVerified'])
        # Source binaries are synthetic PE-shaped bytes, not a runnable Electron app.
        self.assertTrue(Path(result['plan']).is_file())
