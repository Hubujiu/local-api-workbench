"""Deterministic install-file contract; not a signature or deletion authority."""
import hashlib
import json
import re
from verify_portable_download import require

APP_DIR = 'LocalAPI-FirstInstall-Candidate'
RECORD_NAME = 'localapi-install-record.json'


def record_bytes(head, version, manifest_sha256):
    require(isinstance(head, str) and re.fullmatch(r'[0-9a-f]{40}', head), 'Expected full payload head')
    require(isinstance(manifest_sha256, str) and re.fullmatch(r'[0-9a-f]{64}', manifest_sha256), 'Expected full manifest SHA-256')
    require(isinstance(version, str) and 0 < len(version) <= 128, 'Expected bounded payload version')
    return (json.dumps({
        'schema': 'localapi-install-record-v1', 'product': 'Local API Workbench',
        'applicationName': 'local-api-workbench', 'platform': 'win32', 'arch': 'x64',
        'payloadHead': head, 'version': version, 'payloadManifestSha256': manifest_sha256,
        'manifestFile': 'build-manifest.json', 'recordFile': RECORD_NAME,
        'directoryName': APP_DIR, 'baseDirectory': 'LOCALAPPDATA', 'installScope': 'current-user',
        'managedContent': 'exact-payload-manifest-plus-this-record',
        'userDataManaged': False, 'deletionAuthorized': False,
    }, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def record_digest(head, version, manifest_sha256):
    return hashlib.sha256(record_bytes(head, version, manifest_sha256)).hexdigest()


def reserve_record_name(entries):
    require(not any(name.split('/')[0].casefold() == RECORD_NAME.casefold() for name in entries),
            'Payload collides with reserved install record namespace')
