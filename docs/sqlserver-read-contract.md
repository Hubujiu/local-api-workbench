# SQL Server inert query contract

This module does not register a provider, import a database driver, connect to a
server, execute SQL, accept a license, or enable SQL Server. It is an asynchronous
compiler only. No live SQL Server integration has been tested here.

The starting point is Hubujiu/local-api-workbench PR #45 at 29a6cee, whose
subsequent dependency audit fix is acknowledged. No driver dependencies or its
connection configuration are migrated. The existing locked node-sql-parser 5.4.0
TransactSQL parser is used only inside a disposable worker.

## Accepted subset

One SELECT with 1–128 explicit ASCII column identifiers, optional ASCII aliases,
exactly one schema-qualified local object, optional AND comparisons between an
unqualified column and @pN, and up to 16 column ORDER BY terms. No literals,
functions, expressions, joins, CTEs, subqueries, hints, cross-database references,
SELECT INTO, wildcard projections, arbitrary statement suffixes, or unknown AST
fields are accepted. Every accepted clause is regenerated, never copied from the
input SQL. The generated TOP (1001) supports a future 1000-row result boundary;
it does not itself bound server work, bytes, elapsed time, or result complexity.

Parameters are snapshots of dense own-data arrays. Proxies (including revoked
proxies), accessors, exotic objects and extra fields are rejected without calling
their code. Accepted values: null (NVarChar typed), well-formed Unicode text,
boolean, int32 numbers, or exact `{type: "int64", value: "..."}` decimal strings
within signed 64-bit range. Null is not rewritten to IS NULL: SQL comparison
semantics still apply. The contract specifies parameter types but does not prove
any future driver's encoding or results are lossless.

Budgets: 8192 SQL UTF-8 bytes; 64 parameters; 65536 UTF-8 bytes per string;
1 MiB cumulative serialized parameter records; 64 predicate nodes. Parsing runs
in a worker with a 2-second wall deadline, 32 MiB old-generation heap, 8 MiB young
generation and 2 MiB stack settings. These are V8 resource settings, not a total
process RSS limit. At most two compilations may be active per module instance;
additional calls reject rather than queue. These are compiler safeguards, not a
server query sandbox. A future service must add process-wide admission control.

## Mandatory prerequisites before any future execution

AST SELECT filtering does **not** prove zero side effects. A schema-qualified name
can resolve to a view or synonym and can lead to functions, remote objects or
other server-defined behavior. Computed columns and row-level security predicates
also need review. Login triggers can execute even before a query. READ_ONLY is a
required contract flag only, not an enforcement action performed by this module;
it is not a universal guarantee against remote or external side effects.

Any future provider needs an explicitly authorized, controlled database and
reviewed server objects, least-privilege credentials restricted to approved local
base tables/columns, trustworthy server configuration, verified TLS, a proven
lossless driver parameter/result boundary, cancellation/time/row/byte limits,
and dedicated live integration tests. Server login triggers, views, synonyms,
functions, CLR/external access and remote dependencies must be excluded or
independently reviewed and constrained. No provider should rely on this AST
contract alone as an authorization or safety boundary. License approval and any
server installation/run remain separate, unperformed steps.

## Verification

Run only the affected suite:

    node --test tests/sqlserver-read-contract.test.mjs

Coverage includes regeneration, SQL rejection cases, int64 bounds, null and
Unicode preservation, malformed or oversized input, getter/Proxy rejection,
snapshot isolation, predicate depth bounds, event-loop responsiveness and
concurrent admission. A test-only worker URL substitution leaves the production
wrapper and 2-second timeout unchanged, and proves real timeout termination,
heartbeat cessation, no late result, and admission-slot recovery. V8 heap/stack
exhaustion limits are configured and source-reviewed, not empirically stress-tested.
These are contract-only tests, not SQL Server execution
proof or a full repository test run.
