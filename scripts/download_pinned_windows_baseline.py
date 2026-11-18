"""Fetch only pinned Actions artifacts; never execute their content.

The reviewed lock is the trust root, not API self-report. Requires a private,
quiescent output parent on a disposable runner. Hashes are not code signatures.
No token is sent to archive storage and redirects there are refused.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from materialize_portable_download import plain_directory
from stage_windows_payload import windows_names
from verify_portable_download import MAX_BYTES, MAX_ENTRIES, MAX_MANIFEST, inventory_directory, require, safe_path

MAX_ZIP = 1024**3


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_lock(lock):
    require(lock.get('schemaVersion') == 1, 'Unsupported baseline lock')
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', lock.get('repository', '')), 'Invalid repository')
    require(re.fullmatch('[0-9a-f]{40}', lock.get('head', '')), 'Full head required')
    require(type(lock.get('runId')) is int and lock['runId'] > 0, 'Invalid run ID')
    require(re.fullmatch('[0-9a-f]{64}', lock.get('manifestSha256', '')), 'Manifest pin required')
    for key in ('portable', 'metadata'):
        item = lock[key]
        require(type(item.get('id')) is int and item['id'] > 0, 'Invalid artifact ID')
        require(isinstance(item.get('name'), str) and item['name'], 'Artifact name required')
        require(re.fullmatch('[0-9a-f]{64}', item.get('sha256', '')), 'ZIP pin required')
    require(lock['portable']['id'] != lock['metadata']['id'], 'Independent artifact IDs required')
    return lock


def validate_artifact(data, lock, key):
    pin = lock[key]
    require(data.get('id') == pin['id'] and data.get('name') == pin['name'], 'Artifact identity mismatch')
    require(data.get('expired') is False, 'Artifact expired/unknown')
    require(data.get('digest') == 'sha256:' + pin['sha256'], 'API artifact digest mismatch')
    run = data.get('workflow_run', {})
    require(run.get('id') == lock['runId'] and run.get('head_sha') == lock['head'], 'Artifact run/head mismatch')


def read_bounded(response, limit):
    data = response.read(limit + 1)
    require(len(data) <= limit, 'Response size limit')
    return data


def download_artifact(lock, key, destination, token, opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())
    api = f"https://api.github.com/repos/{lock['repository']}/actions/artifacts/{lock[key]['id']}"
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'LocalAPI-pinned-baseline'}
    with opener.open(urllib.request.Request(api, headers=headers), timeout=60) as response:
        data = json.loads(read_bounded(response, 1024**2))
    validate_artifact(data, lock, key)
    try:
        with opener.open(urllib.request.Request(api + '/zip', headers=headers), timeout=60):
            raise ValueError('Expected explicit archive redirect')
    except urllib.error.HTTPError as error:
        require(error.code == 302, 'Unexpected archive API response')
        location = error.headers.get('Location', '')
        error.close()
    parsed = urllib.parse.urlsplit(location)
    host = parsed.hostname or ''
    require(parsed.scheme == 'https' and parsed.port in (None, 443) and not parsed.username and not parsed.password
            and not parsed.fragment and (host.endswith('.blob.core.windows.net') or host.endswith('.actions.githubusercontent.com')),
            'Untrusted artifact storage redirect')
    digest = hashlib.sha256()
    used = 0
    # Deliberately a new request without the API Authorization header.
    with opener.open(urllib.request.Request(location), timeout=60) as response, destination.open('xb') as output:
        while chunk := response.read(1024 * 1024):
            used += len(chunk)
            require(used <= MAX_ZIP, 'ZIP download size limit')
            digest.update(chunk)
            output.write(chunk)
    require(digest.hexdigest() == lock[key]['sha256'], 'Downloaded ZIP digest mismatch')
    return data


def checked_zip(path, expected):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_ZIP, 'Invalid ZIP file')
    require(not (getattr(path.lstat(), 'st_file_attributes', 0) & 0x400), 'ZIP reparse point')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    require(digest.hexdigest() == expected, 'Raw ZIP digest mismatch')
    archive = zipfile.ZipFile(path)
    try:
        require(len(archive.infolist()) <= MAX_ENTRIES, 'ZIP entry limit')
        names, total = {}, 0
        for item in archive.infolist():
            require(item.orig_filename == item.filename, 'ZIP NUL/rewritten filename')
            name = safe_path(item.filename.rstrip('/') if item.is_dir() else item.filename)
            require(not item.flag_bits & 1, 'Encrypted ZIP entry')
            mode = item.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'ZIP links/special files forbidden')
            require(not (stat.S_ISDIR(mode) and not item.is_dir()), 'ZIP type mismatch')
            require(name not in names, 'Duplicate ZIP entry')
            names[name] = ('directory' if item.is_dir() else 'file', None)
            total += item.file_size
            require(0 <= item.file_size <= MAX_BYTES and total <= MAX_BYTES, 'ZIP expanded byte limit')
        # Include implied directories so aliases and file/directory collisions fail before writes.
        for name in list(names):
            parts = name.split('/')
            for end in range(1, len(parts)):
                parent = '/'.join(parts[:end])
                require(names.get(parent, ('directory',))[0] == 'directory', 'ZIP file/directory collision')
                names.setdefault(parent, ('directory', None))
        require(len(names) <= MAX_ENTRIES, 'Expanded entry limit')
        windows_names(None, inventory=type('Names', (), {'entries': names})())
        return archive
    except BaseException:
        archive.close()
        raise


def extract_verified(portable, metadata, lock, target):
    """Offline verification entrypoint, also used by synthetic tests."""
    validate_lock(lock)
    require(not target.exists() and not target.is_symlink(), 'Portable output exists')
    for parent in reversed(target.absolute().parents):
        plain_directory(parent)
    with checked_zip(portable, lock['portable']['sha256']) as package, checked_zip(metadata, lock['metadata']['sha256']) as evidence:
        for archive, name in ((package, 'LocalAPI/build-manifest.json'), (evidence, 'dist/LocalAPI/build-manifest.json')):
            require(archive.getinfo(name).file_size <= MAX_MANIFEST, 'Manifest too large')
            require(hashlib.sha256(archive.read(name)).hexdigest() == lock['manifestSha256'], 'Independent manifest pin mismatch')
        require(all(i.filename == 'LocalAPI/' or i.filename.startswith('LocalAPI/') for i in package.infolist()), 'Portable ZIP must have sole LocalAPI root')
        target.mkdir(mode=0o700)
        for item in package.infolist():
            name = item.filename[len('LocalAPI/'):].rstrip('/')
            if not name:
                continue
            dest = target / name
            if item.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            used = 0
            with package.open(item) as source, dest.open('xb') as output:
                while chunk := source.read(1024 * 1024):
                    used += len(chunk)
                    require(used <= item.file_size, 'ZIP inflated beyond declared size')
                    output.write(chunk)
            require(used == item.file_size, 'Truncated ZIP member')
    inventory = inventory_directory(target)
    result = inventory.verify(lock['head'], 'win32')
    require(result['arch'] == 'x64', 'Baseline must be x64')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    lock = validate_lock(json.loads(args.lock.read_text()))
    token = os.environ.get('GH_TOKEN', '')
    require(token and '\n' not in token and '\r' not in token, 'GH_TOKEN required')
    output = args.output.absolute()
    require('..' not in output.parts and not output.exists() and not output.is_symlink(), 'Fresh output required')
    for parent in reversed(output.parents):
        plain_directory(parent)
    output.mkdir(mode=0o700)
    records = {}
    for key in ('portable', 'metadata'):
        records[key] = download_artifact(lock, key, output / (key + '.zip'), token)
    summary = extract_verified(output / 'portable.zip', output / 'metadata.zip', lock, output / 'portable')
    receipt = {'schemaVersion': 1, 'lock': lock, 'artifacts': records, 'inventory': summary,
               'nativeExecutionPerformed': False, 'signatureVerified': False}
    (output / 'baseline-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'portable': str(output / 'portable'), **summary}))


if __name__ == '__main__':
    main()
