"""Author an isolated MSI pair from independently pinned hosted-job inputs.

Run only inside the disposable Linux authoring job. Never executes product code.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from prepare_windows_lifecycle_msi import prepare, compile_msi
from prepare_installed_product_journey import prepare as bundle
from verify_portable_download import require
from attest_windows_baseline_source import read_lock, validate_receipt
from prepare_installed_product_journey import pinned_bytes

def candidate_version(value):
    require(isinstance(value, str) and re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value), "Canonical candidate MSI version required")
    parts = tuple(map(int, value.split(".")))
    require(parts >= (0, 1, 1) and parts[0] <= 255 and parts[1] <= 255 and parts[2] <= 65535, "Candidate must be >=0.1.1 within MSI bounds")
    return value



def main():
    root = Path(os.environ['RUNNER_TEMP'])
    require(root.is_absolute(), 'Absolute runner temp required')
    new_head, new_manifest = os.environ['NEW_HEAD'], os.environ['NEW_MANIFEST_SHA']
    require(re.fullmatch('[0-9a-f]{40}', new_head) and re.fullmatch('[0-9a-f]{64}', new_manifest), 'Independent job output pins required')
    version = candidate_version(os.environ['NEW_VERSION'])
    lock = read_lock('packaging/windows-msi/windows-baseline-source-lock.json')
    old_head, old_version, old_manifest = os.environ['BASELINE_HEAD'], os.environ['BASELINE_VERSION'], os.environ['BASELINE_MANIFEST_SHA']
    provenance_bytes = pinned_bytes(root / 'baseline-provenance/source-rebuild.json', os.environ['BASELINE_PROVENANCE_SHA'])
    provenance = json.loads(provenance_bytes)
    validate_receipt(provenance, lock, old_head, old_version, old_manifest, new_head)
    family = str(uuid.uuid4())
    tools = root / 'msitools/root/usr/bin'
    outputs = []
    for label, source, head, version, manifest in [
        ('old', root / 'baseline-portable', old_head, old_version, old_manifest),
        ('new', root / 'new-portable', new_head, version, new_manifest),
    ]:
        output = root / ('product-msi-' + label)
        prepare(source, output, head, version, manifest, family)
        msi = compile_msi(output, tools)
        outputs.append((output, hashlib.sha256(msi.read_bytes()).hexdigest(), hashlib.sha256((output / 'build-input.json').read_bytes()).hexdigest()))
    old, new = outputs
    result = bundle(old[0], new[0], old[1], new[1], root / 'product-bundle', old_receipt_digest=old[2], new_receipt_digest=new[2])
    (root / 'product-bundle/source-rebuild.json').write_bytes(provenance_bytes)
    rollback = os.environ.get('EXERCISE_ROLLBACK', 'false')
    require(rollback in ('true', 'false'), 'Explicit boolean rollback opt-in required')
    if rollback == 'true':
        from prepare_product_rollback_fixture import add_to_bundle
        result['planSha256'] = add_to_bundle(root / 'product-bundle', new[0], new[1], new[2], tools)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as file:
        file.write('rollback_enabled=' + rollback + '\n')
        file.write('plan_sha=' + result['planSha256'] + '\n')
        file.write('bundle_path=' + str(root / 'product-bundle') + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
