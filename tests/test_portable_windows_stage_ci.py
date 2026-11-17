"""CLI execution and bounded downloaded-lane wiring; not native PowerShell proof."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from test_portable_windows_stage import package, snapshot
from test_portable_download import make_directory, HEAD

ROOT = Path(__file__).resolve().parents[1]


class WindowsStageCIContractTests(unittest.TestCase):
    def test_actual_cli_success_and_fail_closed_without_source_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            # macOS temporary roots may use /var -> /private/var; use the
            # canonical trusted root, without relaxing destination link checks.
            root = Path(directory).resolve()
            source, target = root / 'download', root / 'launch'
            make_directory(source / 'LocalAPI', package())
            before = snapshot(source)
            command = [sys.executable, str(ROOT / 'scripts/stage_windows_payload.py'),
                       str(source), str(target), '--head', HEAD,
                       '--expected-version', '0.1.0', '--arch', 'x64']
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            evidence = json.loads(result.stdout)
            for key, value in {'kind': 'windows-payload-staging', 'head': HEAD,
                               'platform': 'win32', 'arch': 'x64', 'version': '0.1.0',
                               'applicationName': 'local-api-workbench',
                               'entrypoint': 'desktop/main.mjs',
                               'installationPerformed': False, 'signatureVerified': False}.items():
                self.assertEqual(evidence[key], value)
            self.assertEqual(snapshot(target), snapshot(source / 'LocalAPI'))
            self.assertEqual(snapshot(source), before)
            # A wrong independently expected identity fails before creating output.
            command[3] = str(root / 'wrong-version')
            command[7] = '0.2.0'
            failed = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(failed.stdout, '')
            self.assertFalse((root / 'wrong-version').exists())
            self.assertEqual(snapshot(source), before)

    def test_workflow_preserves_one_destination_and_platform_gates(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        lane = workflow.split('  downloaded-portable:', 1)[1]
        self.assertIn('timeout-minutes: 10', lane)
        materialize = lane.split('- name: Materialize only', 1)[1].split('      - ', 1)[0]
        self.assertIn("if: runner.os != 'Windows'", materialize)
        self.assertIn('scripts/materialize_portable_download.py', materialize)
        stage = lane.split('- name: Stage verified Windows payload', 1)[1].split('      - ', 1)[0]
        self.assertIn("if: runner.os == 'Windows'", stage)
        self.assertIn('shell: pwsh', stage)
        self.assertIn('EXPECTED_HEAD: ${{ github.event.pull_request.head.sha || github.sha }}', stage)
        self.assertIn('--head "$env:EXPECTED_HEAD" --expected-version 0.1.0 --arch x64', stage)
        self.assertIn('"${{ runner.temp }}/localapi-launch-package"', stage)
        self.assertEqual(lane.count('python scripts/stage_windows_payload.py'), 1)
        self.assertLess(stage.index('$LASTEXITCODE'), stage.index('ConvertFrom-Json'))
        self.assertLess(stage.index('Windows staging evidence mismatch'), stage.index('Write-Output'))
        for field in ['kind', 'head', 'platform', 'arch', 'version', 'applicationName', 'entrypoint', 'installationPerformed', 'signatureVerified']:
            self.assertIn('$stage.' + field, stage)
        for flag in ['installationPerformed', 'signatureVerified']:
            self.assertIn('$stage.' + flag + ' -isnot [bool]', stage)
        for marker in ['DOWNLOADED_PORTABLE_MATERIALIZED_PASS', 'WINDOWS_PAYLOAD_STAGED_PASS']:
            self.assertIn(marker, stage)
        self.assertEqual(lane.count('node tests/desktop-restart-journey.mjs --package-root "${{ runner.temp }}/localapi-launch-package"'), 4)
        self.assertEqual(lane.count('--crash'), 2)
        self.assertIn('python scripts/verify_portable_download.py', lane)
        self.assertIn('uses: actions/download-artifact@v4', lane)
        self.assertIn('if: always()', lane)
