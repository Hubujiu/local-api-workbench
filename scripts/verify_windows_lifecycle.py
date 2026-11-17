"""Read-only lifecycle file evidence for an isolated, quiescent Windows test account."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat

from materialize_portable_download import plain_directory
from verify_portable_download import inventory_directory, require, MAX_MANIFEST
from verify_windows_first_install import APP_DIR, verify_first_install


KIND = 'windows-candidate-lifecycle-baseline-v1'


def absolute_plain_directory(value):
    path = Path(value)
    require(path.is_absolute() and '..' not in path.parts, 'Expected absolute unambiguous directory')
    for ancestor in (*reversed(path.parents), path):
        plain_directory(ancestor)
    # On Windows resolve expands short (8.3) names and normalizes equivalent
    # path spellings. Reject links/reparse ancestors before resolving them.
    canonical = path.resolve(strict=True)
    for ancestor in (*reversed(canonical.parents), canonical):
        plain_directory(ancestor)
    return canonical


def overlaps(left, right):
    # Reject Windows case aliases even when tests run on a case-sensitive host.
    a, b = tuple(p.casefold() for p in left.parts), tuple(p.casefold() for p in right.parts)
    return a[:len(b)] == b or b[:len(a)] == a


def paths(local_app_data, protected):
    parent = absolute_plain_directory(local_app_data)
    require(0 < len(protected) <= 8, 'Expected one to eight protected synthetic data directories')
    roots = [absolute_plain_directory(p) for p in protected]
    app = parent / APP_DIR
    pending = parent / (APP_DIR + '.pending')
    for i, root in enumerate(roots):
        require(not any(overlaps(root, other) for other in [app, pending, *roots[:i]]),
                'Protected data and application paths must be disjoint (including case aliases)')
    return parent, sorted(roots, key=lambda p: str(p).casefold())


def protected_inventory(root):
    inventory = inventory_directory(root, fail_on_walk_error=True)
    require(all(kind != 'symlink' for kind, _ in inventory.entries.values()), 'Protected data contains a link')
    require(bool(inventory.hashes), 'Protected data must contain a synthetic file, not only empty directories')
    return {'path': str(root), 'files': dict(sorted(inventory.hashes.items())),
            'directories': sorted(name for name, (kind, _) in inventory.entries.items() if kind == 'directory'),
            'bytes': inventory.total}


def capture(local_app_data, protected, head, version, manifest_sha256, install_record_sha256=None):
    parent, roots = paths(local_app_data, protected)
    installed = verify_first_install(parent, head, version, manifest_sha256, install_record_sha256)
    result = {'kind': KIND, 'localAppData': str(parent), 'installed': installed,
              'protected': [protected_inventory(root) for root in roots],
              'operationExecuted': False, 'nativeLifecycleVerified': False}
    # Never emit a baseline that the bounded reader cannot consume. Include
    # the CLI's trailing newline in the byte limit.
    require(len(json.dumps(result, sort_keys=True).encode('utf-8')) + 1 <= MAX_MANIFEST, 'Baseline size limit')
    return result


def read_baseline(filename, expected_digest):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_digest) is not None, 'Expected full independent baseline SHA-256')
    path = Path(filename)
    absolute_plain_directory(path.parent)
    require(not path.is_symlink(), 'Baseline must not be a link')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400),
            'Baseline must be a regular file')
    require(info.st_size <= MAX_MANIFEST, 'Baseline size limit')
    with path.open('rb') as source:
        raw = source.read(MAX_MANIFEST + 1)
    require(len(raw) <= MAX_MANIFEST, 'Baseline size limit')
    require(hashlib.sha256(raw).hexdigest() == expected_digest, 'Baseline digest mismatch')
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj, 'Duplicate baseline key')
            obj[key] = value
        return obj
    baseline = json.loads(raw, object_pairs_hook=unique)
    require(isinstance(baseline, dict) and baseline.get('kind') == KIND, 'Wrong baseline kind')
    require(set(baseline) == {'kind', 'localAppData', 'installed', 'protected', 'operationExecuted', 'nativeLifecycleVerified'},
            'Wrong baseline schema')
    require(baseline['operationExecuted'] is False and baseline['nativeLifecycleVerified'] is False,
            'Baseline is not a file-only observation')
    require(isinstance(baseline['installed'], dict) and baseline['installed'].get('kind') == 'windows-first-install-file-inventory',
            'Missing baseline installed inventory')
    return baseline


def require_absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise ValueError('Application or pending entry remains')


def verify(local_app_data, protected, baseline_file, baseline_sha256, state,
           head=None, version=None, manifest_sha256=None, install_record_sha256=None):
    require(state in ('installed', 'uninstalled'), 'Unknown expected lifecycle state')
    parent, roots = paths(local_app_data, protected)
    baseline = read_baseline(baseline_file, baseline_sha256)
    require(baseline['localAppData'] == str(parent), 'Baseline belongs to another LOCALAPPDATA')
    current = [protected_inventory(root) for root in roots]
    require(current == baseline['protected'], 'Protected data differs from baseline')
    if state == 'installed':
        require(all(isinstance(v, str) and v for v in (head, version, manifest_sha256)), 'Installed state requires independent payload identity')
        installed = verify_first_install(parent, head, version, manifest_sha256, install_record_sha256)
    else:
        require(head is None and version is None and manifest_sha256 is None and install_record_sha256 is None, 'Uninstalled state does not accept payload identity')
        require_absent(parent / APP_DIR)
        require_absent(parent / (APP_DIR + '.pending'))
        installed = None
    return {'kind': 'windows-candidate-lifecycle-file-comparison', 'expectedState': state,
            'baselineSha256': baseline_sha256, 'previousInstalled': baseline['installed'],
            'installed': installed, 'protectedDirectories': [str(root) for root in roots],
            'protectedFiles': sum(len(item['files']) for item in current), 'dataBytesPreserved': sum(item['bytes'] for item in current),
            'operationExecuted': False, 'nativeLifecycleVerified': False, 'signatureVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('capture', 'verify'))
    parser.add_argument('--local-app-data', required=True)
    parser.add_argument('--protect', action='append', required=True, help='Existing synthetic profile or sentinel directory; repeat to protect several')
    parser.add_argument('--payload-head')
    parser.add_argument('--version')
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--install-record-sha256', help='Independent target record pin; omit only for legacy record-free payload')
    parser.add_argument('--baseline')
    parser.add_argument('--baseline-sha256')
    parser.add_argument('--state', choices=('installed', 'uninstalled'))
    args = parser.parse_args()
    try:
        if args.action == 'capture':
            require(not any((args.baseline, args.baseline_sha256, args.state)), 'Capture does not accept verify options')
            require(all((args.payload_head, args.version, args.manifest_sha256, args.install_record_sha256)), 'Capture requires independent payload identity')
            result = capture(args.local_app_data, args.protect, args.payload_head, args.version, args.manifest_sha256, args.install_record_sha256)
        else:
            require(all((args.baseline, args.baseline_sha256, args.state)), 'Verify requires baseline, pinned digest and state')
            result = verify(args.local_app_data, args.protect, args.baseline, args.baseline_sha256, args.state,
                            args.payload_head, args.version, args.manifest_sha256, args.install_record_sha256)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'Lifecycle file verification failed: {exc}\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
