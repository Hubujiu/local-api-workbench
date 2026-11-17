# Experimental SQL Server input adapter (not a provider)

`prepareSQLServerReadInput` is an internal, inert compilation contract. It opens
no database transport, grants no authority and is not imported by any public
entrypoint. SQL Server remains unavailable in owner HTTP, sessions, MCP, CLI and
UI. No real SQL Server, TLS/TDS exchange, license acceptance or server-side
read-only enforcement is claimed by these tests.

The flat input requires `type: "sqlserver"` and accepts only host, port, user,
password, database, ca, ssl, sql and parameters. Only connection fields are
projected into the existing connection contract. Unknown fields, symbols,
accessors, Proxies and exotic objects reject without executing their code.
Session metadata (name/bindingId), writes, SSH, URLs, factories and timeouts are
not silently discarded or treated as authority. A future authorized session layer
must perform its own validation and supply this narrow shape deliberately.

Port defaults to 1433 only when absent/undefined. Zero, null and numeric strings
reject. No UI coercion or old session-zero behavior is adopted implicitly.
TLS must explicitly be true; host, user and database must be explicit nonblank
strings and password an explicit string (empty is preserved). Unicode, NUL and
size checks remain those of the existing connection/compiler contracts. No URL
parsing, instance-name resolution or alternate target interpretation is added.
Precise host/driver semantics still need real-wire validation before activation.

Parameters retain the existing null/Unicode/boolean/int32/exact int64 subset and
all compiler limits. No generic database parameter converter is applied. The
compiler snapshots before awaiting; connection configuration is copied. Errors
are fixed text, with no input, credential, cause or cancellation-reason echo.
Pre-aborted calls do not inspect inputs; cancellation during compilation discards
the result after bounded compiler completion, not immediate worker termination.
There is no execution token, transport or grant to revoke here.

## Staged closure

1. This inert adapter and negative public-entrypoint tests. No provider opening.
2. Independently review authorized integration: project/grant identity, epoch,
   revocation before/after execution, fixed process supervisor, no write or SSH,
   and only explicit stdin/file temporary CLI/MCP grants. Keep activation closed.
3. Obtain required license/service approval separately; validate real TLS hostname,
   CA rejection, exact target/database and authentication, no reroute/retry,
   parameter/results encoding and cancellation on all supported platforms.
   A controlled read-only database, least-privilege account and reviewed local
   objects are prerequisites: SELECT/READ_ONLY cannot rule out login triggers,
   views, computed expressions, external functions or remote effects.
4. Only after those prerequisites, consider explicitly authorized provider/UI
   activation with restricted query examples, strict raw port parsing, mandatory
   TLS and no write controls. Label experimental scope and unsupported types
   honestly; do not call an unverified service production-ready.

An "experimental/not live-tested" label alone is not a safety control and does not
justify opening public execution before the TLS/target/read-only prerequisites.
No EULA or restricted service is needed for the current fake/compiler tests.
