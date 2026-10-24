# Database value fidelity at JSON boundaries

Reuse provider parsers and bound-parameter implementations rather than converting every database value through JavaScript Number. Query row limits, read-only transactions, parameterization, explicit-write permission, TLS verification and mutation rollback rules remain in force.

## Value contract

- SQLite statements read integers as native BigInt. Safe-range integers remain JSON numbers for compatibility; larger signed-64 values become exact decimal strings. This fixes the previous exception for IDs above the JavaScript safe range, including INSERT/UPDATE/DELETE RETURNING.
- PostgreSQL parsers are scoped to each client, never registered globally. BIGINT/NUMERIC and temporal values retain text precision. Numeric/temporal arrays use the maintained postgres-array parser without floating-point/date coercion. JSON/JSONB unsafe integral numbers use Node's source-aware JSON reviver to retain their original numeric text as strings.
- MySQL uses the maintained mysql2 exact-big-number and date-string options. DECIMAL and BIGINT are not silently converted to floating point; JSON integer preservation uses the driver's Node 22+ support. Prepared execution binds values and preserves the single-statement boundary.
- Binary values use the existing local shape `{ "type": "blob", "base64": "..." }`, consistently for SQLite reads/RETURNING, PostgreSQL BYTEA and MySQL binary results. This replaces inconsistent Buffer/Uint8Array JSON encodings.
- Requests may use `{ "type": "int64", "value": "9007199254740993" }` or the blob shape as bound parameters. Invalid range/base64 and unsafe integral JSON-number parameters fail before execution. Exact decimals should be supplied as strings and cast/bound to the intended SQL type.
- Duplicate output column names fail with an aliasing instruction rather than overwrite data. PostgreSQL/MySQL array-row mode plus own-property construction prevents special column names from mutating object prototypes.

Non-finite values fail rather than serialize as null. Results are capped at 1 MiB after provider decoding; this is not a claim that arbitrary provider wire frames are pre-allocation bounded. JSON fractional numbers still use normal IEEE-754 semantics; select JSON/high-precision values as text when exact fractional token preservation is required. SQLite has no arbitrary-precision decimal storage: use text where its REAL representation would be insufficient. Temporal strings retain provider/session representation, not an invented timezone conversion.

## Verification

Local tests cover actual SQLite writes/reads, >2^53 identifiers, binary and Unicode values, JSON serialization, duplicate-name refusal, invalid parameters and size errors. A project-bound database operation passes the exact values through pre-script headers, real HTTP, post-script assertions and persisted plan evidence. PostgreSQL parser tests also verify that global driver behavior is unchanged.

The database-integration CI job runs real PostgreSQL/MySQL assertions for BIGINT, unsigned BIGINT, high-precision DECIMAL/NUMERIC, binary values, date/microsecond timestamp values, JSON integers, numeric arrays, unique aliases and special property names. It also performs an explicitly authorized PostgreSQL typed-parameter write followed by readback. These provider claims require the exact commit's integration job to pass; local unit tests alone are not remote-database verification. Other providers and SQL Server licensing remain separate work.
