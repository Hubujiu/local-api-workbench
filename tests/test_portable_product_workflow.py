import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import compile_hosted_product_pair

ROOT = Path(__file__).resolve().parents[1]


class ProductWorkflowTests(unittest.TestCase):
    def test_same_repo_explicit_opt_in_read_only_and_pinned_actions(self):
        source = (ROOT / '.github/workflows/windows-product-journey.yml').read_text()
        self.assertIn('run-windows-product-journey', source)
        self.assertIn('head.repo.full_name == github.repository', source)
        self.assertIn('workflow_dispatch:', source)
        for forbidden in ['pull_request_target', 'secrets.', 'contents: write', 'actions: write', 'self-hosted', 'npm publish', 'git push']:
            self.assertNotIn(forbidden, source)
        import re
        actions = re.findall(r'uses: ([^\s]+)', source)
        self.assertTrue(actions)
        for action in actions:
            self.assertRegex(action, r'^actions/[a-z-]+@[0-9a-f]{40}$')
        self.assertEqual(source.count('persist-credentials: false'), source.count('uses: actions/checkout@'))
        self.assertIn('native-standard-user:', source)
        self.assertEqual(source.count('GH_TOKEN:'), 0)
        self.assertNotIn('download_pinned_windows_baseline.py', source)
        self.assertIn('build-baseline:', source)
        self.assertIn('BASELINE_PROVENANCE_SHA:', source)
        self.assertIn('standardUserAcceptance=$false', source)
        self.assertIn('Candidate must be >=0.1.1', source)
        self.assertIn('NEW_VERSION: ${{ needs.build-product.outputs.version }}', source)
        self.assertIn("needs.author-pair.outputs.rollback_enabled == 'true' && 55 || 40", source)
        self.assertIn("'run-windows-product-rollback'", source)
        self.assertIn("$journeyArgs += '--exercise-product-rollback'", source)
        self.assertIn('PLAN_SHA: ${{ needs.author-pair.outputs.plan_sha }}', source)
        in_run = False
        for line in source.splitlines():
            if line.startswith('        run: |'):
                in_run = True; continue
            if line.strip() and not line.startswith('          '): in_run = False
            if in_run: self.assertNotIn('${{', line)

    def test_pair_compiler_uses_one_fresh_family_and_independent_job_pins(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve()
            env = {'RUNNER_TEMP': str(root), 'NEW_HEAD': 'a'*40, 'NEW_MANIFEST_SHA': 'b'*64, 'NEW_VERSION': '0.2.0', 'GITHUB_OUTPUT': str(root/'outputs')}
            lock = compile_hosted_product_pair.read_lock(ROOT/'packaging/windows-msi/windows-baseline-source-lock.json')
            receipt = dict(schemaVersion=1,kind='source-rebuild',repository=lock['repository'],sourceUrl=lock['sourceUrl'],head=lock['head'],version=lock['version'],nodeVersion=lock['nodeVersion'],sourceFiles=lock['files'],builderHead='a'*40,manifestSha256='d'*64,historicalArchiveReproduced=False)
            import hashlib
            data=json.dumps(receipt).encode()
            (root/'baseline-provenance').mkdir(); (root/'baseline-provenance/source-rebuild.json').write_bytes(data)
            (root/'product-bundle').mkdir()
            env.update(BASELINE_HEAD=lock['head'],BASELINE_VERSION=lock['version'],BASELINE_MANIFEST_SHA='d'*64,BASELINE_PROVENANCE_SHA=hashlib.sha256(data).hexdigest())
            def prepare(source, output, head, version, manifest, family):
                output.mkdir(); (output/'build-input.json').write_text('{}')
            def compile(output, tools):
                file = output/'LocalAPI-lifecycle-UNSIGNED.msi'; file.write_bytes(b'never executed'); return file
            with patch.dict(os.environ, env), patch.object(compile_hosted_product_pair, 'prepare', side_effect=prepare) as prepared, patch.object(compile_hosted_product_pair, 'compile_msi', side_effect=compile), patch.object(compile_hosted_product_pair, 'bundle', return_value={'planSha256':'c'*64}) as bundled:
                compile_hosted_product_pair.main()
            old, new = [c.args for c in prepared.call_args_list]
            self.assertEqual(old[3], '0.1.0'); self.assertEqual(new[3], '0.2.0')
            self.assertEqual(old[4], 'd'*64)
            self.assertNotEqual(old[4], json.loads((ROOT/'packaging/windows-msi/windows-baseline-lock.json').read_text())['manifestSha256'])
            self.assertEqual((root/'product-bundle/source-rebuild.json').read_bytes(), data)
            self.assertEqual(new[2], 'a'*40); self.assertEqual(new[4], 'b'*64)
            self.assertEqual(old[5], new[5]); self.assertEqual(len(old[5]), 36)
            self.assertIn('old_receipt_digest', bundled.call_args.kwargs)
            self.assertIn('plan_sha='+'c'*64, (root/'outputs').read_text())
