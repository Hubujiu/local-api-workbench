"""Build two inert MSI versions for an isolated native Windows job, not user install."""
import argparse
import hashlib
import json
from pathlib import Path
import uuid
from prepare_windows_lifecycle_msi import prepare, compile_msi
from verify_portable_download import require


def build(output, tools):
    output = Path(output).resolve()
    require(not output.exists(), 'Fresh fixture output required')
    output.mkdir(parents=True)
    family = str(uuid.uuid4()); records = []
    for version in ['0.1.0', '0.2.0']:
        root = output / version; payload = root / 'payload'; payload.mkdir(parents=True)
        files = {'LocalAPI.exe': b'INERT FIXTURE, NOT A PE EXECUTABLE\n',
                 'resources/app/package.json': json.dumps({'name': 'local-api-workbench', 'version': version, 'type': 'module', 'main': 'desktop/main.mjs'}).encode(),
                 'resources/app/desktop/main.mjs': b'INERT FIXTURE\n',
                 'resources/app/src/runtime.mjs': b'INERT FIXTURE\n',
                 'resources/app/public/app.js': b'INERT FIXTURE\n',
                 'fixture-version.txt': (family + ':' + version).encode()}
        manifest = {'product': 'Local API Workbench', 'version': version, 'head': 'a' * 40, 'platform': 'win32', 'arch': 'x64', 'integrityVersion': 1, 'links': [],
                    'files': [{'path': n, 'sha256': hashlib.sha256(b).hexdigest()} for n, b in sorted(files.items())]}
        files['build-manifest.json'] = json.dumps(manifest).encode()
        for name, data in files.items():
            path = payload / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        receipt = prepare(payload, root / 'build', 'a' * 40, version, hashlib.sha256(files['build-manifest.json']).hexdigest(), family)
        msi = compile_msi(root / 'build', tools)
        records.append({'version': version, 'package': version + '/build/' + msi.name,
                        'sha256': hashlib.sha256(msi.read_bytes()).hexdigest(), 'productCode': receipt['productCode'], 'fileHashes': receipt['fileHashes']})
    plan = {'kind': 'localapi-inert-msi-lifecycle-v1', 'family': family, 'directory': receipt['directory'], 'packages': records,
            'nativeLifecycleVerified': False, 'productAcceptance': False}
    (output / 'native-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    return plan


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--output', required=True); p.add_argument('--tools', required=True)
    args = p.parse_args(); print(json.dumps(build(args.output, args.tools), indent=2))
