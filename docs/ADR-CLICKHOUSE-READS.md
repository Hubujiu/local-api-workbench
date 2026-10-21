# ClickHouse HTTP read-only queries

## Sources

The official [HTTP interface](https://clickhouse.com/docs/interfaces/http) documents GET read-only semantics, JSON results, typed query parameters and Escaped parameter encoding. The [vendor image tags](https://hub.docker.com/r/clickhouse/clickhouse-server/tags?page=1) identify26.8.3.105-alpine; this version is used only for isolated CI fixtures. No cloud ClickHouse account or production service is accessed.

## Contract

Supports HTTP/HTTPS ClickHouse SELECT/WITH queries through the database page and explicitly granted read-only pre/post session connections. Default ports8123/8443; Basic credentials are sent in the header, not query parameters. TLS verification stays enabled; an explicit custom CA is supported. Redirects and compressed replies are rejected, never followed/replayed.

Queries are wrapped in an outer SELECT LIMIT1001 FORMAT JSON and sent using GET (server-enforced read-only) with max_execution_time2, max_result_rows1001, result_overflow_mode=break. Only one trailing semicolon is accepted; other semicolons, including literal SQL semicolons, require using bound values instead. Positional parameter array entries map to typed placeholders {p0:String}, {p1:UInt64}, etc. Standalone queries also accept a named object. Scalar string/finite-number/boolean/null values are serialized using ClickHouse Escaped encoding before URL encoding; large integer values should be supplied as strings with the desired server type. SQL text is never interpolated with parameter values.

Client total timeout5seconds, response≤1MiB, URL≤256KiB, parameters≤1000, returned rows≤1000 with truncation flag. Malformed/exception/non-200/invalid-UTF8 responses fail. This is HTTP query support, not native TCP, writes, management commands or every ClickHouse format. GET URLs contain SQL and bound query values and can appear in database/proxy access logs; only use authorized trusted databases. Read-only queries can still invoke server functions with external behavior, as with other supported database providers.

## Fixed verification

`clickhouse.test.mjs`: actual local HTTP parameter/credential/GET contract, escaping/null, invalid requests, redirect refusal, row/result caps, malformed/exception replies and TLS rejection/explicit CA trust.

`clickhouse-integration.mjs`: real ClickHouse26.8 fixture, typed parameters with punctuation/control characters/null and UInt64 precision, named parameters,1000-row truncation, write rejection and server GET read-only behavior even for a privileged test user. CI also checks readonly cannot be weakened by query settings. No proof is claimed until the exact-head database job succeeds.

`ui-smoke.mjs`: provider-specific port/parameter controls and an actual HTTP-protocol fixture query; screenshot local-api-clickhouse-query.png. Real server evidence is the separate database CI, not this protocol fixture.

## Initial real-service failure and correction

52c10212 / Actions39636013999 failed on the first real ClickHouse request: GET had already enabled read-only mode, so trying to set readonly=1 in URL parameters was rejected with READONLY/Code164. The client now omits this conflicting setting while retaining GET, rather than falling back to POST or changing server security. Custom SETTINGS text is rejected, including conservative matches in literals/comments (use bound values), so queries cannot override requested execution/result limits. The actual server GET write-rejection test remains. The failure is retained; the corrected commit needs its own green CI.
