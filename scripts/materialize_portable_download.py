"""Materialize a quiescent, exact-head verified download; never execute package code."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import stat
import tarfile

from verify_portable_download import (
    BoundedArchiveReader, BoundedTarInfo, inventory_archive,
    inventory_directory, require, verify_download,
)


def plain_directory(path):
    st = path.lstat()
    require(stat.S_ISDIR(st.st_mode) and not path.is_symlink(), "Destination ancestor is not a plain directory")
    require(not (getattr(st, "st_file_attributes", 0) & 0x400), "Destination reparse point")


def copy_file(source, destination, expected_hash, expected_size):
    digest = hashlib.sha256()
    used = 0
    with destination.open("xb") as output:
        while True:
            chunk = source.read(min(1024 * 1024, expected_size - used + 1))
            if not chunk:
                break
            used += len(chunk)
            require(used <= expected_size, "Source grew during materialization")
            digest.update(chunk)
            output.write(chunk)
    require(used == expected_size, "Source truncated during materialization")
    require(digest.hexdigest() == expected_hash, "Source changed during materialization")


def materialize_download(download, destination, platform, head):
    # Verification precedes all writes. Inputs must remain quiescent and the
    # destination parent must be controlled by this CI job, not another writer.
    summary = verify_download(download, platform, head)
    download, destination = Path(download).absolute(), Path(destination).absolute()
    require(".." not in destination.parts, "Ambiguous destination")
    for ancestor in reversed(destination.parents):
        plain_directory(ancestor)
    require(not destination.exists() and not destination.is_symlink(), "Destination already exists")
    archive = None
    if platform == "win32":
        source_root = download / "LocalAPI"
        inventory = inventory_directory(source_root)
    else:
        archive = download / ("LocalAPI-" + {"linux": "Linux", "darwin": "macOS"}[platform] + ".tar.gz")
        inventory = inventory_archive(archive)
    require(inventory.verify(head, platform) == summary, "Download changed before materialization")
    # Do not restore setuid/setgid/sticky metadata from an archive. Application
    # distributions need only ordinary read/write/execute permission bits.
    if platform != "win32":
        require(all(not (mode & 0o7000) for mode in inventory.modes.values()), "Special permission bits")
    destination.mkdir(mode=0o700)
    directories = sorted((name for name, (kind, _) in inventory.entries.items()
                          if name and kind == "directory"), key=lambda name: (name.count("/"), name))
    for name in directories:
        (destination / name).mkdir(mode=0o700)
    remaining = inventory.total
    if platform == "win32":
        for name, (kind, _) in inventory.entries.items():
            if kind != "file":
                continue
            source_path = source_root / name
            st = source_path.lstat()
            require(stat.S_ISREG(st.st_mode) and not (getattr(st, "st_file_attributes", 0) & 0x400), "Source is no longer regular")
            require(0 <= st.st_size <= remaining, "Source byte limit changed")
            remaining -= st.st_size
            with source_path.open("rb") as source:
                current = os.fstat(source.fileno())
                require(stat.S_ISREG(current.st_mode) and current.st_size == st.st_size, "Source changed before copy")
                copy_file(source, destination / name, inventory.hashes[name], st.st_size)
    else:
        seen = set()
        root_seen = False
        with gzip.open(archive, "rb") as compressed:
            stream = BoundedArchiveReader(compressed)
            with tarfile.open(fileobj=stream, mode="r|", tarinfo=BoundedTarInfo) as package:
                for item in package:
                    name = item.name.rstrip("/")
                    if name == "LocalAPI":
                        require(item.isdir() and not root_seen, "Invalid archive root")
                        root_seen = True
                        continue
                    require(name.startswith("LocalAPI/"), "Archive root changed")
                    name = name[len("LocalAPI/"):]
                    require(name in inventory.entries and name not in seen, "Archive entry changed")
                    seen.add(name)
                    kind = "file" if item.isfile() else "directory" if item.isdir() else "symlink" if item.issym() else "unsupported"
                    require(inventory.entries[name][0] == kind and (kind != "symlink" or inventory.entries[name][1] == item.linkname), "Archive type/link changed")
                    require(item.mode == inventory.modes[name], "Archive mode changed")
                    if kind == "file":
                        require(0 <= item.size <= remaining, "Archive byte limit changed")
                        remaining -= item.size
                        with package.extractfile(item) as source:
                            copy_file(source, destination / name, inventory.hashes[name], item.size)
            while stream.read(1024 * 1024):
                pass
        require(root_seen and seen == set(inventory.entries) - {""}, "Archive entries changed")
    # Links are last, so no archive member can write through a link. The verifier
    # has already checked their complete graph for escapes, dangling links/cycles.
    for name, (kind, target) in inventory.entries.items():
        if kind == "symlink":
            require(platform != "win32", "Windows package links are unsupported")
            os.symlink(target, destination / name)
        elif kind == "file":
            (destination / name).chmod(inventory.modes[name] & 0o777)
    for name in reversed(directories):
        (destination / name).chmod(inventory.modes[name] & 0o777)
    actual = inventory_directory(destination)
    require(actual.manifest == inventory.manifest, "Materialized manifest changed")
    require(actual.verify(head, platform) == summary, "Materialized package mismatch")
    return {**summary, "root": str(destination)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("destination")
    parser.add_argument("--platform", choices=("linux", "darwin", "win32"), required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args()
    print("DOWNLOADED_PORTABLE_MATERIALIZED_PASS " + json.dumps(materialize_download(args.directory, args.destination, args.platform, args.head), sort_keys=True))
