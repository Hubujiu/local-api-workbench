# Native database task execution (work in progress)

This feature branch starts from develop. The backend phase executor and explicit
`nativeTasks` request/plan state are staged implementations, not acceptance of the
complete database migration feature. Native project import remains fail-closed.

## Observed behavior

Official Offline2 2.0.0 was exercised using a disposable local PostgreSQL 18.6
fixture, fictional connection settings, and a local HTTP echo receiver. A script
sets an environment variable; a database task selects a row and extracts
`$[0].value` into that variable; a following script observes both the new value
and a lexical constant declared before the database task. The final HTTP request
contains the database-derived value followed by the last script's suffix.
Consequently, splitting each script into a fresh sandbox or moving all database
operations before all scripts changes observed behavior. No proprietary source,
raw original project exports, database binaries or credentials are distributed.

## Stage 1 contract

`runNativeTaskPhase` executes ordered customScript/database tasks in one QuickJS
lexical scope. A host broker accepts only the prevalidated task at the next
expected index, using a caller-provided ephemeral database resolver. The sandbox
cannot supply SQL, connection settings, arbitrary result selectors or grants to
the broker. Importing a task is not authority to connect.

Limits remain unchanged: 250 ms active script budget, 2 s total wall deadline,
16 tasks, 64 KiB script source, at most five active database tasks, 256 KiB broker
result. This stage deliberately includes database wait in the existing 2 s wall
budget rather than silently raising script limits. Cancellation aborts the broker
and late results are not applied. SQL templates and writes are rejected; the
underlying DatabaseSessions/driver enforces readonly execution independently.
Results are checked completely before assignments, with own-property-only
single-value JSON paths. Connection settings remain exclusively in the existing
project-bound, revocable in-memory DatabaseSessions.

The current primitive supports explicit environment/global/temporary extraction
scopes; only environment extraction is matched to an actual native task sample.
Other native serialized scope names must be observed before importer mapping.

## Remaining work

- Strict native connection/task import, credential stripping and explicit rebinding.
- HTTP/MCP/CLI endpoint acceptance, source provenance and importer validation.
- Full imported-project persistence/restore and explicit grant rebinding.
- Native error-path and additional scope behavior observations.
- Complete cross-platform CI and MySQL mixed-phase service evidence.

Tests use independently authored fixtures and actual SQLite plus a local HTTP
server. The same mixed phase also passed locally against an independent disposable
PostgreSQL 18.6 instance, including actual HTTP output, immutable input, project
isolation and revoked-session rejection. The reusable test is wired into the
existing PostgreSQL/MySQL CI service job; MySQL remains pending until that job
passes. The original PostgreSQL experiment is separate research evidence. Neither
experiment constitutes acceptance of the still-unwired native project migration.

## Stage 2: explicit request/plan wiring

A versioned `nativeTasks` request field is preserved by normalization, frozen plan
snapshots, Store save/reload and project backup restore. It cannot coexist with
legacy operations/scripts or inherited shared scripts. All phases are validated
before plan effects. Before/after execution uses the existing explicit database
resolver, phase evidence and scope commits. Scripts cannot rewrite the frozen
task list for subsequent phases. Restoring a project does not recreate grants.
Real SQLite-to-HTTP tests verify live-request/snapshot separation, both phases,
round trips, denied foreign/restored projects, missing/revoked grants and atomic
preflight. This is not yet native connection/task import acceptance.

Original error-path observation: a missing PostgreSQL table logged an error but
continued the next script and HTTP request with the prior environment value.
Workbench intentionally fails closed instead; it will not silently send a request
with stale database-derived data. This compatibility difference must remain
explicit in import notes and is not a claim of exact failure-policy equivalence.
