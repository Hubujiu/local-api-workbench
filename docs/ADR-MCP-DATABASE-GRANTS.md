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
