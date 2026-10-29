# Portable package integrity

## Observed delivery defects

Read-only inspection of the actual three portable artifacts from root run
40792835331 (head d6ad0c9ba211302d9744e0af7cdc43435c704f89) found:

- Linux and macOS each contain five production `.bin` symlinks whose targets
  refer to the original CI runner's absolute `production/node_modules` tree.
  Those external paths were not opened during the audit. `fs.cp` without
  `verbatimSymlinks` rewrites relative targets; Electron's own copy already used
  that option, but the production dependency copy did not.
- macOS additionally contains fourteen legitimate relative framework links.
  They resolve within the package and must remain links, not be flattened.
- The Windows artifact ZIP omits 163 manifest-listed hidden paths, including
  fifteen `.bin` shim files. Direct directory upload excluded hidden entries;
  the Linux/macOS tar archives retained them. Desktop startup success did not
  establish that these distributable artifacts were complete.

These are packaging defects, not application protocol/runtime/security changes.
The older artifact evidence remains a failed delivery check, not replaced by
source inspection or pure fixture results.

## Copy, validate, sign, hash, verify, upload

Production dependencies and source directories use `verbatimSymlinks: true`
without dereferencing. Windows' ordinary shim files are copied as ordinary files;
no Unix links are manufactured, and no dependency is added.

The build inspects the Electron copy before modifying paths beneath it, and the
complete assembled package before chmod, PlistBuddy or codesign. A final graph
inspection runs after signing. `portableChecksums` independently validates before
hashing; the CI then verifies the complete manifest after desktop smoke and
before archive/upload. Existing audit and smoke checks remain intact.

Inspection walks `lstat` directory entries and reads link text, never descending
through symlinks. It builds a package-local graph and resolves each target one
component at a time, including symlink directory components and `..` after such
expansions. Absolute/drive/UNC targets, root escapes, dangling links, cycles,
non-directory intermediate components and unsupported entry types fail closed.
No external target is opened to decide whether a link is valid. Bounds are
100,000 entries, directory depth 128, 10,000 links, 4,096 target bytes and 40 link
expansions per resolution. Control/backslash entry names and control-containing targets are rejected.
On Unix a backslash in a target is rejected as non-portable; on Windows native
relative target separators are normalized only for graph traversal, retaining
the original target in the manifest. Absolute/drive/UNC checks apply first. These are build-artifact bounds, not application execution limits.

The staging tree is exclusively owned by this build and must be quiescent during
inspection/hash/verification. This is not a sandbox for an attacker concurrently
mutating directories. It does not claim race-proof filesystem confinement.

## Manifest version and completeness

`integrityVersion: 1` adds `links`, with the exact relative `path`, original
`target`, fully resolved in-package `resolved` path and `resolvedType`.
`files` now covers **all regular package files**, including Electron resources,
framework version contents and hidden dependency files, plus file-link paths
whose hash is the resolved regular target's bytes. Directory aliases are recorded
in `links`, not recursively traversed again. All lists are deterministic.

Hashes are streamed from resolved regular paths, not from link paths. The root
`build-manifest.json` is the sole excluded regular file because it cannot contain
its own digest. It must not be a symlink, a directory or any link's resolved target;
otherwise manifest regeneration could self-reference or overwrite another file.
Regenerating checksums with an existing ordinary manifest is stable.

`verify-portable.mjs` rechecks the graph and entire checksum inventory, then reads
the manifest with a 32 MiB bound and compares exact file/link records. Missing
hidden entries, altered bytes, extra package members and changed link targets
fail rather than silently reducing expected coverage. Consumers must use
`desktopLayout` or manifest platform to locate the executable, not assume that
only one manifest path exists outside `resources/app`.

Only the existing portable artifact upload enables `include-hidden-files: true`.
Its paths remain `dist/LocalAPI-<OS>.tar.gz` and the existing platform-selected
`dist/LocalAPI` / `dist/LocalAPI/build-manifest.json`; no workspace, source-root,
logs, environment files or credential directories are added. Metadata upload
scope is unchanged. The actual final ZIP/tar must still be independently audited:
pre-upload staging verification cannot prove what the upload service retained.

## Validation and limits

Pure temporary-file fixtures cover relocation after deleting the source tree,
all fourteen framework link shapes, directory aliases, Windows-style regular
shims/hidden files, omitted/changed/extra members, equal-content link-target
changes, self-manifest exclusion, absolute/intermediate escapes, dangling links,
cycles and chain limits. Static contracts preserve validation-before-signing and
the exact upload scope. No local app, installer, VM or database is run.

Exact-head normal CI packaging/smoke and independent read-only audit of its
actual three downloaded portable archives remain required before accepting this
repair as delivered. Source tests alone do not certify executability, signing,
Windows symlink privileges or the final archive contents. No deployment or merge
into main is authorized by this change.
