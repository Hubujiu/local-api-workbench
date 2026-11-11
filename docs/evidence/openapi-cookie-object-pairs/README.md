# Cookie object pairs verification

Base: PR #165 local commit `7682c9b` (nullable-source repair), not main.
This is an unpublished candidate for review. No merge, deployment or CI claim.

- `regression.txt`: 330 tests, 329 passed, 0 failed, 1 skipped (Go toolchain
  unavailable). All OpenAPI suites plus Cookie jar/cancellation, dynamic values,
  MCP input, AWS/Hawk/EdgeGrid signing, HTTP/2, code generation and global defaults.
  Command: `node --test --test-concurrency=2 tests/openapi*.test.mjs tests/cookie*.test.mjs tests/mcp-request-input*.test.mjs tests/dynamic-values.test.mjs tests/aws-signature.test.mjs tests/aws-query-signature.test.mjs tests/hawk-auth.test.mjs tests/edgegrid-auth.test.mjs tests/http2*.test.mjs tests/request-code-generation.test.mjs tests/global-parameters.test.mjs`.
- `final-feature.txt`: after adding explicit duplicate-JSON/Schema-metadata
  expectations, the final three Cookie feature files passed 16/16, no skips.
  Production code was unchanged after the 330-test regression.
- `check.txt`: repository syntax checks passed.
- `format.txt`: full repository format check passed. The final additional test
  was formatted separately; `git diff --check` passed.
- Independent review found no blocker. An independently run 39-test subset
  passed; it is not a separate full-suite or CI result.

The feature workflows exercise actual HTTP/1.1, HTTP/2 and curl, owner API,
official MCP SDK HTTP and stdio, temporary inputs, unauthorized isolation,
Store reopen/backup restore, frozen/live separation, dynamic values and real
project Cookie-jar priority. Native JSON/directory/live/frozen export boundaries
are separately covered. Generated Go execution remains skipped as stated above.

Initial workflow testing found that a retained source example still required
its variable after replacement. The first candidate incorrectly treated this as
a fixture issue and supplied that variable. Independent review identified the
real product defect; the follow-up now isolates operation provenance and marked
Cookie schema metadata, removes that fixture workaround, and tests actual SDK
HTTP/stdio execution with no old variable. `metadata-red.txt` preserves the
pre-fix missing-variable failures; `metadata-green.txt` records eight passing
focused tests. Explicit Cookie Header plus object remains a refused combination,
not a supported override. Initial native-boundary expectations were corrected to accept the
existing raw-Cookie export refusal and to set a raw policy for the marked frozen
sample. No production budgets, authentication assertions or jar precedence were
weakened to obtain passing tests.

This is deliberately not a universal Cookie form implementation. See
../../ADR-OPENAPI-COOKIE-OBJECTS.md for the mandatory source extension, restricted
shape, encoding, collisions, disabled-row admission and JSON duplicate-key policy.
Full repository tests, independent GUI acceptance and published-head CI remain
outside this candidate verification.

## Follow-up: stale source template isolation

`metadata-regression.txt` is the final follow-up production-tree regression:
391 tests, 390 passed, 0 failed, 1 Go-toolchain skip. It reruns the original
330-test command with the updated Cookie workflows and adds
`dynamic-definition-metadata`, `script-schema*`, `assertion-state`,
`mock-response-schema`, `script-response*`, `native-response-assertions`, and
`native-variable-assertions`. This includes actual HTTP schema assertion failures,
response mutation, schema caches and the existing authentication/signing suites.
`metadata-check.txt` and `metadata-format.txt` record passing syntax/full-format
checks. No full-suite, remote CI or GUI acceptance is implied.

The only new interpolation exclusions are `openapiOperation` provenance and the
schema of explicitly marked Cookie rows. Source consumers were checked: operation
metadata participates in import/export and definition/reference scans, while
actual execution consumes normalized URL/auth/rows/body. Other request schema,
response definitions, examples, assertions and authentication keep their old
paths and are explicitly covered by tests. The fix does not suppress missing
variables in the actual Cookie value: a no-override SDK request still fails with
zero network traffic, while a complete temporary override executes once.
