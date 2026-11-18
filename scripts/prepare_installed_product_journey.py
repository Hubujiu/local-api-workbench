"""Bundle independently pinned, trusted-build MSI inputs for opt-in native testing.

This is not an MSI signature verifier. Pins must come from the trusted build process,
not a received bundle's self-reported JSON. PE structure does not establish Electron
provenance or execution safety; the native journey must still prove runtime identity.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import struct
import uuid
from prepare_windows_lifecycle_msi import APP_DIR, guid, validate
from stage_windows_payload import identity, windows_names
from verify_portable_download import MAX_BYTES, MAX_MANIFEST, inventory_directory, require


def no_alias(path):
    path = Path(path).absolute()
    for node in [path, *path.parents]:
        if node.exists() or node.is_symlink():
            info = node.lstat()
            require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'Aliased/reparse input or output refused')
    return path.resolve()


def pinned_bytes(path, digest, limit=MAX_MANIFEST):
    require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'Independent full SHA-256 required')
    path = no_alias(path)
    require(path.is_file() and path.stat().st_size <= limit, 'Bounded ordinary input file required')
    data = path.read_bytes()
    require(len(data) <= limit and hashlib.sha256(data).hexdigest() == digest, 'Independent receipt digest mismatch')
    return data


def file_digest(path):
    path = no_alias(path)
    require(path.is_file() and path.stat().st_size <= MAX_BYTES, 'Bounded ordinary MSI file required')
    value = hashlib.sha256(); count = 0
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            count += len(chunk); require(count <= MAX_BYTES, 'MSI size limit exceeded')
            value.update(chunk)
    return value.hexdigest()


def unique_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate metadata key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def require_x64_pe(path):
    """Reject the text fixture; do not confuse a PE header with trusted code."""
    path = no_alias(path)
    with path.open('rb') as source:
        dos = source.read(64)
        require(len(dos) == 64 and dos[:2] == b'MZ', 'Real-product candidate requires a PE launcher, not inert text')
        offset = struct.unpack_from('<I', dos, 60)[0]
        require(64 <= offset <= 1024 * 1024 and offset + 26 <= path.stat().st_size, 'Invalid PE header offset')
        source.seek(offset); pe = source.read(26)
    require(pe[:4] == b'PE\0\0' and struct.unpack_from('<H', pe, 4)[0] == 0x8664, 'x64 PE launcher required')
    require(struct.unpack_from('<H', pe, 22)[0] & 2 and struct.unpack_from('<H', pe, 24)[0] == 0x20b, 'Executable PE32+ launcher required')


def checked_build(build, digest, receipt_digest):
    build = no_alias(build)
    require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'Independent full MSI digest required')
    require(file_digest(build / 'LocalAPI-lifecycle-UNSIGNED.msi') == digest, 'Independent MSI digest mismatch')
    receipt_bytes = pinned_bytes(build / 'build-input.json', receipt_digest)
    receipt = unique_json(receipt_bytes)
    evidence_path = no_alias(build / 'compiled-evidence.json')
    require(evidence_path.stat().st_size <= 64 * 1024 * 1024, 'Compile evidence size limit')
    evidence_bytes = evidence_path.read_bytes()
    require(len(evidence_bytes) <= 64 * 1024 * 1024, 'Compile evidence size limit')
    evidence = unique_json(evidence_bytes)
    require(evidence['msiSha256'] == digest, 'Compile evidence mismatch')
    validate(receipt, evidence['tables'])
    family = receipt['fixtureFamily']
    require(isinstance(family, str) and str(uuid.UUID(family)) == family and uuid.UUID(family).version == 4, 'Disposable UUIDv4 namespace required; production candidate forbidden')
    require(receipt['directory'] == APP_DIR + '-Fixture-' + family, 'Wrong isolated installation directory')
    require(receipt['upgradeCode'] == guid('fixture:' + family + ':upgrade') and receipt['productCode'] == guid('fixture:' + family + ':product:' + receipt['version']), 'Wrong package family identity')
    extracted = no_alias(build / 'extracted' / receipt['directory'])
    inventory = inventory_directory(extracted, fail_on_walk_error=True)
    require(inventory.hashes == receipt['fileHashes'], 'Extracted payload differs from pinned receipt')
    inventory.verify(receipt['head'], 'win32'); windows_names(extracted, inventory=inventory)
    require(not inventory.links(), 'Linked payload forbidden')
    identity(extracted, receipt['version'], 'x64')
    require(hashlib.sha256(inventory.manifest).hexdigest() == receipt['manifestSha256'], 'Manifest digest differs')
    require_x64_pe(extracted / 'LocalAPI.exe')
    return build, digest, receipt, receipt_bytes, receipt_digest


def prepare(old, new, old_digest, new_digest, output, *, old_receipt_digest, new_receipt_digest):
    output = no_alias(output)
    require(not output.exists(), 'Fresh bundle output required')
    records = []
    for build, digest, receipt_digest in [(old, old_digest, old_receipt_digest), (new, new_digest, new_receipt_digest)]:
        build = no_alias(build)
        require(build != output and build not in output.parents and output not in build.parents, 'Disjoint bundle directory required')
        records.append(checked_build(build, digest, receipt_digest))
    first, second = records[0][2], records[1][2]
    require(first['fixtureFamily'] == second['fixtureFamily'] and first['directory'] == second['directory'] and first['upgradeCode'] == second['upgradeCode'], 'One isolated upgrade family required')
    require(tuple(map(int, first['version'].split('.'))) < tuple(map(int, second['version'].split('.'))), 'New version must be higher')
    require(first['productCode'] != second['productCode'], 'Distinct product codes required')
    output.mkdir(parents=True)
    packages = []
    for label, (build, digest, receipt, receipt_bytes, receipt_digest) in zip(['old', 'new'], records):
        destination = output / label; destination.mkdir()
        shutil.copyfile(build / 'LocalAPI-lifecycle-UNSIGNED.msi', destination / 'LocalAPI-lifecycle-UNSIGNED.msi')
        require(file_digest(destination / 'LocalAPI-lifecycle-UNSIGNED.msi') == digest, 'Bundle copy mismatch')
        (destination / 'build-input.json').write_bytes(receipt_bytes)
        packages.append({'version': receipt['version'], 'head': receipt['head'],
                         'msi': {'file': label + '/LocalAPI-lifecycle-UNSIGNED.msi', 'sha256': digest},
                         'receipt': {'file': label + '/build-input.json', 'sha256': receipt_digest}})
    plan = {'kind': 'localapi-installed-product-lifecycle-v1', 'family': first['fixtureFamily'], 'directory': first['directory'], 'packages': packages}
    path = output / 'product-plan.json'; path.write_text(json.dumps(plan, indent=2) + '\n')
    return {'plan': str(path), 'planSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'nativeProductVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['old', 'new', 'old-digest', 'new-digest', 'old-receipt-digest', 'new-receipt-digest', 'output']: parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.old, args.new, args.old_digest, args.new_digest, args.output,
                             old_receipt_digest=args.old_receipt_digest, new_receipt_digest=args.new_receipt_digest), indent=2))
