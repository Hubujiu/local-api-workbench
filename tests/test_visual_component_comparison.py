import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image

spec = importlib.util.spec_from_file_location('components', Path(__file__).parents[1] / 'scripts/compare-visual-components.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComponentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for file in ('a.png', 'b.png'):
            Image.new('RGBA', (8, 6), 'white').save(self.root / file)
        state = dict(page='http', theme='light', fixtureDigest='a'*64, viewport=[8,6], deviceScaleFactor=1,
                     locale='zh-CN', zoom=1, scroll=[0,0], selection='body', responseState='empty')
        def capture(file, product):
            return dict(file=file, product=product, version='synthetic', capturedAt='test', inspected=True,
                        sha256=module.strict.digest(self.root/file), state=copy.deepcopy(state))
        self.component = dict(id='body', region=[1,1,7,5], reference=capture('a.png','reference'), workbench=capture('b.png','workbench'))
        self.data = dict(version=1, components=[self.component])

    def run_report(self):
        (self.root/'manifest.json').write_text(json.dumps(self.data))
        return module.build_report(self.root/'manifest.json', self.root/'result')

    def test_exact_component_immutable_sources_and_no_overwrite(self):
        before = [(self.root/f).read_bytes() for f in ('a.png','b.png')]
        report = self.run_report()
        self.assertEqual(report['status'], 'exact')
        self.assertEqual(report['comparison']['pairs'][0]['comparedPixels'],24)
        self.assertIn('never whole-screen',report['scope'])
        self.assertEqual(before,[(self.root/f).read_bytes() for f in ('a.png','b.png')])
        with self.assertRaises(FileExistsError): self.run_report()

    def test_one_pixel_change_inside_region_is_different(self):
        with Image.open(self.root/'b.png') as im:
            im.putpixel((2,2),(254,255,255,255)); im.save(self.root/'b.png')
        self.component['workbench']['sha256']=module.strict.digest(self.root/'b.png')
        self.assertEqual(self.run_report()['status'],'different')

    def test_outside_difference_never_claims_whole_screen(self):
        with Image.open(self.root/'b.png') as im:
            im.putpixel((0,0),(0,0,0,255)); im.save(self.root/'b.png')
        self.component['workbench']['sha256']=module.strict.digest(self.root/'b.png')
        report=self.run_report();self.assertEqual(report['status'],'exact');self.assertIn('Only explicitly listed',report['scope'])

    def test_missing_pair_blocks(self):
        self.component['reference']=None
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_mismatched_fixture_not_salvaged_by_identical_crop(self):
        self.component['workbench']['state']['fixtureDigest']='b'*64
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_different_viewports_block(self):
        self.component['workbench']['state']['viewport']=[9,6]
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_false_same_viewport_dimensions_block(self):
        Image.new('RGBA',(9,6),'white').save(self.root/'b.png')
        self.component['workbench']['sha256']=module.strict.digest(self.root/'b.png')
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_missing_or_changed_digest_blocks(self):
        self.component['workbench']['sha256']='0'*64
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_missing_digest_blocks(self):
        self.component['reference'].pop('sha256')
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_region_cannot_be_shifted_with_hidden_content_crop(self):
        self.component['reference']['contentCrop']=[1,1,7,5]
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_nonoverlapping_regions_cannot_be_aligned(self):
        self.component['workbench']['sourceViewportCrop']=[1,0,9,6]
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_uninspected_blocks(self):
        self.component['reference']['inspected']=False
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_explicit_already_cropped_privacy_region(self):
        for entry in (self.component['reference'],self.component['workbench']):
            entry['state']['viewport']=[8,8];entry['sourceViewportCrop']=[0,0,8,6]
        self.assertEqual(self.run_report()['status'],'exact')

    def test_missing_required_component_blocks_aggregate(self):
        self.data['components'].append(dict(id='headers',region=[0,0,1,1]))
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_out_of_bounds_region_blocked(self):
        self.component['region']=[0,0,9,7]
        self.assertEqual(self.run_report()['status'],'blocked')

    def test_duplicate_or_unsafe_component_id_rejected(self):
        self.data['components']*=2
        with self.assertRaises(ValueError): self.run_report()


if __name__=='__main__': unittest.main()
