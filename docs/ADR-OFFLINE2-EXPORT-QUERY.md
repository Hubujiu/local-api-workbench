# Offline2 export query fidelity

## Original runtime evidence

On 2026-10-25, the unmodified official Apipost Offline 2.0.0 Linux package was
started normally on the isolated desktop with a fictional profile. No sandbox,
license or payment checks were disabled. The official DEB SHA-256 was
`7c66b8963960dd22a384072ecb714c9d8ba1164bb2ecd8f2d90d325fa3d83942`.
The normal trial UI created `Workbench Native Fixture` and `Native Echo`.

The committed `tests/fixtures/original-offline2/native-echo-original.json` is the
actual Apipost export produced by the UI, not a manually assembled native sample.
Only fictional request data were entered. It contains no application code,
installation binary, real credentials or brand artwork. The export selected one
API, zero models and the default environment. Native on-disk storage was separately
observed as project.json, apis/<id>.json, apis/index.json and envs/<id>.json; this
change does not implement a directory reader or claim full directory migration.

A real local HTTP server observed POST `/echo?fixture=original` with body
`{"message":"fictional","number":7}`. The export repeats `fixture=original` in
both the URL and request.query.parameter. Importing the unmodified export with
our existing importer then executing it sent the query twice. A failing real-HTTP
regression reproduced this mismatch, including after backup restore. Disabling
the original Query row removed the query from both the original URL and wire
request; no network requests were sent to third-party services.

## Independent fix

For modern Apipost imports only, strip mirrored URL query occurrences using the
source Query rows as a multiset. Preserve duplicate rows, unrelated raw query
bytes, fragments, relative/template URLs and existing queryAddEqual behavior.
Do not globally deduplicate ordinary Workbench requests: those may intentionally
contain both a literal URL parameter and an additional parameter row.

The regression uses the genuine export and changes only its destination port for
a disposable local server. It verifies import, source immutability, save/reload,
backup restore into a new project, and equivalent actual method/path/body.
Separate synthetic cases are explicitly labeled and cover repeated pairs,
percent encoding, blank values, disabled rows and independent raw query fields.

This is one verified Offline2 JSON-export workflow, not complete project/native
format roundtrip, all original modules, or re-export into the original format.
