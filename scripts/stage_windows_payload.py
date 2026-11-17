"""Stage a verified Windows payload in a new directory; never install or run it."""
import argparse
import json
import re
from pathlib import Path
from materialize_portable_download import materialize_download
from verify_portable_download import require, verify_download, inventory_directory, MAX_MANIFEST


def identity(root, version, arch):
    root = Path(root)
    manifest_path = root / 'build-manifest.json'
    package_path = root / 'resources/app/package.json'
    # Inventory verification bounds all package files first; additionally bound
    # metadata parsing and disallow ambiguous duplicate JSON keys.
    def read_json(path, limit):
        require(path.stat().st_size <= limit, 'Staging identity metadata too large')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, 'Duplicate staging metadata key')
                result[key] = value
            return result
        return json.loads(path.read_text(encoding='utf8'), object_pairs_hook=unique)
    manifest = read_json(manifest_path, MAX_MANIFEST)
    package = read_json(package_path, 65536)
    require(isinstance(manifest, dict) and isinstance(package, dict), 'Invalid staging metadata')
    require(manifest.get('product') == 'Local API Workbench', 'Wrong product')
    require(manifest.get('arch') == arch, 'Wrong requested architecture')
    require(isinstance(version, str) and version and manifest.get('version') == version, 'Wrong requested version')
    require(package.get('name') == 'local-api-workbench', 'Packaged application name changed')
    require('productName' not in package, 'Unreviewed productName override')
    require(package.get('version') == version, 'Package and manifest versions differ')
    require(package.get('type') == 'module' and package.get('main') == 'desktop/main.mjs', 'Packaged entrypoint changed')
    return {'applicationName': package['name'], 'version': version, 'arch': arch,
            'entrypoint': package['main']}


def windows_names(root, *, inventory=None):
    if inventory is None:
        inventory = inventory_directory(root)
    folded = set()
    for name, (kind, _) in inventory.entries.items():
        if not name:
            continue
        require(kind != 'symlink', 'Windows staging forbids links')
        for part in name.split('/'):
            require(not any(c in part for c in ':<>"|?*') and not part.endswith((' ', '.')), 'Unsafe Windows name')
            base = part.split('.')[0].rstrip(' ').upper()
            require(base not in ('CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$') and
                    re.fullmatch(r'(COM|LPT)[1-9¹²³]', base) is None, 'Reserved Windows name')
        key = name.casefold()
        require(key not in folded, 'Windows case-insensitive collision')
        folded.add(key)


def stage_windows_payload(download, destination, head, version, arch):
    require(arch in ('x64', 'arm64'), 'Unsupported requested Windows architecture')
    source, target = Path(download).resolve(), Path(destination).resolve()
    require(source != target and source not in target.parents and target not in source.parents,
            'Staging source and destination must be disjoint')
    source_key, target_key = tuple(p.casefold() for p in source.parts), tuple(p.casefold() for p in target.parts)
    require(source_key[:len(target_key)] != target_key and target_key[:len(source_key)] != source_key,
            'Windows case-insensitive source/output overlap')
    verify_download(download, 'win32', head)
    windows_names(Path(download) / 'LocalAPI')
    before = identity(Path(download) / 'LocalAPI', version, arch)
    result = materialize_download(download, destination, 'win32', head)
    windows_names(destination)
    require(identity(destination, version, arch) == before, 'Staged package identity changed')
    return {**result, **before, 'kind': 'windows-payload-staging',
            'installationPerformed': False, 'signatureVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('download', help='Quiescent extracted artifact directory')
    parser.add_argument('destination', help='New nonexistent path in an operator-controlled parent')
    parser.add_argument('--head', required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--arch', required=True, choices=('x64', 'arm64'))
    args = parser.parse_args()
    print(json.dumps(stage_windows_payload(args.download, args.destination, args.head,
                                           args.expected_version, args.arch)))
