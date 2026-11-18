# MCP database authorization UI

The MCP settings page now provides a separate project-scoped temporary database
grant form and authoritative grant list. It reuses the existing HTTP
`mcp-database-connections` endpoint and `MCPDatabaseGrants` policy. It does not
reuse manual database sessions, enable MCP, add projects, or elevate policy.
All of enabled, project access, project write and plan execute must already be
explicitly enabled. Database queries remain read-only under existing validators;
project write permission is not SQL write permission.

Users enter a new independent configuration and explicitly confirm disclosure of
query results to MCP clients. The UI supports the six existing session providers,
optional source binding, TLS and pinned SSH configuration. It intentionally does
not advertise SQL Server, Oracle or Dameng until those providers are implemented.
SSH JSON uses a password input. Submitted values and confirmation are immediately
cleared; server lists render only name, type and opaque connection/binding IDs.
No connection settings enter project state, local storage, exports or logs.

Revocation submits the exact connection ID in the current project scope and
refreshes the authoritative list. Service authorization updates clear inputs and
invalidate pending display responses. Repeated submit/revoke clicks are blocked.
A failed or lost mutation response is never automatically replayed; the page
refreshes the list and asks users to reconcile it first. Provider error text is
not reflected because it can include connection secrets. Restart, token rotation
and service-policy changes retain the existing backend invalidation behavior.

Tests cover default denial, explicit confirmation, SQLite omission of inactive
remote credentials, safe field errors, metadata escaping, duplicate clicks,
uncertain mutation, revocation, policy changes and navigation interruption. The
existing real SQLite/official MCP SDK integration test remains the backend
cross-boundary verification; unit rendering tests are not a claim of browser or
all-provider native validation.

## Reapplying identical service settings

Every successful service configuration apply invalidates database grants, even
when its token and permission fields remain identical. The owner config response
now includes the non-secret numeric `databaseGrantEpoch`, and the UI includes it
in its authority fingerprint. Routine activity polling still preserves draft
credentials; an actual grant epoch change clears drafts and reloads grants.

The existing GitHub Actions browser smoke now invokes `exerciseMCPDatabaseUI`.
It creates a disposable Unicode-path SQLite fixture, checks default denial,
authorizes only the current project, submits an injection-shaped connection
label, verifies no DOM injection or retained password, simulates a failed revoke
request without deleting the grant, retries explicitly, and verifies reapplying
identical service settings empties both UI and backend grant lists. Its screenshot
is included by the existing `ui-evidence` artifact glob. This fixture is wired
for CI; local browser execution is blocked by the cloud sandbox's Chromium
ProcessSingleton socket restriction, so passing browser execution is still required.
