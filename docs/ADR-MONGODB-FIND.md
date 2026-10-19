# Bounded MongoDB find queries

The database page adds a MongoDB option using the official pinned mongodb7.7.0
Node driver. Reference: https://www.mongodb.com/docs/drivers/node/current/crud/query/retrieve/ .

Input is a JSON object with collection, filter, projection, sort, limit and skip.
This is not a JavaScript shell: only find is exposed. Projection accepts0/1,
sort1/-1, limit1..1000 and skip0..100000. Extended JSON filter values are accepted
for BSON types. Returned values use canonical Extended JSON to avoid losing
ObjectId, date or64-bit numeric type/precision.

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
Browser checks cover provider configuration and a delayed old-provider response
that must not overwrite the newly selected provider. This does not claim a full
MongoDB GUI/database lifecycle test or complete original-product equivalence.
