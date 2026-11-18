# Experimental SQL Server input adapter (not a provider)

`prepareSQLServerReadInput` remains an inert compilation contract. The shared
strict snapshot also feeds the separately [gated owned provider](sqlserver-preview-provider.md).
SQL Server is disabled by default; an explicit host preview opt-in permits owner
HTTP, temporary sessions and owner-issued MCP grants. CLI/stdio files and GUI
selection remain closed. No successful real SQL Server/TLS/TDS or Windows
acceptance is claimed.

The flat input requires `type: "sqlserver"` and accepts only host, port, user,
password, database, ca, ssl, sql and parameters. Only connection fields are
projected into the existing connection contract. Unknown fields, symbols,
accessors, Proxies and exotic objects reject without executing their code.
Session metadata (name/bindingId), writes, SSH, URLs, factories and timeouts are
not silently discarded or treated as authority. The authorized session layer
performs its own validation and supplies this narrow shape deliberately.

Port defaults to 1433 only when absent/undefined. Zero, null and numeric strings
reject. No UI coercion or old session-zero behavior is adopted implicitly.
TLS must explicitly be true; host, user and database must be explicit nonblank
strings and password an explicit string (empty is preserved). Unicode, NUL and
size checks remain those of the existing connection/compiler contracts. No URL
parsing, instance-name resolution or alternate target interpretation is added.
Precise host/driver semantics still need real-wire validation before activation.

Parameters retain the existing null/Unicode/boolean/int32/exact int64 subset and
add the explicit exact decimal predicate input described below, retaining compiler limits. No generic database parameter converter is applied. The
compiler snapshots before awaiting; connection configuration is copied. Errors
are fixed text, with no input, credential, cause or cancellation-reason echo.
Pre-aborted calls do not inspect inputs; cancellation during compilation discards
the result after bounded compiler completion, not immediate worker termination.
There is no execution token, transport or grant to revoke here.

## General-release prerequisites

The later host-gated preview performs the integration in step 2 while keeping
default activation closed. It does not discharge the real-service/platform gates.

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
4. Only after those prerequisites, consider general provider/UI
   activation with restricted query examples, strict raw port parsing, mandatory
   TLS and no write controls. Label experimental scope and unsupported types
   honestly; do not call an unverified service production-ready.

An "experimental/not live-tested" label alone is not a safety control and does not
justify opening public execution before the TLS/target/read-only prerequisites.
No EULA or restricted service is needed for the current fake/compiler tests.

## Exact decimal predicate parameters

The internal compiler now accepts `{ "type": "decimal", "value": "9007199254740993.123456789012345678", "precision": 38, "scale": 18 }`.
Precision is an integer from 1 to 38; scale is an integer from 0 to precision.
Values must be canonical signed decimal strings, without exponent, whitespace,
leading plus or redundant leading zeros. Values requiring rounding or overflow
reject before opening a connection. Fractional digits are not silently removed,
even if the extra digits are zero.

The value stays an NVarChar binding through Tedious. Only the compiler emits
`CONVERT(decimal(p,s), @pN)` with validated integer precision/scale. It never
interpolates the value into SQL or uses the driver's Number-based Decimal path.
Repeated references use the same conversion and binding. Connection isolation,
cancellation, READ_ONLY probe, budgets and public-provider gate are unchanged.
Decimal result columns and temporal values remain rejected pending exact result
projection work. This is not full SQL Server support or real-service acceptance.

The real-service fixture now includes `exact_amount decimal(38,18)` and checks
both the exact 34-digit value and a one-unit-in-the-last-place nonmatch through
the child-process execution path. Existing fixtures without that column must be
recreated by the operator in an approved disposable instance; the test never
changes them. A skipped real-service gate is still no acceptance evidence.

References: [Microsoft decimal precision and rounding](https://learn.microsoft.com/en-us/sql/t-sql/data-types/decimal-and-numeric-transact-sql),
[Tedious datatype representations](https://tediousjs.github.io/tedious/api-datatypes.html).
