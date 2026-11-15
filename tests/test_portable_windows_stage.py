import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from stage_windows_payload import stage_windows_payload
from test_portable_download import fixture, make_directory, HEAD


def package(version='0.1.0', head=HEAD, mutation=None):
    files = fixture('win32')
    app = {'name': 'local-api-workbench', 'version': version, 'type': 'module', 'main': 'desktop/main.mjs'}
    manifest = json.loads(files.pop('build-manifest.json'))
    manifest.update(product='Local API Workbench', version=version, head=head)
    files['resources/app/package.json'] = json.dumps(app).encode()
    if mutation:
        mutation(files, manifest)
    manifest['files'] = [{'path': name, 'sha256': hashlib.sha256(value).hexdigest()} for name, value in sorted(files.items())]
    files['build-manifest.json'] = json.dumps(manifest).encode()
    return files


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


class WindowsPayloadStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'download'
        self.target = self.root / 'stage'

    def tearDown(self):
        self.temp.cleanup()

    def test_two_versions_stage_without_touching_previous_or_external_data(self):
        make_directory(self.source / 'LocalAPI', package())
        data = self.root / 'trial-user-data'
        data.mkdir(); (data / 'project.json').write_text('{"synthetic":"preserve"}')
        before_source, before_data = snapshot(self.source), snapshot(data)
        result = stage_windows_payload(self.source, self.target, HEAD, '0.1.0', 'x64')
        old = snapshot(self.target)
        next_source = self.root / 'download-next'
        make_directory(next_source / 'LocalAPI', package('0.1.1', 'b' * 40))
        stage_windows_payload(next_source, self.root / 'stage-next', 'b' * 40, '0.1.1', 'x64')
        self.assertEqual(snapshot(self.source), before_source)
        self.assertEqual(snapshot(self.target), old)
        self.assertEqual(snapshot(data), before_data)
        self.assertEqual(result['applicationName'], 'local-api-workbench')
        self.assertFalse(result['installationPerformed']); self.assertFalse(result['signatureVerified'])

    def test_valid_large_manifest_keeps_existing_verifier_limit(self):
        files = package(mutation=lambda f,m: f.update({f'resources/app/extra/fixture-{i:04d}.txt':b'bounded fixture' for i in range(800)}))
        self.assertGreater(len(files['build-manifest.json']),65536)
        make_directory(self.source / 'LocalAPI',files)
        stage_windows_payload(self.source,self.target,HEAD,'0.1.0','x64')
        self.assertEqual(snapshot(self.source / 'LocalAPI'),snapshot(self.target))

    def test_entrypoint_namespace_and_manifest_consistency(self):
        for i, (key, value) in enumerate([('name','local-api-desktop'),('main','other.mjs'),('type','commonjs'),('productName','DifferentName'),('version','0.2.0')]):
            def change(files, manifest):
                app=json.loads(files['resources/app/package.json']);app[key]=value
                files['resources/app/package.json']=json.dumps(app).encode()
            source,target=self.root / f'identity-{i}',self.root / f'identity-out-{i}'
            make_directory(source / 'LocalAPI',package(mutation=change))
            with self.assertRaises(ValueError):stage_windows_payload(source,target,HEAD,'0.1.0','x64')
            self.assertFalse(target.exists())

    def test_case_alias_output_overlap_rejected_before_write(self):
        make_directory(self.source / 'LocalAPI',package())
        target=self.root / 'DOWNLOAD' / 'stage'
        before = snapshot(self.source)
        # Native Windows resolves the case alias into the first disjoint guard;
        # case-sensitive hosts reach the explicit Windows alias guard instead.
        with self.assertRaisesRegex(ValueError, r'^(Staging source and destination must be disjoint|Windows case-insensitive source/output overlap)$'):
            stage_windows_payload(self.source,target,HEAD,'0.1.0','x64')
        self.assertFalse(target.exists())
        self.assertEqual(snapshot(self.source), before)

    def test_wrong_metadata_rejected_before_destination(self):
        mutations = [
            lambda f, m: m.update(version='other'),
            lambda f, m: m.update(product='Other'),
            lambda f, m: f.update({'resources/app/package.json': b'{"name":"local-api-desktop"}'}),
            lambda f, m: f.update({'resources/app/package.json': b'x' * 65537}),
            lambda f, m: f.update({'resources/app/package.json': b'{"name":"a","name":"b"}'}),
        ]
        for i, mutate in enumerate(mutations):
            source, target = self.root / f'source-{i}', self.root / f'target-{i}'
            make_directory(source / 'LocalAPI', package(mutation=mutate))
            before = snapshot(source)
            with self.assertRaises((ValueError, json.JSONDecodeError)):
                stage_windows_payload(source, target, HEAD, '0.1.0', 'x64')
            self.assertFalse(target.exists()); self.assertEqual(snapshot(source), before)

    def test_windows_names_fail_before_output(self):
        # On Windows these names may not be creatable; pure Linux/macOS fixture
        # proves cross-platform staging does not accidentally admit them.
        if sys.platform == 'win32':
            self.skipTest('host filesystem rejects these fixtures before staging')
        for i, name in enumerate(['file:stream', 'CON.txt', 'CON .txt', 'aux', 'LPT¹.txt', 'trailing.', 'bad?', 'LOCALAPI.exe']):
            source, target = self.root / f'unsafe-{i}', self.root / f'out-{i}'
            make_directory(source / 'LocalAPI', package(mutation=lambda f,m: f.update({name:b'fixture'})))
            with self.assertRaises(ValueError): stage_windows_payload(source, target, HEAD, '0.1.0', 'x64')
            self.assertFalse(target.exists())

    def test_source_overlap_existing_output_and_wrong_arch_rejected(self):
        make_directory(self.source / 'LocalAPI', package())
        before = snapshot(self.source)
        for target in [self.source, self.source / 'nested-output']:
            with self.assertRaises(ValueError): stage_windows_payload(self.source,target,HEAD,'0.1.0','x64')
        with self.assertRaises(ValueError): stage_windows_payload(self.source,self.target,HEAD,'0.1.0','arm64')
        self.assertFalse(self.target.exists())
        self.target.mkdir(); (self.target / 'keep').write_bytes(b'old payload')
        with self.assertRaises(ValueError): stage_windows_payload(self.source,self.target,HEAD,'0.1.0','x64')
        self.assertEqual(snapshot(self.target), {'keep':b'old payload'})
        self.assertEqual(snapshot(self.source), before)

    def test_destination_ancestor_of_source_rejected(self):
        make_directory(self.source / 'LocalAPI',package())
        before=snapshot(self.source)
        with self.assertRaisesRegex(ValueError,'disjoint'):
            stage_windows_payload(self.source,self.root,HEAD,'0.1.0','x64')
        self.assertEqual(snapshot(self.source),before)

    @unittest.skipIf(sys.platform == 'win32', 'symlink creation requires separate Windows permission coverage')
    def test_destination_symlink_ancestor_rejected(self):
        make_directory(self.source / 'LocalAPI',package())
        real=self.root / 'real-parent';real.mkdir()
        link=self.root / 'linked-parent';link.symlink_to(real,target_is_directory=True)
        with self.assertRaises(ValueError):
            stage_windows_payload(self.source,link / 'new',HEAD,'0.1.0','x64')
        self.assertEqual(list(real.iterdir()),[])
