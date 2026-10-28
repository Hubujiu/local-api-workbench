# Oracle Thin read adapter — disabled WIP

## Status and scope

This is an unregistered backend implementation, **not usable Oracle provider
support**. No HTTP, DatabaseSessions, CLI, MCP, imported-project, script-task, or
frontend allowlist is changed. None of those production entrypoints imports the
new modules. `runOracleReadOwned()` is an internal development entrypoint only;
its injected factory/timers are test seams, never request-controlled settings.

The dependency is the official `oracledb` **26.0.0**, pinned in package.json and
package-lock.json. The published archive SHA-512 matches:

```
sha512-ywUqFidj/mPjRjfpOQdzcXT98lhiJzavPCbyPF9JYivcgrpHx7ENj4ZGQDclrpGXeozUBLc5BNXV7yj5qTMxDw==
```

It has no runtime npm dependencies. Oracle's package is dual Apache-2.0 OR
UPL-1.0; this project elects **Apache-2.0** for this use. Unmodified copies of the
published LICENSE, NOTICE, and THIRD_PARTY_LICENSES are retained under
`docs/licenses/oracledb/`. Distribution must retain these notices, including the
package's Node.js MIT notices. Thin mode requires no Oracle Client/Instant Client;
this implementation never calls `initOracleClient`, loads plugins, or uses pools.
Optional Thick binaries shipped in the npm archive are not used by this adapter.
Client licensing does not grant rights to run an Oracle server.

The dependency was added with package-lock-only and ignore-scripts: no local
Oracle driver installation, import, or database execution was used for this
slice. The CI-only import smoke test is deliberately skipped outside ordinary
GitHub Actions; it loads the package and checks version/Thin/constants without
creating a connection. This is not real database acceptance.

## Explicit connection contract

`oracle-read-config.mjs` requires host, numeric port, service, ordinary username,
password, SQL, and `ssl: true`. The host is an atomic DNS name or unscoped IP;
service and username use conservative ASCII token subsets. It generates one TCPS
Easy Connect string. SYS/SYSTEM, proxy usernames, raw descriptors, TNS aliases,
SID guessing, external/token/privileged authentication, wallets, CA file paths,
configuration-provider URLs, SSH, retry settings, and arbitrary driver options
are rejected. Quoted identifiers and scoped IPv6 are not supported in this WIP.

Only TCPS is attempted, with certificate verification left on,
`sslServerDNMatch: true`, `sslAllowWeakDNMatch: false`, explicit credentials,
`externalAuth: false`, and `retryCount: 0` for connection-attempt retries. That
option does not disable internal query-message re-execution (see below).
No failed TLS/auth connection falls back to plaintext, Thick mode, another
account, or another endpoint. Real TLS
handshake, trust-store behavior and hostname/certificate negatives are unverified
against Oracle. mTLS and Oracle native network encryption remain unsupported here.

Standard trust remains the default. The optional `caCertificatePem` accepts
exactly one inline CERTIFICATE PEM, at most 16 KiB. It rejects CA paths, private
keys, additional blocks, surrounding garbage, malformed/noncanonical base64 and
trailing DER data. Public `crypto.X509Certificate` parsing must report `ca: true`
and a currently valid certificate; the accepted value is canonicalized with
`toString()`. No user certificate file is read or written. The parent validates
before allocating a child; the child validates the complete input again before
changing trust or importing the driver. The CA crosses only bounded IPC and is
never a driver option, argv value, environment variable or wallet.

When supplied, the fresh worker calls public
`tls.setDefaultCACertificates([canonicalCA])` before `loadDriver()`. This replaces,
rather than extends, its default CA list: this query trusts **only that CA**.
The parent's trust is untouched. The API is feature-detected (introduced in
Node 24.5.0 and backported to 22.19.0); missing API or a setter failure rejects
before driver import/network, without falling back to standard trust or
plaintext. The internal injected executor requires a matching worker-only
configured-CA marker, so calling it directly cannot silently ignore CA input.
This marker is an internal test/lifecycle option, never a request setting.
No CA means no call to the trust setter. These steps stay within the existing
three-second startup/auth and eight-second total budgets.

Pinned-driver source constructs its secure context with `ca`, `cert` and `key`
from the wallet; this contract never supplies a wallet. Use of the changed Node
default CA context when these values are undefined is a **source-based inference**,
not an Oracle TCPS acceptance result. A separate CI-only Node TLS loopback proof
uses that public undefined-wallet context pattern with the existing repository
certificate/key fixture. It checks trusted success, wrong-host and untrusted
failure, clean child closure and unchanged parent trust. It is not run locally
and is not an Oracle protocol, DN-matching or database test. No production/user
certificate or new account credentials are used.

The supervisor forks the fixed worker entry using the fixed `process.execPath`,
`env: { NODE_V8_COVERAGE: "" }`, `execArgv: []`, and ignored stdin/stdout/stderr
plus advanced IPC. The explicit empty coverage value is required: Node otherwise
propagates a nonempty parent `NODE_V8_COVERAGE` even with `env: {}`, allowing
child coverage/source-map output. This is not a copied caller value.
Neither credentials nor SQL enter argv, inherited environment, logs, errors,
connection-list output, or saved projects. Only canonical validated input fields
cross IPC; requests are capped at 2 MiB serialized and results at 1 MiB JSON.
A separate process avoids reusing a parent thread's Node startup TLS/debug
configuration. No parent environment is spread, including NODE_OPTIONS,
NODE_EXTRA_CA_CERTS, TNS_ADMIN, ORA_DEBUG_JDWP or NODE_ORACLEDB_DEBUG_PACKETS.
Electron execution is explicitly rejected until its fixed Node-mode launch and
packaging are verified. No application-created Windows environment fallback is
invented. The runtime/OS can nevertheless add startup metadata: pinned Node's
libuv Windows process code supplies HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH,
SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE and WINDIR when
available. Apple CF source can synthesize `__CF_USER_TEXT_ENCODING` on macOS.
Thus “no inherited credential/debug/TLS settings” is the intended boundary, not
the incorrect assertion that every platform's child has zero environment keys.
Windows metadata can contain profile/user/path information; no values are logged.

The fake-process tests temporarily poison parent sentinel, Oracle, TLS, Node
debug/coverage/cache variables around fork and restore every prior value before
returning. The child accepts only an explicitly empty coverage key and the exact
source-supported platform metadata above; unknown keys, sensitive settings and
arbitrary `NODE_*` keys fail the fixture. Tests check no coverage/cache files were
created in their disposable directory. A test-only fork factory changes only
stderr from ignored to a drained pipe, retaining at most 4 KiB for one validated
JSON record: platform, Node version, bounded key names/count, execArgv count,
sentinel presence and coverage-empty boolean. No environment values, argv,
connection options or raw errors are recorded; production stderr stays ignored
and no diagnostic message is added to its IPC protocol.

The first CI's Windows/macOS fake-process failures lacked these key observations.
The source-supported allowances do not prove a particular key caused those
earlier failures; new cross-platform CI must establish the actual runtime
metadata and lifecycle outcome. The independent coverage propagation gap is
fixed regardless of whether that first CI set the variable.

## Read and value contract

The injected executor requires a Thin driver and fresh Thin standalone
connection. It starts `SET TRANSACTION READ ONLY` with autocommit disabled,
then obtains public `getStatementInfo()` metadata and requires
`STMT_TYPE_SELECT`. Unknown/non-SELECT results never reach adapter submission of
user SQL to `execute()`. In the pinned 26.0.0 Thin classifier, `WITH` is a query
but retains `STMT_TYPE_UNKNOWN`; CTE/WITH queries are therefore unsupported and
remain rejected. No ad-hoc grammar rewrite bypasses that classification.
This is server/driver classification, not a homemade SQL grammar or rewritten
SELECT wrapper. It sends the same original SQL to `execute()` using explicit
BIND_IN descriptors. SELECT FOR UPDATE rejection relies on Oracle's real
read-only transaction and remains an actual-engine negative-test requirement.

**Read-only transactions are not a sandbox for arbitrary privileged accounts or
side-effecting functions.** Oracle excludes SYS from this transaction guarantee;
autonomous functions invoked from SELECT can commit independently. No regex,
client cancellation, rollback, or SELECT classification repairs that. Activation
requires an actual least-privileged account and review of accessible routines,
plus real negative tests. This slice does not create or grant any account.

SQL is limited to 50,000 characters; positional parameters to 1,000 entries and
1 MiB. The supported input types are null, text, finite JS numbers (no unsafe
integers), int64/BigInt and RAW/blob. Booleans, arbitrary arrays/objects and
user-supplied driver bind descriptors are rejected. Array binds use Oracle's
positional semantics; placeholder names are not rewritten, and applications must
account for repeated placeholders. Exact decimal input can be text with explicit
SQL conversion; no new decimal product format is introduced.

A per-execution fetch handler obtains NUMBER as text; no parseFloat, Number
coercion, or global driver setting is used. Metadata and fetched rows permit only
NUMBER, CHAR/VARCHAR/NCHAR/NVARCHAR and RAW. Date/time, JSON/OSON, LOB/LONG,
objects, nested cursors, vectors and unknown types fail closed; callers must
explicitly select a supported scalar. Describe metadata is checked before the
user query and rechecked afterward, but the driver can already have renamed
duplicate aliases there. During `execute()`, the public fetchTypeHandler receives
the original column and a second rowset-metadata argument. The adapter validates
those original names for uniqueness, dense column count and bounded Unicode,
then applies the existing per-column NUMBER conversion. It deliberately does not
type-check the whole raw rowset: later columns may not yet have normalized public
dbType properties. Original duplicate aliases are rejected before explicit
ResultSet fetching and result delivery, **not necessarily before server-side
query execution**. Names must also match the returned normalized metadata.
Results have 1–128 columns, at most 1,000 rows and a 1 MiB serialized ceiling. ResultSet fetches
one row at a time with prefetch disabled; a 1,001st row only detects truncation.
`maxRows` is not mistaken for a ResultSet bound. No partial result is returned on
conversion, size or cleanup failure.

## Owned lifetime, not a Promise race

`oracle-read-supervisor.mjs` owns one child per invocation. Pre-abort and invalid
input allocate no child. The initial three-second deadline includes startup,
driver loading and authentication; setup, classification, the entire fetch phase
and cleanup each have two-second phase bounds. An eight-second total deadline
starts before fork and remains active through process close. Phase messages may
not reset the initial connect budget or repeat/skip stages to manufacture
success. A result message is not completion.

Abort, deadline or worker failure sends SIGKILL only to that owned process and
waits for actual child `close`; kill acknowledgement, `exit` alone, and IPC
success do not settle the normal supervisor. The adapter never retries or
resubmits an operation; this is not a driver-wide exactly-once guarantee.
The worker also keeps an unref'ed eight-second watchdog and a parent-IPC-loss exit handler.
After sending a terminal message it unrefs, but does not disconnect, IPC so that
lingering handles remain subject to parent-loss detection. A cleanup deadline
withholds otherwise successful results if handles linger.

In ordinary completion/error paths the executor attempts ResultSet close,
rollback and connection close, even if an earlier cleanup step or phase reporter
throws. These waits remain inside the process deadline. Public `callTimeout` is
set to two seconds as a secondary per-round-trip guard; it is not the wall-clock
bound. There is no `break()`-only cancellation, abandoned Promise.race, private
socket access, server admin command, or adapter-level automatic retry.
Force-killing a client proves local process termination, **not** remote query termination or rollback.

## Driver-internal repeat boundary

Static inspection of the exact 26.0.0 archive found that
`lib/thin/protocol/messages/withData.js:118–122` requests a retry for query errors
ORA-00932 (inconsistent datatypes) and ORA-01007 (variable not in select list).
`lib/thin/protocol/protocol.js:291–298` then reprocesses the message. Consequently,
`retryCount: 0`, one adapter `execute()` call, a read-only transaction, and
`keepInStmtCache: false` must not be described as preventing every driver-internal
re-execution or guaranteeing exactly once. The adapter does not monkey-patch,
ignore, or bypass this driver behavior. Fixed error wording and fixture assertions
refer only to the adapter's own lack of retries/replays.

Before activation, this behavior requires an explicit decision and real-driver
negative/side-effect testing with the least-privileged account. It is particularly
important for SQL-callable autonomous or external-side-effect functions; client
rollback/termination does not undo such effects. Pure injected tests do not prove
the real driver's repeat behavior, and this WIP remains disabled.

## Evidence and activation prerequisites

Local tests use no real Oracle module/server or sockets. Pure tests cover strict
configuration, single-CA PEM boundaries/validity, scalar conversion/precision,
metadata and byte limits. Trust-loader tests inject a TLS facade to verify
validation/setup/import ordering, missing-API rejection and untouched standard
trust. A fake-driver child checks actual child-only default CA replacement with
no network and verifies that the parent trust list is unchanged. Injected
executor/supervisor tests cover classification, ordered guards, cancellation,
cleanup failures, malformed/late messages, deadlines, no adapter replay and
isolated ownership. A separate fake-driver child fixture verifies on Node 24/Linux:
natural process close before success; abort with observed SIGKILL/close; cleanup
timeout with lingering handles; and emergency process exit after deliberate
parent IPC disconnect. The last test observes exit after its own IPC disconnect,
not the normal supervisor's close path. These are lifecycle fixtures, not Oracle
wire peers, real transaction/TLS tests, or server-termination evidence.

Still required before any production registration:

- Exact published dependency import and packaging on ordinary CI platforms.
- A legally authorized, version/digest-pinned, disposable real Oracle instance;
  separate server-license and runner constraints still apply. No production DB.
- Restricted fixture account, permissions/routine review, SELECT/DDL/DML/PLSQL/
  locking and autonomous-function negative cases.
- Real service/authentication, binds, full NUMBER edge cases, scalar metadata,
  original duplicate aliases despite driver renaming, and row/byte-limit results.
- A decision and actual-driver evidence for the ORA-00932/ORA-01007 internal
  repeat behavior; do not infer exactly-once execution from these fixtures.
- Standard-trust and explicit-CA TCPS success, hostname/certificate failures and no fallback;
  unsupported auth/configuration rejected before I/O.
- Real-driver stalls/cancellation at connect/auth/classification/fetch/cleanup,
  actual process/socket closure, concurrent isolation and no late results.
- Node/Electron/Windows/macOS behavior verified separately; no inherited
  environment workaround or skipped security validation may substitute for it.

Oracle Free's server terms and CI image are separate from the OSS client. This
WIP does not install/start a server, accept a license dialog, create credentials,
register a provider, merge main, or deploy anything.

## Primary references

- [Official release notes](https://node-oracledb.readthedocs.io/en/latest/release_notes.html)
- [Installation / Thin prerequisites](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html)
- [Client license](https://github.com/oracle/node-oracledb/blob/main/LICENSE.txt)
- [Connection API and classification](https://node-oracledb.readthedocs.io/en/latest/api_manual/connection.html)
- [Connection/TLS options](https://node-oracledb.readthedocs.io/en/latest/api_manual/oracledb.html)
- [Bindings](https://node-oracledb.readthedocs.io/en/latest/user_guide/bind.html)
- [Fetching / NUMBER / ResultSets](https://node-oracledb.readthedocs.io/en/latest/user_guide/sql_execution.html)
- [SET TRANSACTION limitations](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/SET-TRANSACTION.html)
- [Autonomous transactions](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/autonomous-transactions.html)
- [Node public IPC unref API](https://nodejs.org/docs/latest-v24.x/api/process.html#processchannelunref)
- [Node 24.5.0 public default-CA replacement API](https://nodejs.org/download/release/v24.5.0/docs/api/tls.html#tlssetdefaultcacertificatescerts)
- [Node 22.19.0 default-CA API backport](https://nodejs.org/download/release/v22.19.0/docs/api/tls.html#tlssetdefaultcacertificatescerts)
- [Node public X509Certificate API](https://nodejs.org/download/release/v24.5.0/docs/api/crypto.html#class-x509certificate)
- [Node 24.22.1 child coverage propagation](https://github.com/nodejs/node/blob/v24.22.1/lib/child_process.js#L500-L505)
- [Node coverage opt-out documentation](https://github.com/nodejs/node/blob/v24.22.1/doc/api/cli.md#L3681-L3690)
- [Matching libuv Windows startup environment keys](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/win/process.c#L47-L59)
- [Apple CF text-encoding environment synthesis](https://github.com/apple-oss-distributions/CF/blob/main/CFStringEncodings.c#L832-L882)
- [Oracle Free server terms](https://www.oracle.com/downloads/licenses/oracle-free-license.html)

Pinned-source details inspected without importing the driver:

- [26.0.0 result metadata normalization](https://github.com/oracle/node-oracledb/blob/v26.0.0/lib/impl/resultset.js)
- [26.0.0 query error retry flag](https://github.com/oracle/node-oracledb/blob/v26.0.0/lib/thin/protocol/messages/withData.js)
- [26.0.0 protocol message reprocessing](https://github.com/oracle/node-oracledb/blob/v26.0.0/lib/thin/protocol/protocol.js)
- [26.0.0 statement classification](https://github.com/oracle/node-oracledb/blob/v26.0.0/lib/thin/statement.js)
- [26.0.0 public TLS-context construction path](https://github.com/oracle/node-oracledb/blob/v26.0.0/lib/thin/sqlnet/ntTcp.js)
