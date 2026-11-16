"""Verify files from a quiescent first-install candidate; never install or launch."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from materialize_portable_download import plain_directory
from stage_windows_payload import identity, windows_names
from verify_portable_download import inventory_directory, require


APP_DIR = 'LocalAPI-FirstInstall-Candidate'


def verify_first_install(local_app_data, head, version, manifest_sha256):
    require(re.fullmatch(r'[0-9a-f]{40}', head) is not None, 'Expected full payload head')
    require(re.fullmatch(r'[0-9a-f]{64}', manifest_sha256) is not None, 'Expected full manifest SHA-256')
    parent = Path(local_app_data)
    require(parent.is_absolute() and '..' not in parent.parts, 'Expected an absolute, unambiguous LOCALAPPDATA path')
    root = parent / APP_DIR
    for directory in (*reversed(root.parents), root):
        plain_directory(directory)
    pending = parent / (APP_DIR + '.pending')
    try:
        pending.lstat()
    except FileNotFoundError:
        pass
    else:
        raise ValueError('Pending first-install directory or entry remains')

    inventory = inventory_directory(root, fail_on_walk_error=True)
    require(inventory.manifest is not None, 'Missing installed manifest')
    require(hashlib.sha256(inventory.manifest).hexdigest() == manifest_sha256, 'Installed manifest digest mismatch')
    windows_names(root, inventory=inventory)
    evidence = inventory.verify(head, 'win32')
    package = identity(root, version, 'x64')

    # The compiler emits only file entries. Every extracted directory must
    # be a parent of at least one file from the independently pinned payload.
    expected = {''}
    for filename in inventory.hashes:
        expected.update(p.as_posix() for p in Path(filename).parents if p != Path('.'))
    actual = {name for name, (kind, _) in inventory.entries.items() if kind == 'directory'}
    require(actual == expected, 'Unexpected installed directory')
    return {
        **evidence, **package, 'kind': 'windows-first-install-file-inventory',
        'filesIncludingManifest': len(inventory.hashes), 'manifestSha256': manifest_sha256,
        'installerExecutionVerified': False, 'signatureVerified': False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-app-data', required=True, help='Absolute LOCALAPPDATA from the test account')
    parser.add_argument('--payload-head', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--manifest-sha256', required=True, help='Independently pinned digest, not computed from the install')
    args = parser.parse_args()
    try:
        receipt = verify_first_install(args.local_app_data, args.payload_head, args.version, args.manifest_sha256)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'File inventory verification failed: {exc}\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
