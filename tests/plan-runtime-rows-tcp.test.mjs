import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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
const wire = (port = 12345, type = "tcp") => ({
  id: "tcp",
  type: "protocol",
  protocol: {
    definition: {
      type,
      url:
        type === "tcp"
          ? "127.0.0.1"
          : type === "sse"
            ? "http://localhost"
            : "ws://localhost",
      ...(type === "tcp" ? { port, completion: "end", duration: 1000 } : {}),
    },
    message: "{{value}}",
  },
  extract: [{ name: "reply", path: "$.body" }],
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
async function peer(t, reply = (s, data) => s.end(data)) {
  const received = [],
    sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
    s.once("data", (data) => {
      received.push(data.toString());
      reply(s, data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return { port: server.address().port, received };
}

test("real TCP runtime rows retain row binding, nested branch/fixed-repeat scope", async (t) => {
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
  test("all malformed/over-limit rows fail before TCP or HTTP", async (t) => {
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

test("canonical TCP admission keeps other protocols, default gate and credential overrides closed", async () => {
  const plan = { steps: [rows([wire()])] };
  assert.throws(() => snapshotPlan(plan), /尚未启用/);
  assert.equal(
    snapshotPlan(plan, { allowRuntimeRows: true }).steps[0].steps[0].protocol
      .definition.type,
    "tcp",
  );
  assert.equal(
    wirePlanCredentials(plan, {}, { allowRuntimeRows: true }).size,
    0,
  );
  assert.throws(
    () =>
      wirePlanCredentials(
        plan,
        { tcp: { headers: { authorization: "secret" } } },
        { allowRuntimeRows: true },
      ),
    /TCP/,
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

test("abort during real TCP stops remaining rows and retains cancelled transport evidence", async (t) => {
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
  test(`unknown TCP child scope commit fails stopped under ${policy}`, async (t) => {
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
    assert.equal(run.results[0].protocolResult.result.body, "sent");
  });

test("real TCP timeout retains failure evidence and ordinary stop policy", async (t) => {
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
  assert.equal(run.results[0].protocolResult.status, "failed");
  assert.deepEqual(p.received, ["sent"]);
});

test("scripted TCP consumes actual row data/count and freezes rows across source replacement", async (t) => {
  const p = await peer(t);
  const child = wire(p.port);
  child.protocolScripts = {
    version: 1,
    before:
      "pm.variables.set('value', pm.iterationData.get('value') + '/' + pm.info.iteration + '/' + pm.info.iterationCount);",
    after: "",
  };
  child.extract = [{ name: "items", path: "$.body" }];
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

test("TCP row admission does not authorize imported native script formats", async () => {
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
