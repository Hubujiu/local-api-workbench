import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import {
  validateRepeatGraph,
  REPEAT_EVIDENCE_BYTES,
} from "../src/plan-repeat.mjs";
import { socketioPlanCredentials } from "../src/socketio-plan.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { assertNativeLinearPlan } from "../src/native-mcp-plan.mjs";
import { prepareStagedLoad } from "../src/staged-load-plan.mjs";
const leaf = (extra = {}) => ({
  id: "rpc",
  type: "socketio",
  socketio: {
    definition: { url: "http://localhost:3000" },
    commands: [
      { type: "emit", event: "echo", args: ["{{value}}"], ackTimeoutMs: 100 },
    ],
  },
  extract: [{ name: "reply", path: "$[0].args[0]" }],
  ...extra,
});
const http = (id) => ({ id, request: { url: "http://example.invalid" } });
const condition = {
  op: "eq",
  left: { literal: true },
  right: { literal: true },
};
const gate = (steps) => ({ id: "gate", type: "if", condition, steps });
const rows = (steps, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const until = (steps, extra = {}) => ({
  id: "until",
  type: "repeat",
  count: 2,
  untilCondition: condition,
  steps,
  ...extra,
});
const response = () => ({ status: 200, headers: {}, body: "{}" });
const result = (value = "new") => ({
  status: "passed",
  state: "closed",
  durationMs: 0,
  results: [{ status: "acknowledged", args: [value] }],
  events: [],
});
const options = (items, extra = {}) => ({
  allowRuntimeRows: true,
  variableScopes: { runtime: { items } },
  executeSocketIO: async () => result(),
  ...extra,
});

test("canonical Socket.IO rows opt in and intersect symmetrically with IF, fixed and until controls", () => {
  for (const enabled of [true, false])
    for (const wrap of [
      (x) => rows([x]),
      (x) => rows([gate([until([x])])]),
      (x) => until([rows([gate([x])])]),
      (x) => ({ id: "fixed", type: "repeat", count: 2, steps: [rows([x])] }),
    ]) {
      const plan = { steps: [wrap(leaf({ enabled }))] };
      assert.throws(() => snapshotPlan(plan), /尚未启用/);
      assert.doesNotThrow(() => snapshotPlan(plan, { allowRuntimeRows: true }));
    }
  for (const type of ["sse", "socketio", "database"])
    for (const enabled of [true, false]) {
      const child = ["sse", "socketio"].includes(type)
        ? {
            id: "other",
            type: "protocol",
            protocol: { definition: { type } },
            enabled,
          }
        : { id: "other", type, enabled };
      assert.throws(
        () =>
          validateRepeatGraph([rows([gate([leaf(), child])])], {
            requireIds: true,
            allowRuntimeRows: true,
          }),
        /仅支持HTTP/,
      );
    }
});

test("Socket.IO runtime row saved references require resolution before freezing", () => {
  const child = leaf();
  child.socketio = { definitionId: "saved" };
  const steps = [rows([child])];
  assert.equal(validateRepeatGraph(steps, { allowRuntimeRows: true }), true);
  assert.throws(
    () =>
      validateRepeatGraph(steps, { allowRuntimeRows: true, requireIds: true }),
    /冻结前/,
  );
  child.socketio.definition = {};
  assert.throws(
    () => validateRepeatGraph(steps, { allowRuntimeRows: true }),
    /混合/,
  );
});

test("Socket.IO row quotas, staged/native and noncanonical script restrictions remain closed", () => {
  for (const extra of [
    {
      maxRows: 100,
      steps: [{ id: "fixed", type: "repeat", count: 3, steps: [leaf()] }],
    },
    { maxRows: 100, intervalMs: 1000 },
    { maxRows: 10, maxRowBytes: 512 * 1024, enabled: false },
  ])
    assert.throws(
      () =>
        snapshotPlan(
          { steps: [rows([leaf()], extra)] },
          { allowRuntimeRows: true },
        ),
      /200|60000|4MiB/,
    );
  for (const extra of [
    { beforeScript: "bad" },
    { nativeTask: {} },
    { socketioScripts: { version: 2, before: "", after: "" } },
    {
      socketioScripts: {
        version: 1,
        before: "",
        after: "",
        dialect: "apipost8",
      },
    },
  ])
    assert.throws(() =>
      snapshotPlan(
        { steps: [rows([leaf(extra)])] },
        { allowRuntimeRows: true },
      ),
    );
  const snapshot = snapshotPlan(
    { steps: [rows([leaf()])] },
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

for (const items of [[], [{ ok: false }]])
  test(`Socket.IO row credentials and executor preflight precede scripts with ${items.length} rows`, async () => {
    const child = leaf();
    child.socketio.definition.handshake = {
      requiredHeaders: ["authorization"],
    };
    const branch = gate([child]);
    branch.condition = {
      ...condition,
      left: { scope: "iterationData", name: "ok" },
    };
    const plan = { steps: [http("first"), rows([branch])] };
    const credential = {
      headers: { authorization: "fixture-secret" },
    };
    let calls = 0;
    const send = () => {
      calls++;
      return response();
    };
    await assert.rejects(
      runPlan(plan, {}, send, options(items)),
      /Header|凭据/,
    );
    await assert.rejects(
      runPlan(
        plan,
        {},
        send,
        options(items, {
          executeSocketIO: undefined,
          socketioCredentials: { rpc: credential },
        }),
      ),
      /未授权socketio/,
    );
    await assert.rejects(
      runPlan(
        plan,
        {},
        send,
        options(items, { socketioCredentials: { unknown: credential } }),
      ),
      /步骤|凭据/,
    );
    assert.equal(calls, 0);
    const admitted = socketioPlanCredentials(
      plan,
      { rpc: credential },
      { allowRuntimeRows: true },
    );
    assert.deepEqual([...admitted.keys()], ["rpc"]);
    const run = await runPlan(
      plan,
      {},
      send,
      options(items, {
        socketioCredentials: { rpc: credential },
        executeSocketIO: () => {
          throw Error("skipped branch executed");
        },
      }),
    );
    assert.equal(run.status, "passed");
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(run).includes("fixture-secret"), false);
  });

for (const items of [
  [{ ok: true }, null],
  [{ ok: true }, { ok: 1 }],
  [{}, {}, {}, {}],
])
  test("Socket.IO all rows and later condition operands validate before first child", async () => {
    const branch = gate([leaf()]);
    branch.condition = {
      ...condition,
      left: { scope: "iterationData", name: "ok" },
    };
    let calls = 0;
    const run = await runPlan(
      { steps: [rows([http("first-child"), branch])] },
      {},
      () => {
        calls++;
        return response();
      },
      options(items, {
        executeSocketIO: () => {
          calls++;
          return result();
        },
      }),
    );
    assert.equal(run.stopReason, "runtime-rows-error");
    assert.equal(calls, 0);
  });

for (const boundary of ["unknown-commit", "extraction", "evidence"])
  for (const policy of boundary === "unknown-commit"
    ? ["continue", "stop"]
    : ["stop"])
    test(`Socket.IO row ${boundary}/${policy} preserves transport evidence and stops subsequent controls`, async () => {
      const child = leaf({
        extract:
          boundary === "evidence"
            ? []
            : [
                { name: "reply", path: "$[0].args[0]", scope: "environment" },
                ...(boundary === "extraction"
                  ? [
                      {
                        name: "missing",
                        path: "$[0].missing",
                        scope: "environment",
                      },
                    ]
                  : []),
              ],
      });
      let calls = 0,
        commits = 0;
      const run = await runPlan(
        {
          failurePolicy: policy,
          steps: [
            rows([until([child, http("body-tail")], { intervalMs: 10000 })]),
            http("tail"),
          ],
        },
        { reply: "original", value: "sent" },
        () => {
          throw Error("unexpected HTTP");
        },
        options([{}, {}], {
          executeSocketIO: async () => {
            calls++;
            return result(
              boundary === "evidence"
                ? "x".repeat(REPEAT_EVIDENCE_BYTES + 1)
                : "new",
            );
          },
          onScopeChanges: async () => {
            commits++;
            throw new ProjectCommitUncertain("private diagnostic");
          },
        }),
      );
      assert.equal(calls, 1);
      assert.equal(commits, boundary === "unknown-commit" ? 1 : 0);
      assert.equal(run.status, "failed");
      assert.equal(run.variables.reply, "original");
      assert.equal(run.results[0].socketioResult.status, "passed");
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

for (const failurePolicy of ["continue", "stop"])
  for (const boundary of ["throw", "non-ok"])
    test(`Socket.IO rows ${boundary} retain ${failurePolicy} policy without extraction`, async () => {
      let calls = 0,
        consumers = 0;
      const child = leaf();
      const run = await runPlan(
        { failurePolicy, steps: [rows([child, http("consumer")])] },
        { value: "request", reply: "original" },
        () => {
          consumers++;
          return response();
        },
        options([{}, {}], {
          executeSocketIO: async () => {
            calls++;
            if (boundary === "throw") throw Error("fixture failure");
            return { ...result(), status: "failed" };
          },
        }),
      );
      assert.equal(run.status, "failed");
      assert.equal(run.variables.reply, "original");
      assert.equal(calls, failurePolicy === "stop" ? 1 : 2);
      assert.equal(consumers, failurePolicy === "stop" ? 0 : 2);
      for (const record of run.results.filter((x) => x.type === "socketio")) {
        assert.deepEqual(record.extracted, {});
        if (boundary === "non-ok")
          assert.equal(record.socketioResult.status, "failed");
        else assert.equal(record.socketioResult, undefined);
      }
    });
