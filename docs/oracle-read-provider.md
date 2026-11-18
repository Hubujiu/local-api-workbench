# Oracle Thin read implementation, not activated

`queryOracleRead` is a real internal adapter using pinned official `oracledb`
26.0.0 Thin mode. It does not need Oracle Instant Client or native compilation.
The adapter has not been registered in HTTP, shared DatabaseSessions, CLI, MCP or GUI.
This is implementation progress, not completion of Oracle support.

## Boundaries

- Explicit host, port (default 2484), service name (`database`), user, password,
  `ssl: true`, and exact certificate `serverDN`. No user connect descriptor,
  wallet, native-client initialization, external identity, SSH or arbitrary options.
- TCPS with certificate verification and DN matching; weak DN matching off.
  Trust defaults to the isolated Node runtime's trust store. An internal operator
  option can instead supply one endpoint-bound CA, as described below. Wallet
  and public custom-CA configuration remain unsupported. Host/service strings
  cannot inject connect-string options.
- Only bounded ASCII unquoted identifiers and one explicitly named schema/table,
  explicit columns/aliases, AND comparisons to `:pN`, and ORDER BY. The compiler
  regenerates SQL with quoted upper-case identifiers and a 1001-row limit.
  No functions, procedural SQL, database links, expressions, writes, locks or
  user-supplied SQL fragments are dispatched. Null, strings and safe integers
  are bound separately. This is deliberately not an arbitrary Oracle SQL console.
- Each read gets a fresh connection and `SET TRANSACTION READ ONLY`. NUMBER is
  fetched as VARCHAR rather than Number. Character and RAW types are supported;
  temporal, LOB, JSON, object, vector and floating types reject instead of losing
  precision or silently materializing unbounded values.
- Iterative result fetching, 1000 rows and 1 MiB, no partial success. All operations
  are in a sterile child process with a responsive supervisor, hard total budget,
  forced-termination receipt, quarantine on unconfirmed cleanup, and no replay.
  Result publication waits for result-set closure, rollback, connection close,
  worker exit and process exit. Credentials travel only in IPC, not argv/env.

Oracle listener redirects are part of the official Thin driver's connection
handling. Retry count is zero, but this is **not** a verified no-redirect control.
Trusted certificate DN, service routing and endpoint identity must be verified
against real deployment before exposing this adapter. Read-only transactions and
restricted syntax do not rule out external side effects from login triggers,
views or user-defined functions behind a table name. Use a least-privilege reader
and reviewed objects; public activation remains closed until that review.

## Internal owner-scoped provider

`OracleReadSessions` is an opt-in host integration using the same isolated
`queryOracleRead` adapter, not an alternate test-only SQL executor. Its default
constructor refuses activation. A host must explicitly enable the provider and
supply its authenticated owner/project identifiers; these must not be taken from
an unverified request body. No public route, advertised capability, environment
switch or existing shared database session is enabled by this module.

Each grant freezes the validated TCPS connection and a bounded allowlist of
reviewed `schema.table` relations, with at most 20 live grants and a maximum
15-minute lifetime. Compilation regenerates the SQL and reports the exact
canonical relation for authorization before any dispatch. Lists and grant
receipts omit connection information and credentials. Configuration remains only
in memory and is never stored in project documents.

Revocation, expiry and host shutdown abort in-flight work and fence late results;
a replacement grant gets a new opaque identifier. Caller cancellation combines
with the grant's signal and never triggers a retry. The provider's operation
promise still waits for the isolated process cleanup contract; `revoke` itself
initiates cancellation, not a promise that the operating system has already
terminated the child. Underlying errors are redacted before exposure.
The host must call `close()` when its owning session ends.

This is a narrow read-provider integration. It does not confer MCP agent
permission or grant write/execute access, validate arbitrary database views, or
satisfy the deployment acceptance gate. Public activation and UI configuration
remain unimplemented.

## Isolated operator CA trust

For an approved private-PKI service, a host may pass a second-argument `trust`
option to `queryOracleRead(input, { trust, signal })`. This is **not** a connection
field, query field, project setting, MCP argument or HTTP configuration. It is
not persisted. The exact object contains `host`, explicit `port`, `database`,
`serverDN` matching the validated connection and `ca` containing one PEM root.
Mismatched endpoint fields, extra options, accessors, oversized content, multiple
certificates, private keys, non-CA or non-self-signed roots, and expired/not-yet-
valid roots reject before creating the child. The CA is limited to 16 KiB.

The validated option travels through IPC and is revalidated in the one-use
execution worker. Before importing the driver or making any connection, that
worker calls Node's documented `tls.setDefaultCACertificates([ca])`, replacing
its own roots rather than broadening them. The owner process, process supervisor,
other workers and later reads are untouched. No temporary files, wallet,
`NODE_EXTRA_CA_CERTS`, inherited runtime options or system trust modifications
are used. Exact DN checks, chain validation, certificate expiry and TLS
requirements remain active. Listener redirects still share this one-operation
trust scope; this does not introduce an endpoint no-redirect guarantee.

This API requires Node 24.5+ (also present in 22.19+). The project's pinned
Electron 44.9.3 embeds Node 24.22.0 according to its official release metadata.
The host feature-detects the TLS API and returns
`ORACLE_READ_TRUST_RUNTIME_UNSUPPORTED` when absent; the execution worker also
fails closed. No fallback to default trust or weak validation exists for an
explicit trust option. Windows embedded-runtime execution remains unverified.

The pinned driver documents `walletContent` for mTLS and supplies it as
`cert`, `key` and `ca` to Node TLS. This implementation intentionally does not
invent a certificate-only wallet or take private client keys.

For the protected real-gate configuration file, an optional top-level `trust`
object has exactly the operator schema above. The optional gate passes this
object only as the host option, never inside the database connection. Without it,
default trust behavior is unchanged.

Sources:
[Node TLS thread-local trust API](https://nodejs.org/api/tls.html#tlssetdefaultcacertificatescerts),
[Electron 44.9.3 runtime metadata](https://releases.electronjs.org/release/v44.9.3),
[Oracle connection attributes](https://node-oracledb.readthedocs.io/en/latest/api_manual/oracledb.html#oracledb.getConnection).

## Verification

Unit tests inject only driver objects and verify compiler, exact text results,
no partial success, cancellation and cleanup. `oracle-protocol.test.mjs` actually
loads the official Thin driver in the child and connects to an inert local TCP
peer, verifies TLS precedes credentials, and rejects the dropped handshake.
The owned-provider protocol regression also revokes an actual held Thin TLS
connection, checks a single connection attempt, and verifies that no result is
published. That is not successful authentication, a real Oracle query, or Windows
evidence.

The isolated trust test additionally establishes real TLS with the official Thin
driver and a loopback fixture, observing the subsequent TNS connect packet.
A wrong CA, wrong exact DN, expired leaf and a subsequent query without the
operator CA each send no TNS data. The owner thread's trust remains unchanged.
This proves the TLS boundary only, not successful Oracle authentication, a real
Oracle query, redirect behavior or Windows evidence.

For the optional real gate, an operator must provision an already-approved,
licensed, disposable Oracle service, valid trusted TCPS certificate and fixed
fixture from `tests/fixtures/oracle-real-service.sql`. Give a separate reader only
CREATE SESSION and SELECT on the fixture, with no roles. Do not use business data
or admin credentials. The test does not install, accept terms, provision, migrate
or clean up anything. Outside the repository prepare:

```json
{
  "disposable": true,
  "connection": {
    "host": "oracle.example.test",
    "port": 2484,
    "database": "FREEPDB1",
    "user": "fixture_reader",
    "password": "replace-locally",
    "ssl": true,
    "serverDN": "CN=oracle.example.test"
  }
}
```

Set `LOCALAPI_ORACLE_REAL=1` and `LOCALAPI_ORACLE_REAL_CONFIG` to the protected file
path, then run `node --test tests/oracle-real-service.test.mjs`. No configured
service means skipped, not accepted. The gate verifies constrained privileges
and the exact decimal fixture through the same owner-scoped provider and actual
isolated adapter, plus wrong-owner/ungranted-relation rejection and revocation. It does not
prove every privilege source or deployment topology safe. The success diagnostic
is emitted only after completing the owned acceptance path. No real service or
Windows test has been run in this change.

Remaining development includes public authorization integration, user-facing
configuration, metadata discovery, complete type fidelity, wallet support,
database/version compatibility, native migration and round-trip formats.

References: [official driver](https://github.com/oracle/node-oracledb),
[connections](https://node-oracledb.readthedocs.io/en/latest/user_guide/connection_handling.html),
[fetch type handlers](https://node-oracledb.readthedocs.io/en/latest/user_guide/sql_execution.html).
