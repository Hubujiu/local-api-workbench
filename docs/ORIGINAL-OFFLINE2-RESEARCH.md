# Original Offline2 package: interoperability research

Research date: 2026-10-19. This is static evidence, **not** a successfully
exported project or an end-to-end migration result.

## Provenance

- Official manifest: https://offline.apipost.net/downloads/manifest.json
- Official package: https://cdn-offline.apipost.net/dl/2.0.0/Apipost-offline_linux_x64_2.0.0.deb
- Version: 2.0.0, Linux amd64; 92,918,672 bytes, matching manifest size.
- Locally computed SHA-256:
  `7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
  The manifest supplies no checksum; this identifies the inspected bytes but
  is not an independent vendor signature verification.

The package was extracted without installation or post-install scripts. Normal
startup failed at Electron's process-singleton socket creation with
`Operation not permitted`. No sandbox disabling, OS permission changes,
activation bypass or alternate execution route was used.

## Observed format boundaries

The packaged renderer's export screen offers Apipost JSON, OpenAPI and Postman
paths. Its Apipost selection/filter path references top-level `apis`, `models`,
`samples`, `automated_testings`, and `global.envs`. That shape is not the old
public swagger2apipost fixture (`project`, `apis`, `env`, `dataModel`) already
covered by our importer.

Static reference locations in `resources/app/build/work.asar`:

- `3011.0b79d308758f.js`: export screen and JSON serialization route.
- `index-0d1d8198fa5a.js`, module 258928: export selection and dependencies.
- `1071.070e1ac6a263.js`: import screen.

The preload bridge also exposes project-scoped reads/writes. Renderer literals
include `project.json`, `global_vars.json`, `global_params.json`, and separate
history/trash/execution files. These names do **not** establish the on-disk
serialization or prove that one JSON file contains the whole project. The
underlying file service is compiled; it was not executed or decompiled.

## Safe current behavior

The legacy importer rejects documents with any `global`, `models`, `samples`
or `automated_testings` marker, even when empty. Previously, an overlapping
`apis` array could enter the legacy importer while those dependencies were
silently omitted. Regression tests cover bare/wrapped input and atomic project
preservation on rejection. The cases are synthetic format-marker tests, never
labelled genuine native exports.

OpenAPI/Postman are intermediate API-transfer options, not lossless replacements
for native test plans, global settings or project resources. Preserve the source
project and export until a real migration has been verified.

## Still required for native support

1. Obtain a real export from an unmodified original application containing only
   fictional APIs, variables, folders, schemas, samples and test plans.
2. Record exact version and export choices; check dependencies and identifiers.
3. Map supported fields explicitly and reject unsupported dependencies before
   modifying the destination project.
4. Verify equivalent request construction and test-plan outcomes against local
   fixtures, plus cancellation and failure atomicity.

No proprietary source code, package binary or branded asset is included in this
repository. Observed field names are used only to define compatibility limits.

## 2026-10-20 additional evidence

Public Apipost ecosystem exports were found independently (pinned links in ADR-MODERN-APIPOST-IMPORT.md). The global/apis/models/samples/automated_testings markers are shared modern interchange fields, not exclusive proof of Offline2 native provenance. A strict complete-envelope adapter now maps the supported HTTP/environment subset, while incomplete marker-only inputs and unsupported dependencies still reject before mutation. Original native-directory validation remains distinct; the public exports are never labeled as native Offline2 samples.
