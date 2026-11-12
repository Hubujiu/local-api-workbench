"""Verify a quiescent Actions download without executing or extracting package code."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile

MAX_ENTRIES = 100000
MAX_BYTES = 4 * 1024**3
MAX_MANIFEST = 32 * 1024**2


def require(condition, message):
    if not condition:
        raise ValueError(message)


def js_sort_key(value):
    return value.encode("utf-16-be", "surrogatepass")


def safe_path(value):
    require(isinstance(value, str) and value, "Empty entry path")
    require(not value.startswith("/") and "\\" not in value, "Absolute/non-portable path")
    require(not re.match(r"^[A-Za-z]:", value), "Drive path")
    require(not any(ord(c) < 32 or ord(c) == 127 for c in value), "Control in path")
    require(all(p not in ("", ".", "..") for p in value.split("/")), "Unsafe component")
    return value


class Inventory:
    def __init__(self):
        self.entries = {"": ("directory", None)}
        self.hashes = {}
        self.modes = {}
        self.manifest = None
        self.total = 0

    def add(self, name, kind, mode, source=None, size=0, target=None):
        safe_path(name)
        require(name not in self.entries, "Duplicate entry")
        require(len(self.entries) < MAX_ENTRIES, "Entry limit")
        require(kind in ("file", "directory", "symlink"), "Unsupported entry type")
        self.entries[name] = (kind, target)
        self.modes[name] = mode
        if kind != "file":
            require(name != "build-manifest.json", "Manifest must be regular")
            return
        require(0 <= size <= MAX_BYTES and self.total + size <= MAX_BYTES, "Byte limit")
        self.total += size
        if name == "build-manifest.json":
            require(size <= MAX_MANIFEST, "Manifest size limit")
        digest = hashlib.sha256()
        captured = bytearray()
        used = 0
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            used += len(chunk)
            require(used <= size, "File grew or corrupt size")
            digest.update(chunk)
            if name == "build-manifest.json":
                captured.extend(chunk)
        require(used == size, "Truncated file")
        self.hashes[name] = digest.hexdigest()
        if name == "build-manifest.json":
            self.manifest = bytes(captured)

    def links(self):
        result = []
        for name, (kind, target) in self.entries.items():
            if kind != "symlink":
                continue
            require(isinstance(target, str) and 0 < len(target.encode()) <= 4096, "Invalid link")
            require(not target.startswith("/") and not re.match(r"^[A-Za-z]:", target), "Absolute link")
            require("\\" not in target and not any(ord(c) < 32 or ord(c) == 127 for c in target), "Non-portable link")
            pending = name.split("/")
            resolved = []
            seen = set()
            while pending:
                part = pending.pop(0)
                if part in ("", "."):
                    continue
                if part == "..":
                    require(bool(resolved), "Escaping link")
                    resolved.pop()
                    continue
                candidate = "/".join(resolved + [part])
                require(candidate in self.entries, "Dangling link")
                entry_kind, entry_target = self.entries[candidate]
                if entry_kind == "symlink":
                    key = (candidate, tuple(pending))
                    require(key not in seen and len(seen) < 40, "Link cycle/limit")
                    seen.add(key)
                    # Every target is validated before any filesystem access (none is needed).
                    require(isinstance(entry_target, str) and entry_target and not entry_target.startswith("/") and "\\" not in entry_target and not re.match(r"^[A-Za-z]:", entry_target), "Invalid chained link")
                    pending = entry_target.split("/") + pending
                else:
                    require(not pending or entry_kind == "directory", "Non-directory link component")
                    resolved.append(part)
            destination = "/".join(resolved)
            result.append({"path": name, "target": target, "resolved": destination, "resolvedType": self.entries[destination][0]})
        require(len(result) <= 10000, "Link count limit")
        return sorted(result, key=lambda x: js_sort_key(x["path"]))

    def verify(self, head, platform):
        require(self.manifest is not None, "Missing manifest")
        manifest = json.loads(self.manifest.decode("utf-8"))
        require(manifest.get("integrityVersion") == 1, "Unsupported manifest")
        require(manifest.get("head") == head, "Wrong build head")
        require(manifest.get("platform") == platform, "Wrong platform")
        require(manifest.get("arch") in ("x64", "arm64"), "Unsupported architecture")
        for name in self.entries:
            parts = name.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                require(self.entries.get("/".join(parts[:i]), (None,))[0] == "directory", "Missing/non-directory parent")
        links = self.links()
        hashes = {k: v for k, v in self.hashes.items() if k != "build-manifest.json"}
        for link in links:
            require(link["resolved"] != "build-manifest.json", "Link targets manifest")
            if link["resolvedType"] == "file":
                hashes[link["path"]] = self.hashes[link["resolved"]]
        files = [{"path": k, "sha256": hashes[k]} for k in sorted(hashes, key=js_sort_key)]
        require(manifest.get("files") == files and manifest.get("links") == links, "Complete manifest mismatch")
        executable = {"linux": "LocalAPI", "darwin": "LocalAPI.app/Contents/MacOS/Electron", "win32": "LocalAPI.exe"}[platform]
        require(self.entries.get(executable, (None,))[0] == "file", "Missing regular launcher")
        if platform != "win32":
            require(self.modes[executable] & 0o111, "Launcher lost executable mode")
        app = "LocalAPI.app/Contents/Resources/app/" if platform == "darwin" else "resources/app/"
        for filename in ("package.json", "desktop/main.mjs", "src/runtime.mjs", "public/app.js"):
            require(self.entries.get(app + filename, (None,))[0] == "file", "Missing application entrypoint")
        return {"head": head, "platform": platform, "arch": manifest["arch"], "files": len(files), "links": len(links), "bytes": self.total}


def inventory_directory(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), "Invalid package directory")
    require(not (getattr(root.lstat(), "st_file_attributes", 0) & 0x400), "Windows reparse root")
    result = Inventory()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            st = path.lstat()
            require(not (getattr(st, "st_file_attributes", 0) & 0x400), "Windows reparse entry")
            relative = path.relative_to(root).as_posix()
            if stat.S_ISLNK(st.st_mode):
                result.add(relative, "symlink", st.st_mode, target=os.readlink(path))
            elif stat.S_ISDIR(st.st_mode):
                result.add(relative, "directory", st.st_mode)
            else:
                require(stat.S_ISREG(st.st_mode), "Non-regular package entry")
                with path.open("rb") as source:
                    result.add(relative, "file", st.st_mode, source, st.st_size)
    return result


class BoundedArchiveReader:
    """Count decompressed bytes, including metadata and trailing padding."""
    def __init__(self, source):
        self.source = source
        self.used = 0

    def read(self, size):
        require(size >= 0, "Archive read limit")
        # Read at most one byte beyond the remaining allowance to detect overflow.
        data = self.source.read(min(size, MAX_BYTES - self.used + 1))
        self.used += len(data)
        require(self.used <= MAX_BYTES, "Decompressed archive byte limit")
        return data


class BoundedTarInfo(tarfile.TarInfo):
    # tarfile processes extension headers before yielding members. Bound those
    # allocations as well as the complete stream; CI pins Python 3.12.
    def _proc_member(self, archive):
        metadata = (tarfile.XHDTYPE, tarfile.XGLTYPE,
                    tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)
        allowed = (tarfile.REGTYPE, tarfile.AREGTYPE,
                   tarfile.DIRTYPE, tarfile.SYMTYPE)
        require(self.type in metadata + allowed, "Unsupported tar header")
        if self.type in metadata:
            require(0 <= self.size <= 1024 * 1024, "Tar metadata size limit")
        return super()._proc_member(archive)


def inventory_archive(archive):
    result = Inventory()
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
                require(name.startswith("LocalAPI/"), "Unexpected archive root")
                relative = name[len("LocalAPI/"):]
                kind = "file" if item.isfile() else "directory" if item.isdir() else "symlink" if item.issym() else "unsupported"
                result.add(relative, kind, item.mode, package.extractfile(item) if item.isfile() else None, item.size, item.linkname)
        # Read the gzip trailer too: tar's end marker alone does not verify its CRC.
        while stream.read(1024 * 1024):
            pass
    require(root_seen, "Missing archive root")
    return result


def verify_download(root, platform, head):
    require(bool(re.fullmatch(r"[0-9a-f]{40}", head)), "Expected exact commit")
    root = Path(root)
    if platform == "win32":
        require(sorted(p.name for p in root.iterdir()) == ["LocalAPI"], "Unexpected download contents")
        return inventory_directory(root / "LocalAPI").verify(head, platform)
    archive = "LocalAPI-" + {"linux": "Linux", "darwin": "macOS"}[platform] + ".tar.gz"
    require(sorted(p.name for p in root.iterdir()) == ["LocalAPI", archive], "Unexpected download contents")
    outside = root / "LocalAPI" / "build-manifest.json"
    require(not (root / "LocalAPI").is_symlink() and not outside.is_symlink(), "Manifest link")
    require(sorted(p.name for p in outside.parent.iterdir()) == ["build-manifest.json"], "Unexpected metadata")
    require(stat.S_ISREG(outside.stat().st_mode), "Manifest not regular")
    require(outside.stat().st_size <= MAX_MANIFEST, "Manifest size limit")
    require(not (root / archive).is_symlink(), "Archive link")
    require(stat.S_ISREG((root / archive).stat().st_mode), "Archive not regular")
    inventory = inventory_archive(root / archive)
    require(outside.read_bytes() == inventory.manifest, "Outer/inner manifest mismatch")
    return inventory.verify(head, platform)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("--platform", choices=("linux", "darwin", "win32"), required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args()
    print("DOWNLOADED_PORTABLE_INTEGRITY_PASS " + json.dumps(verify_download(args.directory, args.platform, args.head), sort_keys=True))
