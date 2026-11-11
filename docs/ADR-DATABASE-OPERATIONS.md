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

The first editor-browser run (496568b / Actions39638980888) read the old hidden dialog field immediately after reopening asynchronously and observed the rejected draft `{}` instead of the saved `[]`. The preserved trace shows inputValue occurring before the new dialog rendered; the failure screenshot already shows the restored `[]`. The fixed test waits for actual hidden→visible dialog transitions before asserting, including the expired-connection path. It retains the exact cancellation/value assertions and original timeout; no production rollback rule or data assertion is relaxed.

## SQL text Unicode fidelity

PostgreSQL, MySQL and SQLite SQL source text must be well-formed Unicode.
Unpaired surrogate code units reject before remote transport, SQLite process
creation or MySQL write-slot admission. Direct synchronous SQLite and exported
write validators retain the same guard. Declarative native database tasks and
plan binding validation also reject malformed literal query text before execution.
No replacement or normalization is performed; valid Chinese, surrogate pairs and
literal U+FFFD retain their existing meaning. Errors do not echo SQL text.

This prevents drivers from silently replacing a literal or identifier with
U+FFFD before execution. Loopback PG/MySQL protocol fixtures verify wire intent
and acknowledgements, not database-engine commit durability. A separate temporary
SQLite file verifies actual stored values. Existing SQL subsets, parameter rules,
limits, budgets, write approval and unknown-outcome/no-replay behavior are unchanged.
There is no stored-format change, migration or reconstruction of previously
replaced characters. This slice does not cover ClickHouse's independent query
path or expand PostgreSQL/MySQL connection-parameter validation.

## MySQL read port admission

Direct MySQL reads accept integer numbers in 1..65535 or decimal digit strings
in that range (including leading zeros). Missing/undefined, numeric zero, empty
string and decimal zero strings retain the previous direct-read default 3306.
Explicit null, booleans, arrays/objects, non-finite numbers, fractional numbers,
out-of-range values and nondecimal string syntax reject before direct or SSH
transport construction. In particular, UI Number conversion followed by JSON
serialization turns invalid numeric text into null; it must not silently choose 3306. The frontend is unchanged and this does not recover original text after
it has already become a valid number. For example UI inputs `3.306e3` or `0xcea`
become the valid integer 3306 before the backend sees them, so this fix does not
reject their original UI syntax. Direct API string inputs retain their spelling
and those nondecimal syntaxes are rejected; not all invalid-looking UI text can
be distinguished after numeric conversion.

PostgreSQL, MySQL session registration and MySQL write contracts are unchanged.
This does not extend direct-read default sentinels to SSH: SSH continues to reject
its previously unsupported zero/empty inputs. Inputs accepted by both direct
and SSH paths retain the same nonzero numeric destination. No fallback, retry,
new permission, saved-config migration or previous-query reconstruction is added.

### UI 参数 JSON 的数值保真边界

直查询与前/后置数据库操作参数编辑器在解析 JSON 时递归拒绝非有限数值及不安全整数，且在确认写入、更新操作配置和发送之前报错，避免 JSON.stringify 将溢出数值静默转成 null。合法 null、字符串和有限小数不变；Redis/MongoDB 直查询仍传原始查询 JSON 字符串，由后端原有规则校验。此检查不改变各数据库支持的参数结构。

该检查不能识别 JSON 数字解析时已发生的小数舍入或下溢（例如 1e-400 已变成 0），也不承诺原始数字字面量保真。需要精确十进制或大整数时应使用数据库支持的字符串或精确类型表达。既有已保存或写入的 null 无法由本修复恢复。
