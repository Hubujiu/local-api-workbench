# Bounded MongoDB find queries

The database page adds a MongoDB option using the official pinned mongodb7.7.0
Node driver. Reference: https://www.mongodb.com/docs/drivers/node/current/crud/query/retrieve/ .

Input is a JSON object with collection, filter, projection, sort, limit and skip.
This is not a JavaScript shell: only find is exposed. Projection accepts0/1,
sort1/-1, limit1..1000 and skip0..100000. Extended JSON filter values are accepted
for BSON types. Returned values use canonical Extended JSON to avoid losing
ObjectId, date or64-bit numeric type/precision.

Bare integer JSON numbers must be safe JavaScript integers, recursively including
nested filters and arrays. Otherwise the query is rejected before opening the
network worker: JSON parsing can already change `9007199254740993` into
`9007199254740992`, silently selecting a different document. Supply exact values
as EJSON strings, for example `{"id":{"$numberLong":"9007199254740993"}}` or
`{"amount":{"$numberDecimal":"9007199254740993.125"}}`. Explicit
`$numberDouble` strings retain the caller's intentional approximate double
semantics. Ordinary finite fractional numbers keep IEEE-754 semantics; this is
not a lossless JSON number parser, and no value is automatically guessed or
converted into a different BSON type. The same guard applies to direct query
objects and JSON query strings used by project-scoped declarative database tasks.

The four numeric wrappers (`$numberInt`, `$numberLong`, `$numberDecimal`,
`$numberDouble`) must each contain exactly one key with a string value. Sibling
fields, including query operators or another numeric type key, are rejected
before connection construction rather than silently discarded by BSON.
`$numberInt` decimal strings must be within `-2147483648..2147483647`; explicit
signs and leading zeros retain their integer semantics, while fractions,
exponents, nondecimal bases and whitespace are rejected. `$numberLong` must be
within `-9223372036854775808..9223372036854775807`; its pinned EJSON grammar
allows explicit plus (including `+0`) but not leading zeros or `-0`.
Neither integer type is unsigned; overflow must not wrap to another target.
No accepted wrapper is rewritten; canonical serialization preserves numerical,
not lexical, identity. Valid Decimal128 and explicit Double strings (including
supported nonfinite values) continue through the existing BSON parser. This is
not a replacement floating-point/decimal parser or complete EJSON validation;
Date, Timestamp and Binary wrappers are not added to this validation scope.
Sources: [MongoDB EJSON numeric types](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/)
and [type-wrapper parsing rules](https://specifications.readthedocs.io/en/latest/extended-json/extended-json/#parsers).

Writes, arbitrary commands, aggregation, watches, server-side JavaScript and
unsafe prototype keys are rejected. Recursive validation limits queries to64KiB,
1000 nodes and10 levels. Results are capped at1MiB per document,2MiB total and
1000 columns, with one document per cursor batch.

Connection input is an explicit single host and port, database name, optional
username/password and authentication database (default admin). No URI options,
SRV discovery, cluster selection, system credential discovery or Unix sockets
are exposed. TLS and hostname validation remain enabled when TLS is selected;
an inline CA may be supplied. Credentials are request-scoped and not saved.

Each query runs in a worker with64MiB V8 old-generation limit and a5-second total
parent deadline. Driver selection/connect/socket timeouts and server maxTimeMS
also apply. retryReads is disabled. Worker limits are not a guarantee about all
native buffers inside the driver: connect only to trusted database servers.

CI starts an isolated MongoDB8.0 service with fictional documents and tests
filtering, sorting, projection, typed values, truncation and write rejection.
The normal service fixture also seeds adjacent Long IDs in its own isolated
collection, checks precise EJSON selection and unsafe-number rejection, and
exercises project grants, declarative before-operation extraction, HTTP echo,
atomic failure evidence, backup/restore, restart and explicit regrant. These
service checks require the real CI MongoDB service; pure BSON tests are not
a substitute. This base branch does not include native script database tasks
or CLI grant integration.
Browser checks cover provider configuration and a delayed old-provider response
that must not overwrite the newly selected provider. This does not claim a full
MongoDB GUI/database lifecycle test or complete original-product equivalence.
