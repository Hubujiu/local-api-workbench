# Session-granted database pre/post operations

## Reference and scope

The [Apipost database-operation guide](https://wiki.apipost.cn/docs/http_debug/database/) describes queries before/after requests, variables derived from results, and response comparisons. It also documents additional providers and writes/multiple statements. This implementation adds the read-only pipeline subset, not all of those features or proof of exact Offline2 ordering.

## Explicit access boundary

On the database page, the user can explicitly register the entered connection as a project-bound session connection. The confirmation explains that result data can enter request parameters, HTTP traffic, variables and history. Credentials/configuration remain in application-process memory, not project files, snapshots or exports. Listing returns only a random identifier, label and provider. Up to20 connections per process; explicit revocation and process shutdown remove grants. Loading/importing a project never creates a connection grant.

Only authenticated local UI debug/case execution and manually run plans receive the project-bound resolver. MCP, CLI and load execution do not acquire it and fail explicitly for an enabled database operation. A copied identifier from another project fails. Revocation during a query discards the result; it does not claim to undo effects of database functions. Reopening the application requires recreating the connection and rebinding operations. This is intentionally not a persistent password vault.

## Execution contract

A declarative `database` operation references connectionId, literal sql, positional parameters, a JSON result path, and an output runtime-variable name. Parameters support the existing variable substitution; SQL/connection endpoints are not interpolated. Providers reuse the existing SQLite/PostgreSQL/MySQL/Redis/MongoDB read-only query boundaries. Explicit SQLite DML from the standalone query page is NOT available to these operations.

Before-operations execute in list order before pre-JavaScript and HTTP. After-operations execute after response extraction and before post-JavaScript. Thus a query can supply request parameters or post-script comparison data. This is this tool's documented ordering, not arbitrary interleaving or a claim about every vendor ordering. Each phase allows up to5 enabled database operations and a10second cumulative deadline, separate from unchanged JavaScript budgets. Existing provider connection/query timeouts apply; cancellation prevents subsequent requests and result application, but cannot guarantee instant interruption of a native call.

Each result is capped at1MiB before variable application. Invalid/missing result paths fail rather than set undefined; failed pre-operations prevent HTTP. Result variables and evidence can be sensitive and need review before export/sharing. Only trusted databases should be connected: a read-only transaction cannot guarantee arbitrary database functions have no external side effects.

## Fixed verification

`database-operations.test.mjs`: real temporary SQLite files, cross-project denial, metadata redaction/no credential persistence, write rejection, revoke-during-query, pre-request input/header and post-response assertions, no resolver/no HTTP, cancellation, token/origin boundaries and real local HTTP debug integration.

`ui-smoke.mjs`: register a temporary fixture connection through the confirmation, add a pre-operation, execute HTTP with its extracted header, inspect result, then revoke through the connection manager. Screenshot local-api-database-operation.png. Current exact-head CI determines completion of browser and platform verification.

## Editing and reconnecting

The operation list exposes database editing/rebinding, enable/disable, movement and removal. Edits preserve bindings and disabled state; invalid input/Cancel leaves the operation unchanged. An expired connection is shown as unselected and requires an explicit choice, never automatic rebinding by name. Async dialog opening checks project/request/phase, modal revision and the original operation fingerprint; repeated clicks cannot replace an in-progress edit with a late reply. Reordering affects only the current request, not saved plan/case snapshots. Enable/disable does not clear earlier runtime variable values.

The browser acceptance adds invalid-edit/cancel/reopen, parameter binding edit, reordering, toggling, canceled/accepted removal, revoke→failed execution→new connection→explicit rebind→successful HTTP. The prior generic JSON editor remains available for non-database operations and complete configuration.
