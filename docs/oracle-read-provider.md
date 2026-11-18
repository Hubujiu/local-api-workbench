# Oracle Thin read implementation, not activated

`queryOracleRead` is a real internal adapter using pinned official `oracledb`
26.0.0 Thin mode. It does not need Oracle Instant Client or native compilation.
The adapter has not been registered in HTTP, database sessions, CLI, MCP or GUI.
This is implementation progress, not completion of Oracle support.

## Boundaries

- Explicit host, port (default 2484), service name (`database`), user, password,
  `ssl: true`, and exact certificate `serverDN`. No user connect descriptor,
  wallet, native-client initialization, external identity, SSH or arbitrary options.
- TCPS with certificate verification and DN matching; weak DN matching off.
  Trust is the Node runtime's default trust store. Custom CA/wallet support is
  not implemented. Host/service strings cannot inject connect-string options.
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

## Verification

Unit tests inject only driver objects and verify compiler, exact text results,
no partial success, cancellation and cleanup. `oracle-protocol.test.mjs` actually
loads the official Thin driver in the child and connects to an inert local TCP
peer, verifies TLS precedes credentials, and rejects the dropped handshake.
That is not successful authentication, a real Oracle query, or Windows evidence.

For the optional real gate, an operator must provision an already-approved,
licensed, disposable Oracle service, valid trusted TCPS certificate and fixed
fixture from `tests/fixtures/oracle-real-service.sql`. Give a separate reader only
CREATE SESSION and SELECT on the fixture, with no roles. Do not use business data
or admin credentials. The test does not install, accept terms, provision, migrate
or clean up anything. Outside the repository prepare:

```json
{"disposable":true,"connection":{"host":"oracle.example.test","port":2484,"database":"FREEPDB1","user":"fixture_reader","password":"replace-locally","ssl":true,"serverDN":"CN=oracle.example.test"}}
```

Set `LOCALAPI_ORACLE_REAL=1` and `LOCALAPI_ORACLE_REAL_CONFIG` to the protected file
path, then run `node --test tests/oracle-real-service.test.mjs`. No configured
service means skipped, not accepted. The gate verifies constrained privileges
and the exact decimal fixture through the actual isolated adapter. It does not
prove every privilege source or deployment topology safe. No real service or
Windows test has been run in this change.

Remaining development includes public authorization integration, user-facing
configuration, metadata discovery, complete type fidelity, custom CA/wallet
support, database/version compatibility, native migration and round-trip formats.

References: [official driver](https://github.com/oracle/node-oracledb),
[connections](https://node-oracledb.readthedocs.io/en/latest/user_guide/connection_handling.html),
[fetch type handlers](https://node-oracledb.readthedocs.io/en/latest/user_guide/sql_execution.html).
