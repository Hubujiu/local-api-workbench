# Read-only database cancellation and owned transport lifetime

This slice is based on explicit PostgreSQL identity isolation (PR18). It does
not import the native/MCP/CLI feature branches or modify Mongo's implementation.
Their existing signal propagation is combined and verified separately.

## Contract

`queryRemoteDatabase(input, { signal })` now cancels PostgreSQL, MySQL, Redis and
ClickHouse reads. `querySQLiteBounded(filename, sql, parameters, { signal })`
passes cancellation to the existing SQLite process supervisor. Pre-aborted calls
open no connection/process. A cancellation error is distinct from a query timeout.
Each operation closes only its own resource, not another project's query or a
saved grant. Revocation still invalidates grants/results; it is not a new
all-active-I/O cancellation operation.

PostgreSQL receives a caller-owned unconnected `net.Socket` through its public
stream option and connects it itself. MySQL receives a caller-owned connecting
stream via public `config.stream`; the public core connection supplies a promise
wrapper, with an error listener installed before awaiting authentication.
Neither path reaches into driver-private transport state. They destroy the owned
transport and await its close, rather than relying on MySQL `destroy()` (currently
a graceful `end()`), an already-closed PG `end()`, or an abandoned Promise race.
TLS remains the driver's normal wrapper over that transport, with certificate
and hostname verification enabled. The existing explicit PG identity/startup
factory, precision parsers, parameters, read-only transactions and result limits
are retained.

After every awaited setup/driver operation, cancellation is checked before any
next command. This includes driver imports, SSH establishment, authentication,
BEGIN/SET/START and the user query. Destruction alone is insufficient: a Node
Socket can otherwise be reconnected by a late driver continuation. No retries,
KILL/admin SQL or invented server-side cancellation commands are added.

The caller adds an eight-second total deadline, retaining the SSH total bound;
connection/authentication has a three-second bound. Each SQL initialization and
query phase has a two-second deadline. In particular MySQL's existing execute
timeout does not cover PREPARE; the owned-stream deadline now does. Existing PG
server statement_timeout=2000, driver query_timeout=3000, MySQL connectTimeout=3000
remain set. SQL reads use only the owned two-second phase deadline, not mysql2's
redundant command timer (which survives forced disconnect in the installed driver
and delays process exit). The query budget is not increased. These deadlines
are not extensions or proof that a database engine stopped executing SQL.

SSH uses its public `sock` option with a caller-owned transport. The existing
five-connection process-wide lease is released only after transport close. Abort
also covers opening/forwarding, and late callbacks may not create/revive a DB
channel. The SHA256 host pin, TLS hostname restriction and no-direct-fallback
policy are unchanged. Existing write callers do not supply an abort signal.

Redis keeps its command whitelist/TLS/response bounds and checks state before
sending AUTH/SELECT/query continuations; abort destroys its owned socket.
ClickHouse uses the HTTP client's AbortSignal, existing five-second deadline,
strict TLS and bounded result reader, and waits for local request close.
SQLite read cancellation kills the existing process and waits for close; it does
not rely on Worker.terminate interrupting synchronous native SQLite. Its existing
two-second deadline remains. Mutating SQLite calls retain the separate uncertain
write-outcome contract and are not newly signal-cancellable.

The direct project HTTP database **read** endpoint aborts when the response peer
disconnects, with listener cleanup in finally. The write branch remains outside
this behavior. This direct inspection route has no persisted execution record by
existing design; it must not be described as creating a cancelled plan/history.

## Evidence and non-guarantees

Independent loopback protocol peers exercise the real pg/mysql2 clients, with
connection/handshake/SQL stages held independently. They are not database engines
and cannot prove remote statement termination or transaction rollback. Tests
observe actual peer closure, prevent delayed handshake/setup from producing a
later command, distinguish pre-abort zero I/O, keep another project's connection
alive, verify SSH pin/capacity, and observe an actual SQLite child exit. Existing
real-service PG/MySQL/SSH and TLS/precision suites must still run in CI.

Closing a client socket does not withdraw bytes already sent, guarantee remote
query termination, or establish rollback. No write is replayed. Native execution
layers already suppress late scope results and record interrupted DB tasks; they
may finish/persist before all asynchronous transport cleanup has completed.
Their integration acceptance must separately observe eventual actual socket or
process closure, rather than treating an SDK's local AbortError as that proof.
