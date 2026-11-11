# Local verification

Base: PR169 exact remote head `7209638aede4e5c114355b9dd9fd6dfb72342af3`.
No publication, merge, deployment or original proprietary program execution.

- `focused.txt`: 16/16 tests pass, no skip. Includes codec, actual HTTP1/HTTP2/cURL,
  official MCP SDK HTTP/stdio, frozen/backup/restart and native export boundaries.
- `regression.txt`: 398 tests, 397 passed, one Go-toolchain-unavailable skip,
  zero failures. The focused tests are included, not additional to this count.
- `check.txt`: syntax gate.
- `format.txt`: full repository source formatting gate.
- `git diff --check` passed independently.

Expanded command:

```sh
node --test --test-concurrency=2 tests/openapi*.test.mjs tests/parameter-schema-source*.test.mjs tests/dynamic*.test.mjs tests/mcp-request-input*.test.mjs tests/*url*.test.mjs tests/global-parameters.test.mjs tests/aws-signature.test.mjs tests/aws-query-signature.test.mjs tests/oauth1.test.mjs tests/request-code-generation.test.mjs tests/script-response-mutation.test.mjs tests/script-schema.test.mjs
```

The first expanded run found two test message expectations that predated the
new object codec: the prior generic object rejection and a malformed native
export marker now rejected earlier by normalization. Both tests continue to
require rejection, with the expected new diagnostic. No rejection was removed.
A separate reviewer exercised collision, script mutation, SDK and native export
boundaries and reviewed the final effective-context OpenAPI export checks.
No full repository test-suite or remote CI result is claimed.
