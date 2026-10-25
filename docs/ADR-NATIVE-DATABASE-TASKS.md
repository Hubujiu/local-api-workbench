# Native database task execution (work in progress)

This feature branch starts from develop. The backend phase executor and explicit
`nativeTasks` request/plan state are staged implementations, not acceptance of the
complete database migration feature. Native project import now accepts the explicitly bounded PostgreSQL subset below.

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

- Additional native database types, environment-specific connections and SSH import.
- MCP/CLI acceptance for native imported task references.
- Whole original-directory integration with the other feature PRs.
- Additional native connection/error-policy configurations.
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

## Stage 3: bounded native import and explicit HTTP rebinding

Modern native `global.db_link` accepts PostgreSQL (`pg`) definitions belonging to
the source project. Non-default environments must explicitly use the default;
active SSH, other engines, unknown fields and malformed definitions reject
atomically. The entire source connection catalog is bounded to 1 MiB. Only safe
resource identifiers, source identifiers, name and type survive import. Host,
port, database, user, password and SSH configuration are intentionally discarded,
with a request import note requiring manual ephemeral rebinding. No connection is
created by import, save, restore, startup or execution without an explicit grant.

Mixed enabled/disabled tasks retain order, IDs/names and inherited scope metadata.
Observed native extraction names are translated explicitly: `environment` to
environment, `globals` to global, and `variables` to request-temporary. Unknown
names remain rejected. SQL templates are rejected, not interpolated.
The existing readonly driver limits still apply, including bounded result rows.

POST database-connections can explicitly bind a current-project imported resource
to a new transient session using `bindingId`. The source/type must match the
project. Duplicate active binding rejects until revoke; cross-project lookup,
in-flight revocation, restart and restore never inherit authorization. HTTP debug
returns per-phase database evidence and saves it in history.

Local actual PostgreSQL18.6 acceptance covers synthetic native import -> save ->
unauthorized rejection -> token/origin/type checks -> explicit binding -> scripts
+ SELECT + HTTP + response assertion -> history -> revoke -> restart denial.
The same fixture runs in the existing CI PostgreSQL service job. SQLite verifies
canonical persistence/backup and alias mechanics separately; it is not presented
as native PostgreSQL wire acceptance. Raw original archives remain private.

## Cross-entrypoint authority checks

Official MCP SDK regression confirms that an execute-enabled MCP client cannot
inherit a manual HTTP database grant when running a saved native-task plan. The
plan records a failed result and sends no HTTP request; a manual HTTP execution
with its own explicit grant succeeds. Foreign projects remain denied. Native
MCP database granting itself remains unsupported, rather than implicitly widening
the existing MCP execute permission.

The CLI grant collector is updated in its own feature PR (#2), not duplicated
here. Combined actual PostgreSQL subprocess verification covers native ordered
tasks, persisted results, invalid-stdin preflight and per-invocation revocation.

## Result-scope verification

Original UI experiments confirmed `variables` is temporary: it overrides an
environment value for the actual request without changing the environment getter,
and disappears on the next request when the database task is disabled. `globals`
uses a separate global variable that remains available in a later request after
the database task is disabled. The source files contain these exact plural names;
we do not accept guessed singular canonical names in native input.

A real PostgreSQL HTTP acceptance fixture now checks all three destinations in
one query, temporary > environment > global precedence, temporary availability
in the same request post-script, reset on the next request, persisted environment
and global values, foreign-project isolation, backup/restore of the canonical
tasks/values, and denial of restored database grants. Inherited task flattening
keeps already-normalized scopes without attempting native translation twice.
