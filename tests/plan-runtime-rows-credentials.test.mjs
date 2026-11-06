// Credential admission only: no network transport or execution is started.
import test from "node:test";
import assert from "node:assert/strict";
import { grpcPlanCredentials } from "../src/grpc-plan.mjs";
import { wirePlanCredentials } from "../src/wire-plan.mjs";
import { socketioPlanCredentials } from "../src/socketio-plan.mjs";

const optIn = { allowRuntimeRows: true };
const rows = () => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 2,
  steps: [{ id: "http", request: { url: "http://localhost/consume" } }],
});
const fixtures = [
  {
    name: "gRPC",
    helper: grpcPlanCredentials,
    leaf: {
      id: "secured",
      type: "grpc",
      grpc: {
        definition: {
          target: "grpc://localhost:50051",
          requiredMetadata: ["authorization"],
        },
        messages: [{}],
      },
    },
    credential: { metadata: [{ key: "authorization", value: "fixture-only" }] },
  },
  ...["websocket", "sse"].map((type) => ({
    name: type,
    helper: wirePlanCredentials,
    leaf: {
      id: "secured",
      type: "protocol",
      protocol: {
        definition: {
          type,
          url:
            type === "websocket" ? "ws://localhost" : "http://localhost/events",
          handshake: { requiredHeaders: ["authorization"] },
        },
      },
    },
    credential: { headers: { authorization: "fixture-only" } },
  })),
  {
    name: "Socket.IO",
    helper: socketioPlanCredentials,
    leaf: {
      id: "secured",
      type: "socketio",
      socketio: {
        definition: {
          url: "http://localhost:3000",
          version: 4,
          transport: "websocket",
          handshake: { requiredHeaders: ["authorization"] },
        },
        commands: [{ type: "wait", event: "hello", timeoutMs: 1000 }],
      },
    },
    credential: { headers: { authorization: "fixture-only" } },
  },
];

for (const { name, helper, leaf, credential } of fixtures) {
  const makePlan = () => ({
    steps: [
      rows(),
      { id: "fixed", type: "repeat", count: 2, steps: [structuredClone(leaf)] },
    ],
  });
  const input = () => ({ secured: structuredClone(credential) });

  test(`${name} runtime rows credential preflight is opt-in and still requires sibling credentials`, () => {
    const plan = makePlan();
    const before = structuredClone(plan);
    assert.throws(() => helper(plan, input()), /尚未启用/);
    assert.throws(() => helper(plan, input(), {}), /尚未启用/);
    assert.throws(
      () => helper(plan, input(), { allowRuntimeRows: false }),
      /尚未启用/,
    );
    assert.throws(() => helper(plan, {}, optIn));
    const supplied = input();
    const result = helper(plan, supplied, optIn);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get("secured"), credential);
    assert.notStrictEqual(result.get("secured"), supplied.secured);
    assert.deepEqual(plan, before);
    assert.throws(() => helper(plan, { unknown: credential }, optIn));
  });

  test(`${name} runtime rows opt-in preserves inherited enabled and supplied-map validation`, () => {
    const plan = makePlan();
    plan.steps[1].enabled = false;
    assert.equal(helper(plan, {}, optIn).size, 0);
    assert.equal(helper(plan, input(), optIn).size, 1);
    assert.throws(() =>
      helper(plan, { secured: { target: "elsewhere" } }, optIn),
    );
    plan.steps[1].enabled = true;
    plan.steps[1].steps[0].enabled = false;
    assert.equal(helper(plan, {}, optIn).size, 0);
    plan.steps[1].steps[0].enabled = true;
    plan.steps[0].enabled = false;
    assert.throws(() => helper(plan, {}, optIn));
    assert.equal(helper(plan, input(), optIn).size, 1);
    assert.throws(() => helper(plan, input()), /尚未启用/);
  });

  test(`${name} runtime rows credential opt-in does not admit non-HTTP/TCP dynamic bodies`, () => {
    const plan = { steps: [rows()] };
    plan.steps[0].steps = [{ ...structuredClone(leaf), enabled: false }];
    assert.throws(() => helper(plan, input(), optIn), /仅支持HTTP/);
  });
}
