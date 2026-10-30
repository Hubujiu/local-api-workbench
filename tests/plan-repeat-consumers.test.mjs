import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  snapshotPlan,
  runPlan,
  restoreProject,
  importIntoProject,
} from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { createMCP } from "../src/mcp.mjs";
import { scopedExecution } from "../src/variable-scopes.mjs";
import {
  environmentVariables,
  resolveServiceRequest,
  freezeServiceBinding,
} from "../src/environments.mjs";
import { recordPlanRun } from "../src/plan-evidence.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { listExecutionHistory } from "../src/execution-history.mjs";

async function fixture(t, reply) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-consumers-"));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        reply?.(req, seen) ?? {
          token: "response-token",
          second: "response-second",
        },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    project = await store.create("repeat-project");
  return {
    root,
    store,
    project,
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}
const pick = {
  type: "pickVars",
  enabled: 1,
  data: {
    source: "responseJson",
    variables: [
      { name: "token", expression: "$.token", type: "envVars" },
      { name: "second", expression: "$.second", type: "envVars" },
    ],
  },
};
const group = (steps, count = 3) => ({
  type: "repeat",
  id: "group",
  count,
  steps,
});
const leaf = (id, url, extra = {}) => ({
  id,
  request: { url, inheritSharedScripts: false, ...extra },
});
const invokeCLI = (root, project, plan, grants) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        project,
        "--plan",
        plan,
        ...(grants ? ["--database-stdin"] : []),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("repeat CLI fixture timeout"));
    }, 15000);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.on("error", () => {});
    child.stdin.end(
      grants ? JSON.stringify({ databaseConnections: grants }) : undefined,
    );
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

test("native strict extraction stops all later iterations and native adapters reject graph loss before mutation or HTTP", async (t) => {
  let logins = 0;
  const f = await fixture(t, (req) =>
    req.url === "/login"
      ? ++logins === 1
        ? { token: "fresh-one", second: "committed" }
        : { token: "must-not-commit" }
      : {},
  );
  const p = f.project;
  p.environments[0].variables = { token: "old", second: "old" };
  const plan = snapshotPlan({
    name: "Strict repeated login",
    environmentId: p.environments[0].id,
    steps: [
      group([
        leaf("login", f.url + "/login", {
          nativeTasks: { version: 1, before: [], after: [pick] },
        }),
        leaf("consume", f.url + "/consume", {
          headers: [{ key: "X-Token", value: "{{token}}" }],
        }),
      ]),
      leaf("after", f.url + "/after"),
    ],
  });
  plan.steps[0] = {
    type: "repeat",
    id: "outer-strict",
    name: "outer",
    enabled: true,
    count: 2,
    steps: [plan.steps[0]],
  };
  p.plans.push(plan);
  await f.store.save(p);
  const run = await runPlan(
    plan,
    environmentVariables(p),
    executeRequest,
    scopedExecution(f.store, p, p.environments[0].id),
  );
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 3);
  assert.deepEqual(
    run.results.map((r) => [r.stepId, r.repeat.iteration]),
    [
      ["login", 0],
      ["consume", 0],
      ["login", 1],
    ],
  );
  assert.deepEqual(run.results[2].repeat.path, [
    { groupId: "outer-strict", iteration: 0 },
    { groupId: "group", iteration: 1 },
  ]);
  assert.equal(run.results[2].response.status, 200);
  assert.match(run.results[2].error, /路径|提取/);
  assert.equal(run.variables.token, "fresh-one");
  assert.equal(run.variables.second, "committed");
  assert.equal(f.seen[1].headers["x-token"], "fresh-one");
  const saved = await recordPlanRun(f.store, p.id, run, "manual");
  assert.equal(saved.recordSaved, true);
  const current = await new Store(f.root).get(p.id);
  assert.equal(environmentVariables(current).token, "fresh-one");
  assert.equal(current.runs[0].results.length, 3);
  assert.deepEqual(
    listExecutionHistory(current)[0].failedSteps[0].repeat,
    run.results[2].repeat,
  );
  const before = structuredClone(current),
    dispatch = createMCP({
      store: f.store,
      projects: [p.id],
      write: true,
      execute: true,
    });
  let id = 0;
  for (const [name, args] of [
    ["apipost_execute_flow", { project_id: p.id, flow_id: plan.id }],
    ["apipost_get_execution_flow", { project_id: p.id, flow_id: plan.id }],
    [
      "apipost_update_execution_flow",
      { project_id: p.id, flow_id: plan.id, name: "must-not-save" },
    ],
    ["apipost_list_execution_flows", { project_id: p.id }],
    ["apipost_list_execution_runs", { project_id: p.id }],
    ["apipost_get_execution_result", { project_id: p.id, run_id: run.id }],
  ]) {
    const answer = await dispatch({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(answer.result.isError, true, JSON.stringify(answer));
    assert.match(answer.result.content[0].text, /循环组/);
  }
  assert.throws(() => exportApipostDirectory(current), /HTTP步骤/);
  assert.deepEqual(await f.store.get(p.id), before);
  assert.equal(
    f.seen.length,
    3,
    "unsupported native projections never replay the graph",
  );
  const restored = restoreProject(current);
  await f.store.save(restored);
  assert.equal(restored.plans[0].steps[0].type, "repeat");
  const bad = structuredClone(restored);
  bad.plans[0].steps[0].steps[0].steps[0].request.importedNativeTaskSource = {
    version: 2,
    before: [],
    after: [],
  };
  await assert.rejects(f.store.save(bad), /来源/);
  assert.throws(() => restoreProject(bad), /来源/);
  assert.equal(
    (await f.store.get(restored.id)).plans[0].steps[0].steps[0].steps[0].request
      .importedNativeTaskSource,
    undefined,
  );
});

test("CLI grants traverse enabled loop definitions once and mixed native database/extraction tasks persist without retaining authority", async (t) => {
  const f = await fixture(t),
    p = f.project;
  const filename = path.join(f.root, "fixture.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE rows(value TEXT); INSERT INTO rows VALUES('db-token')");
  db.close();
  const task = {
    type: "database",
    enabled: 1,
    data: {
      connectionId: "fixture",
      query: "SELECT value FROM rows",
      isConsoleOutput: -1,
      variables: [
        { name: "token", type: "environment", pattern: "$[0].value" },
      ],
    },
  };
  const request = {
    headers: [{ key: "X-Token", value: "{{token}}" }],
    nativeTasks: { version: 1, before: [task], after: [pick] },
  };
  const disabled = group(
    [
      leaf("disabled-db", f.url + "/disabled", {
        nativeTasks: {
          version: 1,
          before: [
            { ...task, data: { ...task.data, connectionId: "not-granted" } },
          ],
          after: [],
        },
      }),
    ],
    1,
  );
  disabled.id = "disabled-group";
  disabled.enabled = false;
  const plan = snapshotPlan({
    name: "CLI repeated database",
    steps: [disabled, group([leaf("db", f.url + "/db", request)], 2)],
  });
  p.plans.push(plan);
  await f.store.save(p);
  const other = await f.store.create("other"),
    otherBefore = await f.store.get(other.id);
  const passed = await invokeCLI(f.root, p.id, plan.id, {
    fixture: { type: "sqlite", filename },
  });
  assert.equal(passed.code, 0, passed.stderr + passed.stdout);
  const run = JSON.parse(passed.stdout);
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, 2);
  assert.deepEqual(
    f.seen.map((r) => r.headers["x-token"]),
    ["db-token", "db-token"],
  );
  assert.equal(run.variables.token, "response-token");
  const current = await new Store(f.root).get(p.id);
  assert.equal(environmentVariables(current).token, "response-token");
  assert.equal(JSON.stringify(current).includes(filename), false);
  const restarted = await invokeCLI(f.root, p.id, plan.id);
  assert.equal(restarted.code, 1, restarted.stdout + restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout).results.length, 1);
  assert.equal(
    f.seen.length,
    2,
    "new invocation without grants performs no HTTP",
  );
  assert.deepEqual(await f.store.get(other.id), otherBefore);
});

test("graph-bound loop leaves freeze before storage and remain trusted only within the stored project through restore", async (t) => {
  const f = await fixture(t),
    source = nativeInheritanceFixture();
  source.global.envs[0].server_list[0].uri = f.url;
  source.global.envs[0].env_var_list.token = {
    value: "first",
    current_value: "first",
  };
  const p = f.project;
  importIntoProject(p, source, {
    inheritanceMode: "preserve",
  });
  const plan = versionPlan(
    undefined,
    {
      name: "Graph loop",
      steps: [group([{ id: "bound", request: p.requests[0] }], 2)],
    },
    "manual",
    p,
  );
  assert.equal(plan.steps[0].steps[0].request.nativeInheritance, undefined);
  p.plans.push(plan);
  await f.store.save(p);
  p.settings.nativeInheritance.projectLayer.headers[0].value = "live-edited";
  p.environments[0].variables.token = "second";
  await f.store.save(p);
  const current = await f.store.get(p.id),
    frozen = current.plans[0].steps[0].steps[0].request;
  assert.deepEqual(freezeServiceBinding(current, frozen), frozen);
  const reused = versionPlan(
    undefined,
    {
      name: "Reused stored leaf",
      steps: [group([{ id: "reused", request: frozen }], 2)],
    },
    "manual",
    current,
  );
  const restored = restoreProject(current);
  await f.store.save(restored);
  const reload = await new Store(f.root).get(restored.id);
  const run = await runPlan(
    reload.plans[0],
    environmentVariables(reload),
    executeRequest,
    {
      prepareRequest: (r) => resolveServiceRequest(reload, r),
    },
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(
    f.seen.map((r) => [r.headers["x-shared"], r.headers.authorization]),
    [
      ["project", "Bearer second"],
      ["project", "Bearer second"],
    ],
  );
  assert.equal(
    reused.steps[0].steps[0].request.headers.find((h) => h.key === "X-Shared")
      .value,
    "project",
  );
  const tampered = structuredClone(frozen);
  tampered.headers[0].value = "forged";
  assert.throws(() => freezeServiceBinding(current, tampered), /丢失绑定/);
  const noEvidence = structuredClone(current);
  noEvidence.plans = [];
  assert.throws(() => freezeServiceBinding(noEvidence, frozen), /丢失绑定/);
  const bad = structuredClone(reload);
  bad.plans[0].steps[0].steps[0].request.nativeInheritance =
    p.requests[0].nativeInheritance;
  await assert.rejects(f.store.save(bad), /冻结定义不能保留live绑定/);
  assert.equal(
    (await f.store.get(reload.id)).plans[0].steps[0].steps[0].request
      .nativeInheritance,
    undefined,
  );
});
