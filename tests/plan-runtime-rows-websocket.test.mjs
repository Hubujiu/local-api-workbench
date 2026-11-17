import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { executeWireFlow, wirePlanCredentials } from "../src/wire-plan.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const http = (id = "bind") => ({
  id,
  request: {
    url: "http://example.test",
    beforeScript: "pm.environment.set('value', pm.iterationData.get('value'));",
  },
});
const wire = (port = 12345, type = "websocket") => ({
  id: "websocket",
  type: "protocol",
  protocol: {
    definition: {
      type,
      url: type === "websocket" ? `ws://127.0.0.1:${port}` : "http://localhost",
      duration: 1000,
    },
    message: "{{value}}",
  },
  extract: [{ name: "reply", path: "$.messages[0].data" }],
});
const rows = (steps, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const branch = (steps) => ({
  id: "gate",
  type: "if",
  condition: {
    op: "eq",
    left: { scope: "iterationData", name: "ok" },
    right: { literal: true },
  },
  steps,
});
const opts = (items, extra = {}) => ({
  allowRuntimeRows: true,
  variableScopes: { runtime: { items } },
  executeProtocol: executeWireFlow,
  ...extra,
});
const response = async () => ({ status: 200, headers: {}, body: "{}" });
async function peer(
  t,
  reply = (s, data) => {
    s.send(data);
    s.close(1000);
  },
) {
  const received = [];
  let connections = 0;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (s) => {
    connections++;
    s.on("error", () => {});
    s.once("message", (data) => {
      received.push(data.toString());
      reply(s, data.toString());
    });
  });
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    for (const s of server.clients) s.terminate();
    await new Promise((r) => server.close(r));
  });
  return {
    port: server.address().port,
    received,
    get connections() {
      return connections;
    },
  };
}

test("real WebSocket runtime rows retain row binding, nested branch/fixed-repeat scope", async (t) => {
  const p = await peer(t);
  const plan = {
    steps: [
      rows([
        http(),
        branch([
          { id: "fixed", type: "repeat", count: 2, steps: [wire(p.port)] },
        ]),
      ]),
    ],
  };
  const run = await runPlan(
    plan,
    {},
    response,
    opts([
      { value: "a", ok: true },
      { value: "skip", ok: false },
      { value: "b", ok: true },
    ]),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(p.received, ["a", "a", "b", "b"]);
  assert.equal(p.connections, 4);
  assert.equal(run.variables.reply, "b");
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, false, true],
  );
  assert.equal(run.snapshot.steps[0].maxRows, 3);
});

for (const items of [
  [
    { value: "a", ok: true },
    { value: "bad", ok: 1 },
  ],
  [{ value: "a", ok: true }, null],
  Array.from({ length: 4 }, () => ({ ok: true })),
])
  test("all malformed/over-limit rows fail before WebSocket or HTTP", async (t) => {
    const p = await peer(t);
    let calls = 0;
    const run = await runPlan(
      { steps: [rows([http(), branch([wire(p.port)])])] },
      {},
      async () => {
        calls++;
        return response();
      },
      opts(items),
    );
    assert.equal(run.stopReason, "runtime-rows-error");
    assert.equal(calls, 0);
    assert.deepEqual(p.received, []);
  });

test("canonical WebSocket admission keeps other protocols and default gate closed", async () => {
  const plan = { steps: [rows([wire()])] };
  assert.throws(() => snapshotPlan(plan), /尚未启用/);
  assert.equal(
    snapshotPlan(plan, { allowRuntimeRows: true }).steps[0].steps[0].protocol
      .definition.type,
    "websocket",
  );
  assert.equal(
    wirePlanCredentials(plan, {}, { allowRuntimeRows: true }).size,
    0,
  );
  for (const type of ["unknown"])
    for (const enabled of [true, false])
      assert.throws(
        () =>
          snapshotPlan(
            { steps: [rows([branch([{ ...wire(1, type), enabled }])])] },
            { allowRuntimeRows: true },
          ),
        /仅支持HTTP或TCP/,
      );
  let calls = 0;
  await assert.rejects(
    runPlan(
      { steps: [http("first"), rows([wire()])] },
      {},
      async () => {
        calls++;
        return response();
      },
      opts([], { executeProtocol: undefined }),
    ),
    /未授权protocol/,
  );
  assert.equal(calls, 0);
});

test("abort during real WebSocket stops remaining rows and retains cancelled transport evidence", async (t) => {
  const controller = new AbortController();
  const p = await peer(t, () => controller.abort());
  const run = await runPlan(
    { steps: [rows([http(), wire(p.port)])] },
    {},
    response,
    opts([{ value: "a" }, { value: "b" }], { signal: controller.signal }),
  );
  assert.equal(run.status, "cancelled");
  assert.deepEqual(p.received, ["a"]);
  assert.equal(run.results.at(-1).protocolResult.status, "cancelled");
});

for (const policy of ["continue", "stop"])
  test(`unknown WebSocket child scope commit fails stopped under ${policy}`, async (t) => {
    const p = await peer(t);
    const child = wire(p.port);
    child.extract[0].scope = "environment";
    const run = await runPlan(
      { failurePolicy: policy, steps: [rows([child])] },
      { value: "sent" },
      response,
      opts([{}, {}], {
        onScopeChanges: async () => {
          throw new ProjectCommitUncertain("secret");
        },
      }),
    );
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.deepEqual(p.received, ["sent"]);
    assert.deepEqual(run.results[0].extracted, {});
    assert.equal(run.results[0].protocolResult.result.messages[0].data, "sent");
  });

test("real WebSocket timeout retains failure evidence and ordinary stop policy", async (t) => {
  const p = await peer(t, () => {});
  const child = wire(p.port);
  child.protocol.definition.duration = 100;
  const run = await runPlan(
    { failurePolicy: "stop", steps: [rows([child])] },
    { value: "sent" },
    response,
    opts([{}, {}]),
  );
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].protocolResult.status, "partial");
  assert.deepEqual(p.received, ["sent"]);
});

test("scripted WebSocket consumes actual row data/count and freezes rows across source replacement", async (t) => {
  const p = await peer(t);
  const child = wire(p.port);
  child.protocolScripts = {
    version: 1,
    before:
      "pm.variables.set('value', pm.iterationData.get('value') + '/' + pm.info.iteration + '/' + pm.info.iterationCount);",
    after: "",
  };
  child.extract = [{ name: "items", path: "$.messages[0].data" }];
  const run = await runPlan(
    { steps: [rows([child])] },
    {},
    response,
    opts([{ value: "a" }, { value: "b" }]),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(p.received, ["a/0/2", "b/1/2"]);
  assert.equal(run.variables.items, "b/1/2");
});

test("WebSocket row admission does not authorize imported native script formats", async () => {
  for (const extra of [
    { beforeScript: "throw Error('not canonical')" },
    { nativeTask: {} },
    { protocolScripts: { version: 2, before: "", after: "" } },
    {
      protocolScripts: {
        version: 1,
        before: "",
        after: "",
        dialect: "apipost8",
      },
    },
  ]) {
    let effects = 0;
    await assert.rejects(
      runPlan(
        { steps: [http("first"), rows([{ ...wire(), ...extra }])] },
        {},
        async () => {
          effects++;
          return response();
        },
        opts([{}], {
          executeProtocol: async () => {
            effects++;
          },
        }),
      ),
    );
    assert.equal(effects, 0);
  }
});

test("WS until nested in runtime rows sees frozen iterationData and committed extraction", async (t) => {
  const p = await peer(t);
  const child = wire(p.port);
  child.protocolScripts = {
    version: 1,
    before: "pm.variables.set('value', pm.iterationData.get('value'));",
    after: "",
  };
  const run = await runPlan(
    {
      steps: [
        rows([
          {
            id: "until",
            type: "repeat",
            count: 2,
            untilCondition: {
              op: "eq",
              left: { scope: "runtime", name: "reply" },
              right: { scope: "iterationData", name: "value" },
            },
            steps: [child],
          },
        ]),
      ],
    },
    {},
    response,
    opts([{ value: "a" }, { value: "b" }]),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(p.received, ["a", "b"]);
  assert.equal(p.connections, 2);
  assert.deepEqual(
    run.conditionResults.map((x) => x.matched),
    [true, true],
  );
});

for (const expectedStatus of ["completed", "partial"])
  for (const failurePolicy of ["continue", "stop"])
    test(`WS row timeout preserves partial evidence: expected=${expectedStatus}, policy=${failurePolicy}`, async (t) => {
      const p = await peer(t, (s, data) => s.send(data));
      const child = wire(p.port);
      child.protocol.definition.duration = 100;
      child.expectedStatus = expectedStatus;
      child.extract[0].scope = "environment";
      let commits = 0;
      const run = await runPlan(
        { failurePolicy, steps: [rows([child])] },
        { value: "echo" },
        response,
        opts([{}, {}], {
          onScopeChanges: async () => {
            commits++;
          },
        }),
      );
      const passed = expectedStatus === "partial";
      const count = !passed && failurePolicy === "stop" ? 1 : 2;
      assert.equal(run.status, passed ? "passed" : "failed");
      assert.equal(p.connections, count);
      assert.equal(run.results.length, count);
      assert.equal(commits, passed ? 1 : 0);
      assert.equal(run.variables.reply, passed ? "echo" : undefined);
      assert.ok(
        run.results.every((x) => x.protocolResult.status === "partial"),
      );
    });

test("WS rows preflight potential false-branch executor and stable leaf credentials before scripts", async () => {
  const child = wire();
  child.protocol.definition.handshake = { requiredHeaders: ["authorization"] };
  const plan = { steps: [http("first"), rows([branch([child])])] };
  let calls = 0;
  const send = () => {
    calls++;
    return response();
  };
  await assert.rejects(
    runPlan(
      plan,
      {},
      send,
      opts([], {
        executeProtocol: undefined,
        protocolCredentials: {
          websocket: { headers: { authorization: "secret" } },
        },
      }),
    ),
    /未授权protocol/,
  );
  await assert.rejects(runPlan(plan, {}, send, opts([])), /Header/);
  await assert.rejects(
    runPlan(
      plan,
      {},
      send,
      opts([], {
        protocolCredentials: {
          unknown: { headers: { authorization: "secret" } },
        },
      }),
    ),
    /步骤|凭据/,
  );
  assert.equal(calls, 0);
  const run = await runPlan(
    plan,
    {},
    send,
    opts([{ ok: false }], {
      protocolCredentials: {
        websocket: { headers: { authorization: "secret" } },
      },
      executeProtocol: () => {
        throw Error("false branch executed");
      },
    }),
  );
  assert.equal(run.status, "passed");
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(run).includes("secret"), false);
});

test("WS rows enforce unsupported sibling intersections, bounded-work quotas, staged and native restrictions", async () => {
  const { validateRepeatGraph } = await import("../src/plan-repeat.mjs");
  const { prepareStagedLoad } = await import("../src/staged-load-plan.mjs");
  const { assertNativeLinearPlan } = await import("../src/native-mcp-plan.mjs");
  for (const type of ["unknown", "database"])
    for (const enabled of [true, false]) {
      const child = type === "unknown" ? wire(1, type) : { id: type, type };
      assert.throws(
        () =>
          snapshotPlan(
            { steps: [rows([wire(), { ...child, enabled }])] },
            { allowRuntimeRows: true },
          ),
        /仅支持HTTP|未知循环计划步骤类型/,
      );
    }
  for (const extra of [
    {
      maxRows: 100,
      steps: [{ id: "fixed", type: "repeat", count: 3, steps: [wire()] }],
    },
    { maxRows: 100, intervalMs: 1000 },
    { maxRows: 10, maxRowBytes: 512 * 1024, enabled: false },
  ])
    assert.throws(
      () =>
        validateRepeatGraph([rows([wire()], extra)], {
          allowRuntimeRows: true,
          requireIds: true,
        }),
      /200|60000|4MiB/,
    );
  const snapshot = snapshotPlan(
    { steps: [rows([wire()])] },
    { allowRuntimeRows: true },
  );
  assert.throws(() => assertNativeLinearPlan(snapshot), /canonical|循环|条件/);
  assert.throws(
    () =>
      prepareStagedLoad({}, snapshot, {
        initialVUs: 1,
        stages: [{ durationSeconds: 1, targetVUs: 1 }],
        maxIterations: 1,
      }),
    /HTTP/,
  );
});

for (const boundary of ["unknown-commit", "extraction", "evidence"])
  test(`WS rows with nested until stop at ${boundary} without another decision or row`, async () => {
    const { REPEAT_EVIDENCE_BYTES } = await import("../src/plan-repeat.mjs");
    const child = wire();
    child.extract =
      boundary === "evidence"
        ? []
        : [
            { name: "reply", path: "$.messages[0].data", scope: "environment" },
            ...(boundary === "extraction"
              ? [{ name: "absent", path: "$.missing", scope: "environment" }]
              : []),
          ];
    let exchanges = 0,
      commits = 0;
    const run = await runPlan(
      {
        failurePolicy: boundary === "unknown-commit" ? "continue" : "stop",
        steps: [
          rows([
            {
              id: "until",
              type: "repeat",
              count: 2,
              intervalMs: 10000,
              untilCondition: {
                op: "eq",
                left: { literal: false },
                right: { literal: true },
              },
              steps: [child, http("body-tail")],
            },
          ]),
          http("tail"),
        ],
      },
      { reply: "original", value: "sent" },
      () => {
        throw Error("unexpected HTTP");
      },
      opts([{}, {}], {
        executeProtocol: async () => {
          exchanges++;
          return {
            status: "completed",
            result: {
              messages: [
                {
                  data:
                    boundary === "evidence"
                      ? "x".repeat(REPEAT_EVIDENCE_BYTES + 1)
                      : "updated",
                },
              ],
            },
          };
        },
        onScopeChanges: async () => {
          commits++;
          throw new ProjectCommitUncertain("private diagnostic");
        },
      }),
    );
    assert.equal(exchanges, 1);
    assert.equal(commits, boundary === "unknown-commit" ? 1 : 0);
    assert.equal(run.status, "failed");
    assert.equal(run.variables.reply, "original");
    assert.equal(run.results[0].protocolResult.status, "completed");
    assert.deepEqual(run.results[0].extracted, {});
    assert.deepEqual(run.conditionResults, []);
    assert.equal(
      run.stopReason,
      boundary === "unknown-commit"
        ? "scope-commit-unknown"
        : boundary === "evidence"
          ? "evidence-limit"
          : "step-failure",
    );
    assert.equal(JSON.stringify(run).includes("private diagnostic"), false);
  });

test("rows and until intersect symmetrically for enabled and disabled mixed protocol graphs", async () => {
  const { validateRepeatGraph } = await import("../src/plan-repeat.mjs");
  const until = (steps) => ({
    id: "until",
    type: "repeat",
    count: 2,
    untilCondition: {
      op: "eq",
      left: { literal: true },
      right: { literal: true },
    },
    steps,
  });
  for (const wrap of [
    (leaf) => rows([until([leaf])]),
    (leaf) => until([rows([leaf])]),
  ])
    for (const enabled of [true, false])
      for (const type of ["tcp", "websocket", "sse", "grpc", "socketio"]) {
        const child = ["grpc", "socketio"].includes(type)
          ? {
              id: type,
              type,
              enabled,
              [type]: { definition: {} },
            }
          : { ...wire(12345, type), enabled };
        const check = () =>
          validateRepeatGraph([wrap(child)], {
            allowRuntimeRows: true,
            requireIds: true,
          });
        if (["tcp", "websocket", "sse", "grpc", "socketio"].includes(type))
          assert.equal(check(), true);
        else assert.throws(check, /仅支持HTTP/);
      }
});
