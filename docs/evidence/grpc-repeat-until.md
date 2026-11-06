# Canonical gRPC repeat-until verification

Base: PR #146 exact head `2021566bc780d0b1c3e95b8dbc9dac8bc5f3001d`.
Scope: admit canonical `grpc` leaves in `repeat.untilCondition` using the existing
executor. No native-format inference, runtime-row gRPC, transport rewrite, merge,
or deployment.

## RED → GREEN

Before changing the capability policy, running
`node --test tests/plan-repeat-until-grpc-model.test.mjs` produced 3 tests,
1 passed and 2 failed with `条件提前结束循环仅支持HTTP或TCP/WebSocket叶子`.
The two failing requirements were nested gRPC admission and provisional saved
reference admission. The forbidden-protocol test already passed.

After the policy change:

- `node --test tests/plan-repeat-until-grpc-model.test.mjs tests/plan-if-grpc-model.test.mjs`: 6/6 passed.
- `node --test --test-concurrency=2 tests/plan-*model.test.mjs tests/plan-repeat-until.test.mjs tests/grpc.test.mjs tests/plan-repeat-grpc-workflow.test.mjs tests/plan-if-grpc-workflow.test.mjs`: 105/105 passed.
- `node --test tests/plan-repeat-until-grpc-workflow.test.mjs`: 39/39 passed.
- `node --test --test-concurrency=2 tests/plan-repeat-until-grpc-model.test.mjs tests/plan-repeat-until-grpc-workflow.test.mjs tests/plan-if-grpc-model.test.mjs tests/mcp.test.mjs`: 51/51 passed.
- `npm run check`, `npm run format:check`, and `git diff --check`: passed.
- Full `npm test`: running; not yet claimed as passed.

The old IF gRPC test's repeat-until rejection was obsolete under this explicit
capability extension; its runtime-row rejection matrix remains intact. The new
model suite independently tests nested fixed/IF/until admission, runtime-row
intersection, disabled nodes, saved reference resolution and malformed input.

## Transport and safety evidence

Real loopback peers exercise unary, server-streaming, client-streaming and bidi
RPCs, including withholding terminal completion: no following HTTP request or
tail decision occurs until the full response completes. Exact response counts,
last-message extraction, status 0/7, expected nonzero status, deadlines, overflow,
cancellation and stop/continue policies are asserted.

Owner HTTP, official MCP HTTP/stdio clients and a real CLI subprocess execute
frozen definitions and retain receipt/condition identity through persisted reload
and backup restore. Credentials are temporary, bound to stable leaf IDs, validated
before earlier HTTP work even beneath false IF, and not written into receipts.
Disabled ancestry needs no executor or credentials. Staged load and native linear
execution/export still reject these graphs before dispatch.

Real RPC extraction verifies atomic runtime/environment/global batch visibility
and tail conditions reading acknowledged values. An owner run also rereads a
fresh Store to verify both environment/global values and the saved tail decision. A deliberately synthetic
`onScopeChanges` uncertainty verifies fail-stop for both failure policies with no
tail decision, following request or replay. Separate real journal failure and
recovery cases verify run-record persistence uncertainty without re-executing
completed RPCs. Synthetic scope acknowledgement evidence is not described as a
real storage fault or external-service interoperability.
