# SQL Server read contract — compiler WIP, NOT provider support

This independent branch starts at develop `88f70bb515c48b93536b28b7fe3ec780f2e150f3`.
No HTTP/MCP/stdio/CLI provider allowlist is changed. The module cannot connect to
SQL Server: no Tedious dependency or network adapter is installed/registered.
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

## Adapter obligations, not yet implemented/verified

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

## Evidence and limitations

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

## Injected adapter state-machine stage (still no installed transport)

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
