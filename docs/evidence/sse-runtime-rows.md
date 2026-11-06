# SSE runtime-row evidence

Base: PR #153 exact `600f29b0bf47bba6d11299d6b172c2ae10bd3915`.
Production changes only the canonical runtime-row capability matrix and its
validation diagnostic. Existing SSE capture, script, credential, scope-commit,
receipt, cancellation and quota implementations are reused unchanged.

Dedicated `plan-runtime-rows-sse*.test.mjs` suites cover 67 cases: real owner,
MCP HTTP, MCP stdio and CLI flows, explicit repeated POSTs, absent Last-Event-ID,
frozen row/source and saved-definition references, committed environment/global
values, EOF including empty and incomplete final events, timeout/maxEvents,
expected statuses, both error policies, cancellation and stream cleanup, whole
array preflight, empty/false credential checks, atomic extraction, unknown commit
fail-stop, nested IF/until in both orders and existing static/quota restrictions.
These are loopback fixtures, not external-service interoperability claims.

The final dedicated suites passed 67/67 in independent review. Adjacent SSE IF,
SSE until and mixed protocol-chain integration suites passed 205/205. Syntax,
repository-wide format checking and diff whitespace checking passed. A broad
runtime-row/model run briefly picked up the new workflow fixture during authoring:
its four POST-body assertions failed because the fixture omitted explicit
`templateMode: variables`. The fixture was corrected, with all four entrypoints
independently retested successfully; production template semantics were unchanged.
The final broad runtime-row plus IF/until model regression passed 482/482
(`node --test --test-concurrency=2 tests/plan-runtime-rows-*.test.mjs
tests/plan-if-*-model.test.mjs tests/plan-repeat-until-*-model.test.mjs`).

No dependency, proprietary-format mapping, original runtime, deployment or merge
was introduced. Complete repository tests and remote CI are separate checks and
are not implied by these targeted results.
