# SQL Server exact decimal / temporal output preparation

Internal, opt-in, **not a public provider or real-service acceptance**. Builds on the
existing decimal input binder. No new dependencies, server provisioning, credentials,
or legal acceptance.

Use trusted code only:

```js
await runSQLServerPreparationProcess(input, { exactOutput: true });
```

The default remains unchanged. This option is not accepted in user SQL, connection
configuration, or the request body. Production callers must use the existing owned
process supervisor rather than calling the lower-level injected port test seam.

## Real execution path

1. Existing verified TLS owned transport and database READ_ONLY probe.
2. Fixed parameterized sys.columns/sys.tables/sys.schemas/sys.types query for only
   the compiler's explicit schema/table and projected columns. TOP (129), at most
   128 unique columns. A view, synonym, missing column, alias/CLR type, computed or
   encrypted column fails closed. No caller-supplied metadata or raw expressions.
3. Validate exact catalog correspondence and decimal precision/scale (1..38,
   0..precision), temporal scale (0..7). Regenerate approved projections:
   decimal/numeric -> varchar(41); date -> varchar(10), style 23;
   time -> varchar(16), style 126; datetime2 -> varchar(27), style 126;
   datetimeoffset -> varchar(34), style 127.
4. Tedious receives strings, not Decimal->Number or temporal->Date conversions.
   Strings/null are validated, never rounded or converted through JavaScript Date.
   Fractional trailing zero omission allowed by server styles is not treated as a
   timezone conversion; datetimeoffset retains its numeric offset (or Z).
5. Existing 1000-row/1MiB result budget and confirmed transport/process closure
   precede publication. Missing/malformed metadata, invalid values, excess result,
   timeout/cancellation/failed closure publish no partial result.

Ordering explicitly qualifies source table columns so converting a decimal to text
does not silently change numeric sorting to lexicographic output-alias sorting.
Exact mode does not support ordering by a newly introduced projection alias. Column
names must match catalog case exactly, including on case-insensitive servers.

The catalog is read on the same verified READ_ONLY connection as the data.
The encryption_type catalog field requires SQL Server 2016 or newer; older
engines fail rather than silently omitting the encrypted-column check.
No claim is made against a privileged server administrator changing database state,
schema, or server responses. Existing least-privilege target/TLS/read-only gates
still apply. Catalog visibility requires access to the selected object, not broad
database administration.

## Evidence and remaining gate

Local tests use inert synthetic catalog/result exchanges. They prove dispatch,
projection construction, validation and closure ordering, **not SQL Server's actual
formatting, TDS or TLS**. The opt-in real-service test now expects decimal(38,18),
datetime2(7), datetimeoffset(7) with +05:30, time(7), year-0001 date and SQL NULLs from
the explicit disposable fixture. This gate was not run here. No public enablement
until it passes on supported SQL Server and packaged Windows targets.

Unsupported output types still fail closed: money/smallmoney, float/real,
legacy datetime/smalldatetime, XML/LOB, CLR/alias types and arbitrary expressions.
Native migration and schema/type roundtrips are separate unfinished capabilities.

References:

- [Microsoft CAST and CONVERT](https://learn.microsoft.com/en-us/sql/t-sql/functions/cast-and-convert-transact-sql)
- [Microsoft sys.columns](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-columns-transact-sql)
- [Microsoft sys.types](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-types-transact-sql)
