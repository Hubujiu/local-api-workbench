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


def main():
    root = Path(os.environ['RUNNER_TEMP'])
    require(root.is_absolute(), 'Absolute runner temp required')
    new_head, new_manifest = os.environ['NEW_HEAD'], os.environ['NEW_MANIFEST_SHA']
    require(re.fullmatch('[0-9a-f]{40}', new_head) and re.fullmatch('[0-9a-f]{64}', new_manifest), 'Independent job output pins required')
    lock = json.loads(Path('packaging/windows-msi/windows-baseline-lock.json').read_text())
    family = str(uuid.uuid4())
    tools = root / 'msitools/root/usr/bin'
    outputs = []
    for label, source, head, version, manifest in [
        ('old', root / 'baseline/portable', lock['head'], '0.1.0', lock['manifestSha256']),
        ('new', root / 'new-portable', new_head, '0.1.1', new_manifest),
    ]:
        output = root / ('product-msi-' + label)
        prepare(source, output, head, version, manifest, family)
        msi = compile_msi(output, tools)
        outputs.append((output, hashlib.sha256(msi.read_bytes()).hexdigest(), hashlib.sha256((output / 'build-input.json').read_bytes()).hexdigest()))
    old, new = outputs
    result = bundle(old[0], new[0], old[1], new[1], root / 'product-bundle', old_receipt_digest=old[2], new_receipt_digest=new[2])
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
