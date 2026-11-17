# Canonical gRPC runtime-row verification

Base: exact PR #147 head `0e2d83067e54ac172496ca96d66feca7229ce731`.
Production change: add independent gRPC leaves to the existing runtime-row
capability set. No transport, frame, scope or native-format rewrite.

## Local checks

- `npm run check`: passed.
- `npm run format:check`: passed.
- `git diff --check`: passed.
- Broad targeted run: `node --test --test-concurrency=2 tests/plan-*model.test.mjs tests/plan-runtime-rows-*.test.mjs tests/plan-repeat-until-grpc-*.test.mjs tests/plan-if-protocol-chain-integration.test.mjs tests/grpc*.test.mjs tests/staged-load-runtime-rows.test.mjs`: 660/660 passed.
- After strengthening the committed-scope until predicate and adding both failure
  policies to unknown-commit cases, final new-suite run:
  `node --test tests/plan-runtime-rows-grpc.test.mjs tests/plan-runtime-rows-grpc-workflow.test.mjs`: 35/35 passed.

The new tests distinguish model/synthetic boundary checks from real loopback
transport evidence. The real suite covers all four RPC styles through owner,
official MCP SDK HTTP/stdio and CLI, plus terminal barriers, cancellation,
non-OK status, deadline, credential redaction and persisted receipts. Synthetic
checks cover frozen row data, committed-scope persistence, nested until,
malformed later rows, empty/false preflight, atomic extraction, unknown commits,
evidence quotas and ordinary stop/continue behavior. Existing obsolete gRPC row
rejections were changed to positive admission with reference-resolution and
credential requirements retained; other unsupported siblings still fail closed.

These are targeted local checks, not a full repository suite or remote CI run.
No external-service interoperability, merge or deployment is asserted.
