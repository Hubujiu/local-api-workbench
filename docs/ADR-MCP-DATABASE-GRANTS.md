# MCP-only ephemeral readonly database grants

This backend-only feature stacks on the native database task feature (PR #9).
It does not merge/deploy either branch or add frontend controls. Manual HTTP,
CLI invocation and MCP database sessions remain separate authority domains.

## Explicit grant lifecycle

The local-token/Origin-protected endpoint
`/api/projects/:projectId/mcp-database-connections` supports GET/POST/DELETE.
The current MCP configuration must be enabled with write+execute and include the
project. POST accepts only bounded connection fields plus name and optional
native bindingId; write, remember and unknown grant options reject. A native
binding must match the current project's imported resource/type. No MCP tool can
create its own grant. The MCP bearer token is not the local administrative token.

The returned/listed metadata contains no connection settings. Connection settings
stay in memory only and are discarded on revoke, every successful MCP config
update (including project changes, token rotation and disable), or server close.
Remembering MCP configuration does not remember database grants. These are
process-session grants, not time-expiring or persistent grants. They do not
inherit the manual debugger's connections or authorize the manual debugger.

Each incoming grant request captures a generation before asynchronous body/store
reads. A config change during a streamed request rejects that stale registration.
MCP query callbacks also capture the authenticated generation. In-flight query
results are discarded after revoke/config change; prior completed reads are not
erased retroactively. Provider error messages are not stored: only a generic
readonly-query failure with a bounded recognized error code survives, avoiding
connection paths/usernames/credentials in execution history.

## Execution and evidence

Both saved-plan and saved-API MCP execution reuse the existing native/legacy
runPlan pipeline. The official MCP SDK exercises real HTTP transport, real SQLite
and an independently disposable PostgreSQL service. PostgreSQL coverage starts
with independently authored native project import and explicit alias binding.
It validates query -> script -> actual HTTP -> post assertion -> persisted run,
manual/MCP separation, token/Origin/field/project guards, stale-body generation,
revocation, explicit regrant, rotation, allowed-project changes and restart.
The existing manual-grant non-inheritance regression remains unchanged and passes.

No script/SQL/network limits are increased. The database driver still enforces
readonly queries and bounded output. No new dependencies or original proprietary
implementation are used. CI must pass for this exact feature commit before it is
accepted. HTTP MCP is covered; stdio MCP intentionally receives no implicit
process-session database resolver or persisted credentials.

Native requiresSSH is enforced at MCP registration and through the shared session
resolver before querying and before applying results. Session UUID aliases retain
that binding policy; changing/removing the current source cannot reuse an older
direct grant. The requirement does not create authority or import credentials.
Real PG/MySQL SSH+SDK fixtures are staged in the existing dedicated CI suite;
acceptance requires the exact new head and the cross-feature combined run.

## Explicit stdio startup grants (work in progress)

Stdio can opt in with one owner-supplied `--database-grants-file PATH`, together
with explicit `--project ID`, `--write` and `--execute`. The file envelope is
`{ "version": 1, "projects": [{ "projectId": "ID", "databaseConnections": { "alias": { "type": "sqlite", "filename": "/owner/fixture.db" } } }] }`.
Connection fields follow the CLI mapping; native aliases must match the current
imported binding and provider. There is no model-callable grant tool, credential
environment fallback, automatic generated MCP config change, or imported-secret
reuse. Startup reads a bounded, strict UTF-8 JSON snapshot once from a verified
regular file; ambiguous/invalid arguments and files fail before protocol service
with redacted stderr. POSIX files must be owner-only; Windows mode bits are not
claimed to enforce an equivalent ACL.

The initial project allowlist is copied independently from the dispatcher's
session-created project list. Connections remain process-local and do not share
HTTP MCP or manual-debugger grants. Editing or removing the file does NOT revoke
an already loaded snapshot. Ending the process clears it; starting again without
the option denies database work, while supplying the option again explicitly
regrants. Protect the file outside the project directory and remove it yourself
when no longer needed. The software neither creates real credentials nor deletes,
rewrites or changes permissions of an owner's file. Readonly access is to the
configured database, not a single query/table: use a trusted least-privilege role.

The shared PR #18 PostgreSQL factory is inherited through PR #9, so explicit
identity/TLS behavior is enforced by the transport, not just this JSON validator.
The isolated PR #10 transport remains sequential: notification cancellation and
EOF interruption belong to PR #19 and need the combined regression separately.
No hard-kill durability or remote-database transaction rollback is promised.
Local real SQLite official-SDK tests cover DB -> script -> HTTP -> assertions ->
saved runs, two-project isolation, file mutation, no-file restart, explicit
regrant and redacted startup failure. Native real-server and exact-head CI
validation are pending for this checkpoint; this is not complete delivery.
