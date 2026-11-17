# SQL Server driver preparation (not a provider)

This change builds on the inert PR #126 contract at
53acffadde503e934751be14ca9495eb949aeac5 and reviews the previous PR #45
transport at 29a6ceeff2d32426d7d509a1f19da3767aee83e1. It adds internal,
unregistered transport preparation only. No HTTP, MCP, CLI, database session,
remote database dispatch or frontend registers SQL Server. The preparation
runner has no default driver factory. Importing the modules opens no connection.

## Dependency review

Tedious 20.3.8 is pinned exactly, with npm registry integrity hashes in the lock
file. Its upstream is https://github.com/tediousjs/tedious, not a Microsoft-owned
package. The package license is MIT (Mike D Pilsbury, 2010–2026); it requires
Node >=22, within this project's Node >=24 requirement. The added dependency
licenses in the lock file are MIT, BSD-3-Clause, Apache-2.0 and ISC, not uniformly
MIT. Azure identity/keyvault dependencies are upstream transitive dependencies;
this adapter allows only explicit SQL username/password authentication and does
not configure ambient Azure identity, browser authentication or key vault access.
All added resolved tarballs use https://registry.npmjs.org/; no override was
added. `npm ci --ignore-scripts` completed. An npm registry audit on 2026-11-05
reported zero vulnerabilities across 363 dependencies (304 production, 56 dev,
31 optional; these categories overlap). This is a point-in-time advisory audit,
not proof of absence of vulnerabilities or a full supply-chain security review.

## Ownership and cancellation

The runner snapshots explicit connection fields, asynchronously compiles the
existing bounded contract, rechecks cancellation, then creates an unconnected
port through the explicitly supplied internal factory. No credentials are logged
and driver errors are replaced with generic errors. The signal is intended to
carry the caller's cancellation or grant revocation. Existing DatabaseSessions
captures a grant, merges its abort signal and rechecks ownership before and after
remote execution; this change deliberately does not add SQL Server to that flow.
Actual project/grant ownership integration remains future work, not something
established by these isolated signal tests.

The transport uses one owned socket and one fixed target, with address-family
autoselection disabled. A second connector call, driver retry or reroute fails
without another connection attempt. No pool, reconnect or query replay exists.
Driver configuration requires encryption, certificate validation, the explicit
server name, TLS >=1.2 and the exact database, with fallback database and
read-only routing intent disabled. The driver must emit a successful secure event
and database confirmation before the adapter accepts connection completion.
These configuration/event checks are tested using fakes; they do not prove a
real certificate chain, hostname validation, TDS exchange or wire behavior.

Connect/query deadlines force cancellation and socket destruction, but do not
count as cleanup receipts. The low-level runner still waits for both driver end
and socket close; it never fabricates either receipt. The unregistered process
entrypoint now owns a separate child for each operation. That child's main
thread supervises a worker containing the fixed Tedious implementation. The
caller cannot choose a driver, worker URL, module, timeout or environment through
its request. Credentials travel only in IPC, never argv, environment or logs;
child stdin/stdout/stderr are ignored and ambient NODE_OPTIONS/credential-provider
environment is not inherited. No public provider invokes this preparation.

The parent admits at most two operations per module instance and never replaces
or replays a failed child. It snapshots and compiles before sending fixed config
and generated plan over IPC. The existing compiler/connect/query limits remain
2/3/2 seconds. New values are internal conservative defaults, not established
project-wide SQL Server limits: 10 seconds total including parent compilation,
500 milliseconds cleanup grace, and 1 second to receive an OS close receipt after
a forced termination request. The independent child watchdog caps its own
bootstrap lifetime at 10.5 seconds and kills itself on parent IPC loss; the parent
has the stricter invocation-wide deadline. These are timer budgets, not real-time
OS scheduling guarantees. V8 heap settings are not a total RSS sandbox.

State flow: compiling, starting, running, closing, then normal process closure
or forced termination. Normal success requires a bounded complete result, both
driver/socket receipts, worker exit and child close with exit code zero, plus a
final cancellation check. A late callback or result cannot revive a stopped
operation. Revocation while a result awaits cleanup discards the candidate.

If either cleanup receipt or worker exit is missing after the grace period, the
whole child is forcibly terminated. Only actual child close confirms this
process-level reclamation. The error code is
`SQLSERVER_PREP_FORCED_TERMINATION_CONFIRMED`, never normal-driver-close success;
its separate reason retains cancellation, total timeout or cleanup timeout.
Cooperative revocation returns `SQLSERVER_PREP_CANCELLED`. Other execution,
protocol, spawn and IPC failures have separate failure codes and never return
rows. Force-closing the client does not prove that server work or server-defined
side effects stopped.

If the OS does not confirm child closure within the final receipt budget, the
call returns `SQLSERVER_PREP_CLEANUP_UNCONFIRMED`. Ownership remains quarantined,
new executions in this module are blocked, and only a later actual close releases
that ownership. A kill request/return value is not evidence of reclaimed
resources. This bounds the caller's wait while honestly retaining the exceptional
unconfirmed-resource state. OS refusal or a stalled supervisor cannot be turned
into a universal bounded-reclamation guarantee.

## Query and result boundaries

Only the existing regenerated query and its narrow parameter types are used by
the runner. Parameters bind through Tedious TYPES: null/Unicode string as
NVarChar, boolean as Bit, int32 as Int and explicit decimal int64 string as
BigInt. A separate fixed READ_ONLY probe must succeed before generated SQL runs.
READ_ONLY and SELECT syntax are **not** universal side-effect guarantees. Login
triggers, views, synonyms, computed columns, row-level security functions,
external/CLR actions and remote dependencies still require independent review
and server restrictions. Do not connect this preparation to arbitrary databases.

The collector buffers internally and publishes only after successful query and
cleanup, with a final cancellation check. More than 1000 rows or a conservative
1 MiB serialized-result budget rejects the whole result, not a partial page.
Unknown/lossy types, MAX/LOB metadata, duplicate columns and multiple result sets
are rejected. Allowed result types are integer/bit, bounded text and binary;
decimal, money and temporal values need a future proven lossless projection.
These tests verify fake event/parameter contracts, not real driver encoding,
server object behavior or complete memory/RSS bounds.

## Verification and remaining prerequisites

Run `node --test --test-concurrency=1 tests/sqlserver-driver-prep.test.mjs tests/sqlserver-prep-process.test.mjs tests/sqlserver-read-contract.test.mjs`. Adapter tests
inject fake Connection, Request and Socket classes: no DNS, TCP listener, real
SQL database, SQL Server image or real TLS handshake is used. They exercise
explicit settings, parameter bindings, callback failures, cancellation races,
two independent cleanup receipts, deadlines, result limits and no replay.
Process tests generate temporary test-only copies with fixed fixture module URLs;
production modules have no request-selected test hook. Their real child processes
run only invented fake ports, including missing end/close receipts and a busy
worker. Tests verify OS exit (PID no longer exists), heartbeat cessation and no
live owned ChildProcess handle. Separate fake-child tests cover failed kill calls,
missing OS receipts, quarantine admission and late results. Linux execution was
tested here; Windows process/termination semantics remain unverified.

SQL Server 2022 Developer EULA approval remains unanswered. No SQL Server image
was started, no ACCEPT_EULA value was set and no agreement was accepted. Live
integration, TLS/wire validation, controlled least-privilege credentials,
reviewed server objects, cross-platform supervision validation and explicit provider
activation all remain separate work. This is not SQL Server feature completion.
