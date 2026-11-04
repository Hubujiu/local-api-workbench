import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { prepareStagedLoad, runStagedLoad } from "../src/staged-load-plan.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  assertNativeLinearPlan,
  buildNativeMCPPlan,
  nativeFlowView,
} from "../src/native-mcp-plan.mjs";
import {
  assertNativeLinearResult,
  nativeExecutionHistory,
  nativeRunResult,
} from "../src/native-mcp-tools.mjs";
import { createNativeWriteExecution } from "../src/native-write-execution.mjs";

const leaf = (id = "http", url = "http://127.0.0.1:1/") => ({
  id,
  request: { url },
});
const rows = (extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 2,
  steps: [leaf()],
  ...extra,
});
const condition = (steps) => ({
  id: "if",
  type: "if",
  condition: { op: "eq", left: { literal: false }, right: { literal: true } },
  steps,
});
const project = (plans = []) => ({
  id: "project",
  name: "Rows consumer boundaries",
  requests: [],
  plans,
  settings: {},
  environments: [{ id: "env", name: "Default", variables: {} }],
  currentEnvironmentId: "env",
  folders: [],
  servers: [],
  globalVariables: {},
});
const schedule = {
  initialVUs: 1,
  stages: [{ durationSeconds: 1, targetVUs: 1 }],
  maxIterations: 1,
};
const stagedError = /阶段压测尚不支持运行时数据行循环/;
const response = () => ({ status: 200, headers: {}, body: "ok" });

for (const enabled of [true, false]) {
  for (const canonical of [false, true]) {
    test(`staged load refuses runtime rows definitions: enabled=${enabled}, canonical=${canonical}`, async () => {
      let plan = { steps: [rows({ enabled })] };
      if (canonical) plan = snapshotPlan(plan, { allowRuntimeRows: true });
      // An empty source and an opt-in intended for canonical execution cannot
      // change a restricted consumer's static admission contract.
      const options = { allowRuntimeRows: canonical, variables: { items: [] } };
      assert.throws(
        () => prepareStagedLoad(project(), plan, schedule, options),
        stagedError,
      );
      const prepared = {
        snapshot: plan,
        schedule,
        selected: project().environments[0],
      };
      const noRead = new Proxy(
        {},
        {
          get() {
            assert.fail("project/scopes accessed before admission");
          },
        },
      );
      await assert.rejects(
        runStagedLoad(noRead, prepared, options),
        stagedError,
      );
    });
  }
}

test("staged load refuses runtime rows under disabled or false parents", async () => {
  for (const group of [
    condition([rows()]),
    { ...condition([rows()]), enabled: false },
    { id: "fixed", type: "repeat", enabled: false, count: 1, steps: [rows()] },
  ]) {
    const plan = snapshotPlan(
      { steps: [leaf("sibling"), group] },
      { allowRuntimeRows: true },
    );
    assert.throws(
      () => prepareStagedLoad(project(), plan, schedule),
      stagedError,
    );
    await assert.rejects(
      runStagedLoad(project(), { snapshot: plan }),
      stagedError,
    );
  }
});

test("legacy fixed rows and ordinary if retain staged admission and native rejection", () => {
  const definitions = [
    {
      id: "fixed",
      type: "repeat",
      count: 2,
      rows: [{ n: 1 }, { n: 2 }],
      steps: [leaf()],
    },
    condition([leaf()]),
  ];
  for (const definition of definitions) {
    const plan = snapshotPlan({ steps: [definition] });
    assert.doesNotThrow(() => prepareStagedLoad(project(), plan, schedule));
    assert.throws(() => assertNativeLinearPlan(plan), /循环组或条件组/);
  }
  assert.doesNotThrow(() =>
    assertNativeLinearPlan(snapshotPlan({ steps: [leaf()] })),
  );
});

for (const enabled of [true, false]) {
  test(`native definition and result consumers retain all-group rejection: enabled=${enabled}`, () => {
    for (const canonical of [false, true]) {
      let plan = { steps: [rows({ enabled })] };
      if (canonical) plan = snapshotPlan(plan, { allowRuntimeRows: true });
      const before = structuredClone(plan);
      assert.throws(() => assertNativeLinearPlan(plan), /循环组或条件组/);
      assert.throws(() => nativeFlowView("project", plan), /循环组或条件组/);
      assert.throws(
        () =>
          buildNativeMCPPlan(project(), { name: "rename" }, plan, () =>
            assert.fail("request normalized"),
          ),
        /循环组或条件组/,
      );
      assert.throws(
        () => assertNativeLinearResult({ snapshot: plan, results: [] }),
        /循环组或条件组/,
      );
      assert.throws(() => exportApipost(project([plan])), /plans/);
      assert.throws(
        () => exportApipostDirectory(project([plan])),
        /仅支持HTTP步骤/,
      );
      assert.throws(
        () => createNativeWriteExecution({ snapshot: { plan } }, {}),
        enabled ? /尚不支持原生写入执行/ : /原生写入授权与冻结请求不匹配/,
      );
      assert.deepEqual(plan, before);
    }
  });
}

test("native-write runtime admission rejects empty runtime rows before any script or transport", async (t) => {
  let network = 0,
    prepared = 0,
    steps = 0,
    writes = 0;
  const server = createServer((req, res) => {
    network++;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const first = leaf("first", url);
  first.request.beforeScript = 'pm.environment.set("scriptRan", "yes")';
  for (const allowRuntimeRows of [false, true]) {
    const variables = {};
    await assert.rejects(
      runPlan(
        { steps: [first, rows({ steps: [leaf("body", url)] })] },
        variables,
        executeRequest,
        {
          allowRuntimeRows,
          variableScopes: { runtime: { items: [] } },
          nativeWrite: {},
          prepareRequest() {
            prepared++;
          },
          onStep() {
            steps++;
          },
          databaseQuery() {
            writes++;
          },
        },
      ),
      allowRuntimeRows ? /尚不支持原生写入执行/ : /尚未启用/,
    );
    assert.deepEqual(variables, {});
  }
  assert.deepEqual(
    { network, prepared, steps, writes },
    { network: 0, prepared: 0, steps: 0, writes: 0 },
  );
});

test("disabled runtime rows remain inactive in canonical execution without loosening native authorization", async () => {
  const plan = { steps: [rows({ enabled: false }), leaf("tail")] };
  let calls = 0;
  await assert.rejects(
    runPlan(plan, {}, () => {
      calls++;
      return response();
    }),
    /尚未启用/,
  );
  const result = await runPlan(
    plan,
    {},
    () => {
      calls++;
      return response();
    },
    { allowRuntimeRows: true },
  );
  assert.equal(result.status, "passed");
  assert.equal(calls, 1);
  await assert.rejects(
    runPlan(
      plan,
      {},
      () => {
        calls++;
        return response();
      },
      { allowRuntimeRows: true, nativeWrite: {} },
    ),
    /原生写入授权与冻结请求不匹配/,
  );
  assert.equal(calls, 1);
});

test("restored sparse runtime-row failures cannot lose evidence through native MCP projections", () => {
  for (const failure of [
    { stopReason: "runtime-rows-error" },
    { runtimeRowsFailure: { code: "PLAN_RUNTIME_ROWS_INVALID" } },
    {
      stopReason: "runtime-rows-error",
      runtimeRowsFailure: { code: "PLAN_RUNTIME_ROWS_INVALID" },
    },
  ]) {
    const restored = restoreProject({
      ...project(),
      version: 1,
      runs: [{ id: "sparse", status: "failed", results: [], ...failure }],
    });
    const run = restored.runs[0];
    assert.equal(run.snapshot, undefined);
    for (const [key, value] of Object.entries(failure))
      assert.deepEqual(run[key], value);
    assert.throws(() => assertNativeLinearResult(run), /循环组或条件组/);
    assert.throws(() => nativeExecutionHistory(restored, {}), /循环组或条件组/);
    assert.throws(() => nativeRunResult(restored.id, run), /循环组或条件组/);
  }
  const ordinary = { id: "legacy", status: "passed", results: [] };
  assert.doesNotThrow(() => assertNativeLinearResult(ordinary));
  assert.equal(nativeExecutionHistory({ runs: [ordinary] }, {}).total, 1);
});
