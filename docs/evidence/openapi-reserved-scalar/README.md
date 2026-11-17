# Restricted scalar allowReserved verification

Base: PR166 exact remote commit `d958133aab918ecfb6efec8c0267590b9f0cbd3d`, tree
`95886bcfe2af81373a8726910dde200015432d47`. This candidate has not been pushed,
merged or deployed. No full-repository-suite or CI completion claim.

- `regression.txt`: final expanded regression, 367 tests / 366 passed / 1 skipped
  (Go toolchain unavailable) / 0 failures. Covers OpenAPI, dynamic values, MCP,
  request code generation, signatures, HTTP2, globals, cURL and SDK URL workflows.
- `feature.txt`: 12 new feature tests including actual HTTP1/HTTP2/cURL,
  Basic/Bearer headers, original Query spelling, OpenAPI roundtrip for supported
  definitions, Store reopen/backup/frozen isolation, SDK HTTP/stdio temporary
  scalar input, dynamic invalid values and zero network effects, native export
  boundaries, malformed markers and strict unsupported combinations.
- `check.txt`, `format.txt`: syntax and full formatting checks passed.
- Independent review identified raw-URL OpenAPI projection rewriting `%2f` to
  `%2F`, and low-level SDK initialization silently dropping the marker. Both now
  explicitly refuse the unsupported operation and have regression assertions.
  Original URL Query requests still execute and export cURL without rewriting.
- Expanding SDK tests initially found the closed facade dependency manifest
  stale after the new low-level guard. `node scripts/build-url-facade.mjs`
  rebuilt the official artifact/manifest; 12 facade/mode/worker tests and the
  final expanded regression passed. No assertion or hash gate was relaxed.
- The old rejection fixtures now distinguish malformed flags from newly
  supported `true`; Swagger2 true still rejects, and array true still rejects.

Command for expanded regression:
`node --test --test-concurrency=2 tests/openapi*.test.mjs tests/dynamic-values.test.mjs tests/dynamic-definition-metadata.test.mjs tests/mcp-request-input*.test.mjs tests/request-code-generation.test.mjs tests/aws-signature.test.mjs tests/aws-query-signature.test.mjs tests/oauth1.test.mjs tests/http2*.test.mjs tests/global-parameters.test.mjs tests/*url*.test.mjs`

See `../../ADR-OPENAPI-RESERVED-SCALAR.md` for the pre-encoded percent contract,
raw apostrophe limitation, explicit auth/SDK restrictions and export boundaries.
