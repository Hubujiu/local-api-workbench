import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/windows-release.yml'


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('jq') and shutil.which('bash'),
                     'Tests the Bash and jq release commands on Linux')
class ReleaseDraftTests(unittest.TestCase):
    def test_checked_receipt_draft_retry_and_mismatch(self):
        # Execute the actual workflow command block. Only the remote GitHub API is simulated.
        draft = WORKFLOW.read_text().split('\n  draft:\n', 1)[1]
        script = textwrap.dedent(draft.rsplit('        run: |\n', 1)[1])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            media, acceptance = root / 'media', root / 'acceptance'
            media.mkdir()
            acceptance.mkdir()
            installer = media / 'LocalAPI-0.1.1-windows-x64.msi'
            installer.write_bytes(b'fictional signed package for the draft command')
            head = 'a' * 40
            digest = hashlib.sha256(installer.read_bytes()).hexdigest()
            receipt = dict(head=head, sha256=digest, standardUser=True, manifestSha256='b' * 64,
                           projectFilesPreserved=True, registrationVerified=True, publisher='A'*40,
                           previousReleaseUpgraded=False, previousReleaseEvidence=None)
            receipt.update(schema='localapi-signed-windows-release-acceptance-v2', signedLifecyclePassed=True,
                           qualification=dict(schema='localapi-windows-standard-user-qualification-v1',
                             preflightPassed=True,windows11Client=True,nativeX64=True,uacEnabled=True,
                             genuineNonAdministrator=True,interactiveToken=True,installerPolicyObserved=True))
            (acceptance / 'release-acceptance.json').write_text(json.dumps(receipt))
            state = root / 'releases.json'
            state.write_text('[[]]')
            client = root / 'gh'
            client.write_text(textwrap.dedent('''\
                #!/usr/bin/env python3
                import hashlib, json, os, sys
                from pathlib import Path
                args = sys.argv[1:]
                state = Path(os.environ['STATE'])
                if args[0] == 'api':
                    if any('branches/main' in arg for arg in args): print(os.environ['GITHUB_SHA'])
                    elif any('matching-refs' in arg for arg in args): print('[]')
                    elif any('/releases?' in arg for arg in args): print(state.read_text())
                    else: sys.exit(2)
                elif args[:3] == ['release', 'create', 'v0.1.1']:
                    assert '--draft' in args and args[args.index('--target')+1] == os.environ['GITHUB_SHA']
                    assert json.loads(state.read_text()) == [[]]
                    assets = [dict(name=n, digest='sha256:'+hashlib.sha256(Path(n).read_bytes()).hexdigest()) for n in args[3:6]]
                    state.write_text(json.dumps([[dict(draft=True, tag_name=args[2], target_commitish=os.environ['GITHUB_SHA'], assets=assets)]]))
                else: sys.exit(2)
            '''))
            client.chmod(0o755)
            env = {**os.environ, 'PATH':temp+os.pathsep+os.environ['PATH'], 'STATE':str(state),
                   'GITHUB_SHA':head, 'GITHUB_REPOSITORY':'test/workbench', 'DIGEST':digest,
                   'MANIFEST':'b'*64, 'VERSION':'0.1.1', 'CI_RUN':'1', 'JOURNEY_RUN':'2',
                   'GITHUB_RUN_ID':'3', 'RUNNER_TEMP':temp}

            def run():
                return subprocess.run(['bash', '-c', script], cwd=root, env=env, capture_output=True, text=True)

            for _ in range(2):
                result = run()
                self.assertEqual(result.returncode, 0, result.stderr)
            verify = json.loads((media / 'verification.json').read_bytes())
            self.assertEqual(verify['head'], head)
            self.assertTrue(verify['projectFilesPreserved'])
            self.assertEqual(verify['releaseRun'], '3')
            changed = json.loads(state.read_text())
            changed[0][0]['assets'][0]['digest'] = 'sha256:' + '0'*64
            state.write_text(json.dumps(changed))
            self.assertNotEqual(run().returncode, 0)
            state.write_text('[[]]')
            receipt['registrationVerified'] = False
            (acceptance / 'release-acceptance.json').write_text(json.dumps(receipt))
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual(json.loads(state.read_text()), [[]])

            receipt['registrationVerified'] = True
            import copy
            for change in [lambda r:r.pop('schema'), lambda r:r.pop('qualification'),
                           lambda r:r.update(signedLifecyclePassed=False),
                           lambda r:r['qualification'].update(nativeX64=False),
                           lambda r:r['qualification'].update(windows11Client=False),
                           lambda r:r['qualification'].update(genuineNonAdministrator=False),
                           lambda r:r['qualification'].update(interactiveToken=False),
                           lambda r:r['qualification'].update(preflightPassed='true')]:
                bad = copy.deepcopy(receipt); change(bad)
                (acceptance / 'release-acceptance.json').write_text(json.dumps(bad))
                self.assertNotEqual(run().returncode, 0)
                self.assertEqual(json.loads(state.read_text()), [[]])

            predecessor=dict(version='0.1.0',head='d'*40,sha256='e'*64,receiptSha256='f'*64,publisher='B'*40,rotationAuthorized=True)
            receipt.update(previousReleaseUpgraded=True,previousReleaseEvidence=predecessor)
            (acceptance / 'release-acceptance.json').write_text(json.dumps(receipt))
            self.assertEqual(run().returncode,0)
            self.assertEqual(json.loads((media/'verification.json').read_text())['previousReleaseEvidence'],predecessor)
            state.write_text('[[]]')
            for change in [lambda r:r.update(previousReleaseUpgraded=False),
                           lambda r:r.update(previousReleaseEvidence=None),
                           lambda r:r['previousReleaseEvidence'].update(rotationAuthorized=False),
                           lambda r:r['previousReleaseEvidence'].update(receiptSha256=['f'*64]),
                           lambda r:r['previousReleaseEvidence'].update(version='0.1.1'),
                           lambda r:r['previousReleaseEvidence'].pop('head')]:
                bad=copy.deepcopy(receipt);change(bad)
                (acceptance/'release-acceptance.json').write_text(json.dumps(bad))
                self.assertNotEqual(run().returncode,0)
                self.assertEqual(json.loads(state.read_text()),[[]])
