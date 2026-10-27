# SQL Server read contract — driver WIP, NOT provider support

This independent branch starts at develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3`.
No HTTP/MCP/stdio/CLI provider allowlist is changed. An independent internal
Tedious port is now implemented but is NOT registered or used as a default
factory. It could connect only if explicitly invoked; no real connection has
been attempted in this work.
Microsoft SQL Server 2022 Developer EULA confirmation is still pending. No
service, image, ACCEPT_EULA setting or automatic SQL Server CI is introduced.

## Implemented inert contract

- Reuse the existing pinned Apache-2.0 node-sql-parser 5.4.0 TransactSQL parser. A strict
  AST whitelist reconstructs SQL; input text is never an execution payload.
- Only one local `schema.table` SELECT, explicit unqualified columns/aliases,
  AND comparisons to @pN, simple column ordering. First slice intentionally
  requires bounded bare ASCII identifiers; quoted identifiers, comments,
  literals, functions, casts, joins, WITH, INTO, set operations, hints, batches,
  external names and unknown AST fields reject. TOP(1001) is backend generated.
- Parameters are bound plans, not interpolation: null, strings, bool, int32,
  explicit signed int64 decimal strings. Unsupported fractional/unsafe numeric
  parameters reject rather than round. Dense data-only arrays, 1000 parameter
  and 1 MiB parameter payload bounds. SQL <= 50000 UTF-8 bytes.
- Credentials are explicit per call. SQL username/password only; no ambient or
  Azure fallback. TLS must be explicit, encrypt true / trustServerCertificate
  false; bounded CA is allowed, unknown driver options reject. Retry count zero.
- Result policy rejects DECIMAL/NUMERIC/MONEY, temporal, floating, Variant, UDT,
  XML and unknown types. Tedious's number/Date conversion is not lossless for
  all such values. Future exact text projection needs its own verified contract;
  this first compiler does not permit CAST to silently truncate text.

## Adapter obligations (implementation present; real-service verification pending)

Before user SQL, a fixed internal query must check the actual connected database
is READ_ONLY (DATABASEPROPERTYEX Updateability), rejecting READ_WRITE/null or
unexpected response. ApplicationIntent/readOnlyIntent is routing, NOT a read-only
security boundary. Do not automatically redirect to another host. Server-side
read-only state is an administrator-controlled prerequisite, not a guarantee
against a malicious server/admin changing state. Only reconstructed SQL may run.

Each invocation owns its connection/request. Check cancellation before connect,
after connect, after the fixed prerequisite query and before user execution;
abort must prevent subsequent phases and close owned transport, await closure,
release capacity, and never replay/retry SQL. Late callbacks cannot turn abort
into success. Keep current 3s connect / 2s query deadlines; cancellation must be
bounded without assuming driver cancel acknowledgement always arrives. Result
metadata must be checked before exposing rows, one result set only, unique column
names, <=1000 rows plus truncation sentinel, <=1MiB serialized result; aggregate
failure returns no partial success. Driver-internal large value buffering needs
explicit handling before claiming a memory bound, not just row-event accounting.

Future grant registration must reuse project/session scoped capabilities,
revocation, TTL/query counts and stdio/CLI invocation grants; credentials must not
enter definitions, saved results or backup. No grants are added in this stage.

## Historical compiler-only evidence and limitations

The three ordinary unit tests exercise reconstruction, forbidden SQL/parameters,
explicit connection configuration and metadata rejection only. They do not load
Tedious, open a SQL Server connection, verify TLS on wire, or prove database
read-only/cancellation behavior. Full independent driver and real SQL Server
end-to-end verification remains pending; fake-driver tests cannot replace it.

Official references checked read-only:
- https://github.com/tediousjs/tedious/blob/master/LICENSE (MIT)
- https://tediousjs.github.io/tedious/api-connection.html
- https://tediousjs.github.io/tedious/api-request.html
- https://tediousjs.github.io/tedious/api-datatypes.html
- https://learn.microsoft.com/en-us/sql/t-sql/functions/databasepropertyex-transact-sql
- https://learn.microsoft.com/en-us/sql/database-engine/availability-groups/windows/configure-read-only-routing-for-an-availability-group-sql-server

A fresh worktree npm ci --ignore-scripts used its exact unchanged lock, not shared
node_modules. Offline install lacked cached zod-to-json-schema; normal install
succeeded. No new package/version or lock modification was needed for this stage.

## Historical injected adapter state-machine stage (before installed transport)

`runSQLServerReadWIP` requires an explicitly injected unconnected port. No default
factory exists, so calling it cannot discover/start a driver. The port contract
is exercised only with fake transports: ordered READ_ONLY probe then rebuilt
query, exact bigint/text/basic values, one-result metadata, row/byte rejection,
abort before/during connect/prerequisite/user query, ignored late callbacks,
single destroy and confirmed-close before success, redacted failure. These tests
do not prove Tedious wire behavior or SQL Server semantics. A real adapter,
precise driver version/license/lock, cancellation transport ownership and real
server validation still remain. SQL Server EULA remains pending.

License correction: the baseline node-sql-parser 5.4.0 package reports Apache-2.0
and contains that LICENSE; the first PR stage incorrectly called this parser MIT.
Tedious itself is MIT. No parser code was copied and no dependency was added.


## Real Tedious port implementation — unverified WIP

`src/sqlserver-tedious-wip.mjs` imports official npm `tedious@20.3.8` (MIT;
installed LICENSE inspected). Exact package/version and transitive graph are
recorded in package-lock.json. The existing runner still requires explicit
factory injection; no provider, capability grant, HTTP, MCP, CLI, GUI, service,
Docker image, EULA acceptance, deployment or SQL Server CI was introduced.

The port uses real Connection / Request / TYPES, verified TLS with the configured
host and optional CA, explicit SQL authentication, and parameters bound via
addParameter. Nullable IntN/BitN metadata is mapped to exact scalar types; int64
results remain decimal strings. No Azure/integrated credential path is selected.

Pinned driver source review found that routing can reconnect automatically and
that driver `end` can precede the owned socket's actual `close`. Accordingly:

- A documented custom connector allocates one Node Socket, fixes the original
  host/port in a private closure and disables address-family fallback. A second
  connector call rejects before allocation/DNS/network, independent of routing
  events. `retry`/`rerouting` also stop the port. No pool, replay or SSH is used.
- Verified TLS and an exact databaseChange receipt must precede connect success.
  The existing fixed DATABASEPROPERTYEX probe and rebuilt SELECT then run on that
  same connection. readOnlyIntent is false; it is not a security control.
- Failure/abort settles the pending phase, cancels the active request once and
  closes the driver plus owned socket. Closure requires BOTH driver end and
  socket close, or explicitly rejects after 2.5 seconds; the runner publishes no
  success on a failed/unknown receipt. Connect/query deadlines remain 3s/2s.
- Request callback completion, error events, metadata and row events are mapped
  into the existing all-or-nothing collector. One metadata result set only;
  duplicate names, unsafe types, 1002nd row and >1MiB serialized output reject.
  DONE/DONEPROC/DONEINPROC are not counted as result sets because execSql uses
  sp_executesql. Unsupported output parameters reject.
- MAX/PLP, legacy LOB, invalid/oversized length metadata and unknown non-Unicode
  codepages reject rather than silently truncating values. Allowed text/binary
  columns have declared lengths <=8000 bytes. This is NOT a verified process
  memory bound: Tedious buffers TDS tokens/rows internally before application
  events, and hostile/large wire input remains an explicit acceptance gap.

Six new ordinary adapter tests inject only Connection/Request classes and replace
Node Socket.connect before running, so no DNS/TCP connection can occur. They
exercise mapping/parameters, probe ordering, routing's independent second-call
gate, cancellation/late callbacks, metadata rejection and closure deadlines.
One test constructs/closes the installed real driver without calling connect.
Together with seven existing compiler/port tests: 13 passed, no skips. These are
NOT real TDS, TLS/certificate, SQL read-only, server timeout or cancellation tests.

### Known dependency audit blocker (not waived)

The initial official dependency resolution installs @azure/identity 4.14.0 and
@azure/msal-node 6.0.1. `npm run audit:ci` currently FAILS with 2 HIGH entries
(identity and its msal-node dependency), GHSA-xcx6-jx8p-x3h5. The upstream advisory
lists a fix in msal-node >=7.1.0, outside identity's current ^6.0.0 range. No audit
suppression, forced major override or claimed compatibility is introduced. SQL
only authentication does not invoke that flow, but that is not an audit pass.
The branch stays WIP/disabled pending a compatible verified dependency solution
AND real SQL Server authorization/validation. Full CI for this new tree is pending.

Additional official references/source used:
- https://github.com/tediousjs/tedious/blob/v20.3.8/src/connection.ts
- https://github.com/tediousjs/tedious/blob/v20.3.8/src/value-parser.ts
- https://github.com/tediousjs/tedious/blob/v20.3.8/src/token/handler.ts
- https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5
