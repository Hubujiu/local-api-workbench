"""Extract the repository's sha256-pinned Debian MSI authoring tools without installing packages."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request


def materialize(directory):
    directory.mkdir(parents=True, exist_ok=True)
    lock = Path(__file__).resolve().parents[1] / 'packaging/windows-msi/debian-toolchain-lock.json'
    for item in json.loads(lock.read_text()):
        archive = directory / Path(item['Filename']).name
        if not archive.exists():
            with urllib.request.urlopen('https://deb.debian.org/debian/' + item['Filename'], timeout=60) as response:
                archive.write_bytes(response.read())
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item['SHA256']:
            raise ValueError('MSI authoring dependency digest mismatch')
        subprocess.run(['dpkg-deb', '-x', archive, directory / 'root'], check=True)


if __name__ == '__main__':
    materialize(Path(sys.argv[1]).resolve())
