# CLI invocation-scoped database grants

The existing CLI accepts an explicit --database-stdin option. Its bounded UTF-8 JSON envelope may contain databaseConnections keyed by enabled frozen database operation connectionId values, alongside existing protocol credential maps. The older --credentials-stdin option alone still rejects databaseConnections. Without either flag, stdin is not consumed and database execution remains ungranted.

Bindings must exactly match enabled database operations in enabled HTTP steps. Validate all configurations before any plan step, including earlier HTTP-only steps. This is configuration preflight, not full SQL validation. Explicit type and remote host/database are required; SQLite accepts only type and filename. Unknown fields, write authorization and persistent grant options are rejected. Existing DatabaseSessions validators, limits, TLS/SSH constraints and read-only query providers remain authoritative.

Each invocation creates new project-bound transient grants, remaps logical connection IDs privately, removes the database map from runner options and closes sessions in finally. Neither snapshots nor result configuration contains the connection map. Ordinary query values and remote errors remain execution evidence and may themselves contain sensitive data; this is not blanket redaction. Input files and pipe producers remain the caller's responsibility.

Verification uses an actual subprocess, database query, loopback HTTP, post-query assertion, persisted results reloaded through a new Store, no-grant subsequent run, explicit regrant, and invalid maps failing before earlier HTTP steps. PostgreSQL/MySQL fixtures use the same helper. Supported providers are not a claim of complete original database parity or original project migration. No frontend, write capability, persistent credential vault or automatic rebinding is added.

## Native ordered-task references

The invocation grant collector also recognizes enabled database references in
version-1 nativeTasks before/after arrays, validates their task type/enable state,
and requires the exact same stdin mapping. Disabled steps/tasks do not gain grants.
It never accepts bindingId/write settings or persists connection configuration.
This collector change belongs to the CLI feature; executing native tasks additionally
requires the separate native-task backend feature (PR #9), not this branch alone.
The reusable CLI subprocess contract has an explicit native mode that asserts the
runtime actually preserved native tasks before executing, avoiding a false green
from silently dropped tasks. Combined PostgreSQL verification covers query -> HTTP
-> post-query assertion -> persisted result, invalid grant preflight before earlier
HTTP, denied next invocation, and a fresh explicitly granted repeat.

### Imported engine binding

The CLI now receives the current project's safe imported database catalog. A
source-style binding ID must exist there and its engine must match the temporary
configuration, like HTTP/MCP registration. Native Redis/MySQL result-shape tags
also constrain manual task bindings before any connection. This is validation,
not a new grant or persisted configuration; credentials remain stdin-only.
