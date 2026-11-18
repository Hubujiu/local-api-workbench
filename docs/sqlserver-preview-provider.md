# SQL Server owned read-only provider preview

**Experimental and disabled by default. No actual SQL Server or Windows acceptance
has been recorded.** The public dispatcher now has a real, fixed-driver execution
path rather than only an isolated adapter test. The preview gate does not certify
compatibility or authorize connecting to a database.

## Explicit operator opt-in

Only an authorized operator of the Workbench server process can set:

```text
LOCALAPI_SQLSERVER_PREVIEW=read-only
```

The value is exact and case-sensitive. Unset, "1", "true" and other values stay
closed. A request, connection grant, imported project, driver option or script
cannot turn this gate on. Restart without it to disable preview. Existing temporary
SQL Server grants cannot query once the process gate is disabled.

After opt-in, the existing authenticated owner API supports:

- POST /api/projects/:projectId/database with type "sqlserver", explicit host,
  user, password, database, ssl:true, optional port (default 1433) and CA PEM,
  sql and parameters.
- Existing temporary database-connections registration/query/revoke lifecycle.
- Owner-issued MCP database grants under the existing separate enabled/write/
  execute/project permission checks. MCP does not receive credentials in results.

The UI type selector and CLI/stdio grant-file allowlists remain closed pending
acceptance and their own integration. This increment does not claim full UX.

## One actual provider, no fallback

The public query path uses runSQLServerPreparationProcess with exactOutput:true
unconditionally. It cannot receive a driver factory, module, arbitrary compiled
plan, retry option, TLS bypass, alternate credentials or SSH tunnel. Owner HTTP
writes remain rejected. A session may not hide unsupported connection options or
turn explicit port zero into a default.

The narrow SELECT compiler, TLS identity verification, fixed TCP target, no
reroute/retry, READ_ONLY database probe, bounded catalog projection, 1000-row /
1MiB result ceiling and hard owned-process termination boundary all remain.
Caller cancellation and grant revocation reach the owned process. No result is
published before closure. SQL Server 2016+ catalog fields are required.
See [exact output contract](sqlserver-exact-output.md) for supported types and
[real service gate](sqlserver-real-service-gate.md) for prerequisites.

## Evidence, not substitutes

Local provider tests exercise:

- default/incorrect gate, invalid SQL, writes, unsafe TLS, SSH and unknown options;
- actual owner HTTP registration and authentication plus denied read/write input;
- project-scoped MCP grants without secret disclosure;
- actual public dispatcher, temporary session and HTTP-disconnect cancellation
  using the real owned subprocess against an inert loopback TCP listener.

The listener sends no database/TLS replies and is not a SQL Server emulator. Those
tests prove wiring/cancellation/closure, not login, TLS success or SQL results.

The opt-in real-service test now runs exact decimal/temporal/NULL expectations
through queryRemoteDatabase (the same public dispatcher), reads through a temporary
DatabaseSessions grant, verifies revocation, and rejects the READ_WRITE fixture.
It neither provisions a server, accepts an EULA nor runs fixture DDL automatically.
It remains skipped until an already-authorized disposable service is supplied.
Do not remove the preview gate or advertise general support based on local tests.
