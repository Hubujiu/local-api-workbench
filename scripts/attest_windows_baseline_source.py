"""Verify a pinned source checkout and attest a NEW unsigned baseline build.

This never asserts byte reproduction of the expiring historical Actions ZIP.
Independent job outputs pin this receipt and the newly generated manifest.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from verify_portable_download import inventory_directory, require
from stage_windows_payload import identity, windows_names

FILES = {'package.json', 'package-lock.json', 'desktop/package.json', 'desktop/package-lock.json'}

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def read_lock(path):
    lock = json.loads(Path(path).read_text())
    require(lock.get('schemaVersion') == 1 and lock.get('repository') == 'Hubujiu/local-api-workbench', 'Baseline source lock identity')
    require(re.fullmatch('[0-9a-f]{40}', lock.get('head', '')) and lock.get('version') == '0.1.0', 'Exact baseline source/version required')
    require(lock.get('sourceUrl') == 'https://github.com/' + lock['repository'] + '/tree/' + lock['head'], 'Official exact source URL required')
    require(set(lock.get('files', {})) == FILES and all(re.fullmatch('[0-9a-f]{64}', x) for x in lock['files'].values()), 'Exact dependency/source pins required')
    require(lock.get('nodeVersion') == '24.22.3', 'Reviewed baseline build runtime required')
    return lock

def verify_source(root, lock):
    root = Path(root)
    head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    require(head == lock['head'], 'Baseline source head mismatch')
    # Reject tracked modifications, including historical build scripts. Untracked
    # dependency/output trees are allowed only because the job starts clean.
    require(not subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=no'], text=True).strip(), 'Baseline tracked source modified')
    for file, expected in lock['files'].items():
        require(digest(root / file) == expected, 'Baseline source dependency pin mismatch: ' + file)

def attest(root, payload, lock, builder_head):
    verify_source(root, lock)
    require(re.fullmatch('[0-9a-f]{40}', builder_head), 'Exact authoring source required')
    payload = Path(payload)
    inv = inventory_directory(payload)
    inv.verify(lock['head'], 'win32')
    identity(payload, lock['version'], 'x64')
    windows_names(payload, inventory=inv)
    return dict(schemaVersion=1, kind='source-rebuild', repository=lock['repository'], sourceUrl=lock['sourceUrl'], head=lock['head'], version=lock['version'], nodeVersion=lock['nodeVersion'], sourceFiles=lock['files'], builderHead=builder_head, manifestSha256=digest(payload / 'build-manifest.json'), historicalArchiveReproduced=False)

def validate_receipt(receipt, lock, head, version, manifest, builder_head):
    require(receipt == dict(schemaVersion=1, kind='source-rebuild', repository=lock['repository'], sourceUrl=lock['sourceUrl'], head=head, version=version, nodeVersion=lock['nodeVersion'], sourceFiles=lock['files'], builderHead=builder_head, manifestSha256=manifest, historicalArchiveReproduced=False), 'Baseline rebuild provenance mismatch')
    require(head == lock['head'] and version == lock['version'], 'Baseline job identity differs from source lock')
    require(re.fullmatch('[0-9a-f]{64}', manifest), 'New baseline manifest pin required')

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--lock',required=True);parser.add_argument('--source',required=True)
    parser.add_argument('--payload');parser.add_argument('--builder-head');parser.add_argument('--receipt')
    args=parser.parse_args();lock=read_lock(args.lock);verify_source(args.source,lock)
    if args.payload:
        require(args.receipt and args.builder_head, 'Receipt and builder head required')
        Path(args.receipt).write_text(json.dumps(attest(args.source,args.payload,lock,args.builder_head),indent=2)+'\n')

if __name__ == '__main__': main()
