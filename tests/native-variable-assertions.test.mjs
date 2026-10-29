import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { runScript } from "../src/scripts.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  normalizeNativeAssertionData,
  compileNativeAssertions,
} from "../src/native-response-assertions.mjs";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const variable = (type, path, compareType = "eq", compareValue = "7") => ({
  type: "assert",
  enabled: 1,
  name: `${type} ${path} ${compareType}`,
  data: {
    type,
    expression: {
      path,
      compareType,
      ...(compareValue === undefined ? {} : { compareValue }),
    },
  },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
const phase = (tasks, patch = {}, options) =>
  runNativeTaskPhase(
    tasks,
    {
      request: {},
      scopes: {
        globals: { shared: "G", onlyGlobal: "G" },
        environment: { shared: "E", onlyEnv: "E" },
        runtime: { shared: "R" },
      },
      ...patch,
    },
    options,
  );

test("variable source paths strip only edge brace characters and preserve originals without templates", async () => {
  for (const type of ["tempVars", "envVars", "globalVars"]) {
    for (const [raw, key] of [
      ["{{x}}", "x"],
      ["}{x}{", "x"],
      ["{{ x }}", " x "],
      [" {{x}} ", " {{x}} "],
      ["a.b", "a.b"],
      ["x[y]", "x[y]"],
      ["{{}}", ""],
    ]) {
      const task = variable(type, raw);
      assert.deepEqual(normalizeNativeAssertionData(task.data), task.data);
      const op = compileNativeAssertions([
        { name: task.name, data: task.data },
      ])[0];
      assert.equal(op.variable, key);
      assert.equal(task.data.expression.path, raw);
    }
    assert.throws(() =>
      normalizeNativeAssertionData(
        variable(type, "x", "eq", ["{{expected}}"]).data,
      ),
    );
    assert.throws(() =>
      normalizeNativeAssertionData({
        type,
        expression: { compareType: "exist" },
      }),
    );
  }
  const result = await phase([
    script('pm.environment.set(" x ",7);pm.environment.set("a.b",7);'),
    variable("envVars", "{{ x }}"),
    variable("envVars", "a.b"),
    variable("envVars", "x", "notexist", undefined),
  ]);
  assert(result.tests.every((x) => x.passed));
});

test("three variable sources run before or after and preserve all fourteen comparisons", async () => {
  const rows = [
    ["eq", "7", true],
    ["uneq", "8", true],
    ["lt", "8", true],
    ["lte", "7", true],
    ["gt", "6", true],
    ["gte", "7", true],
    ["includes", "7", true],
    ["unincludes", "9", true],
    ["null", undefined, false],
    ["notnull", undefined, true],
    ["exist", undefined, true],
    ["notexist", undefined, false],
    ["belongscollection", "6,7,8", true],
    ["notbelongscollection", "6,8", true],
  ];
  for (const [type, api] of [
    ["tempVars", "variables"],
    ["envVars", "environment"],
    ["globalVars", "globals"],
  ]) {
    const tasks = [
      script(`pm.${api}.set("x",7);`),
      ...rows.map(([op, value]) => variable(type, "{{x}}", op, value)),
    ];
    for (const response of [undefined, { status: 200, body: "wire" }]) {
      const result = await phase(tasks, { response });
      assert.deepEqual(
        result.tests.map((x) => x.passed),
        rows.map((x) => x[2]),
      );
    }
  }
});

test("effective temporary lookup tracks current maps, own undefined, clear/unset and facade changes", async () => {
  const result = await phase([
    variable("tempVars", "shared", "eq", "R"),
    variable("envVars", "shared", "eq", "E"),
    variable("globalVars", "shared", "eq", "G"),
    script('pm.variables.set("shared",undefined);'),
    variable("tempVars", "shared", "notexist", undefined),
    script('pm.variables.unset("shared");'),
    variable("tempVars", "shared", "eq", "R"),
    script(
      'pm.environment.set("onlyEnv","changed");pm.globals.set("onlyGlobal","changedG");',
    ),
    variable("tempVars", "onlyEnv", "eq", "changed"),
    variable("globalVars", "onlyGlobal", "eq", "changedG"),
    script(
      'pm.variables.get=pm.environment.get=pm.globals.get=()=>{throw Error("public getter called");};',
    ),
    variable("envVars", "onlyEnv", "eq", "changed"),
    script("pm.environment.clear();pm.globals.clear();pm.variables.clear();"),
    variable("envVars", "onlyEnv", "notexist", undefined),
    variable("globalVars", "onlyGlobal", "notexist", undefined),
    variable("tempVars", "shared", "eq", "R"),
  ]);
  assert(result.tests.every((x) => x.passed));
});

test("before response/unknown mixed inputs reject atomically while variable sources retain direct runScript support", async () => {
  for (const type of [
    "responseCode",
    "responseTime",
    "responseText",
    "responseCookie",
    "bogus",
  ]) {
    assert.throws(() =>
      normalizeNativeTaskRequest({
        inheritSharedScripts: false,
        nativeTasks: {
          version: 1,
          before: [
            script('throw Error("not executed")'),
            variable("envVars", "x"),
            variable(type, "", "eq", "7"),
          ],
          after: [],
        },
      }),
    );
  }
  assert.throws(
    () =>
      runScript(
        "",
        { request: {} },
        {
          responseAssertions: [
            { name: "bad", data: variable("responseTime", "").data },
          ],
        },
      ),
    /后置/,
  );
  const data = variable("envVars", "x").data;
  const result = await runScript(
    "__nativeAssertionTask(0);",
    { request: {}, variables: { x: 7 } },
    { responseAssertions: [{ name: "direct", data }] },
  );
  assert.equal(result.tests[0].passed, true);
});

test("variable source invalid values remain stage errors, not absence success, without invoking getters", async () => {
  for (const setup of [
    'pm.environment.set("x",{});',
    'pm.environment.set("x",[]);',
    'pm.environment.set("x",Infinity);',
    'pm.environment.set("x","中".repeat(22000));',
    'pm.environment.set("x","\\ud800");',
    'Object.defineProperty(scopeState.environment,"x",{get(){throw Error("getter invoked");},enumerable:true});',
  ])
    await assert.rejects(
      phase([script(setup), variable("envVars", "x", "notexist", undefined)]),
      /原生|有限|64KiB|Unicode/,
    );
  const results = await Promise.all([
    phase([script('pm.environment.set("x",7);'), variable("envVars", "x")]),
    phase([variable("envVars", "x", "notexist", undefined)]),
  ]);
  assert(results.every((r) => r.tests.every((x) => x.passed)));
});

test("variable assertions share lexical state and observe assignments after a real database wait", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "native-variable-db-"));
  const filename = path.join(root, "fixture.db"),
    db = new DatabaseSync(filename);
  db.exec("CREATE TABLE records(value INTEGER);INSERT INTO records VALUES(7)");
  db.close();
  const sessions = new DatabaseSessions(),
    connection = sessions.register("metrics", { name: "fixture", filename });
  t.after(async () => {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  });
  const tasks = [
    script('let lexical="kept";'),
    {
      type: "database",
      enabled: 1,
      data: {
        connectionId: connection.id,
        query: "SELECT value FROM records",
        isConsoleOutput: 0,
        variables: [{ name: "x", type: "environment", pattern: "$[0].value" }],
      },
    },
    variable("envVars", "x"),
    script('pm.test("lexical",()=>pm.expect(lexical).to.equal("kept"));'),
  ];
  const result = await phase(
    tasks,
    {},
    {
      databaseQuery: async (op, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return sessions.query("metrics", op, signal);
      },
    },
  );
  assert.deepEqual(
    result.tests.map((x) => x.passed),
    [true, true],
  );
  assert.equal(result.databaseQueries[0].status, "completed");
});

test("variable assertions import before/after tasks, block failed prerequisites, persist post soft failure and roundtrip isolated projects", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, header: req.headers["x-variable"] });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "native-variable-http-"));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, value, expected = 200) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(value),
    });
    const body = await r.json();
    assert.equal(r.status, expected, JSON.stringify(body));
    return body;
  };
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.pre_tasks = [];
  source.global.global_param.post_tasks = [];
  source.apis[0].request.pre_tasks = [];
  source.apis[0].request.post_tasks = [];
  const api = source.apis[1];
  api.url = `http://127.0.0.1:${server.address().port}/metric`;
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [
    script(
      'pm.environment.set("candidate","before");pm.variables.set("localOnly","temporary");pm.globals.set("shared","G");',
    ),
    variable("envVars", "{{candidate}}", "eq", "before"),
    variable("tempVars", "{{localOnly}}", "eq", "temporary"),
    variable("globalVars", "shared", "eq", "G"),
    script(
      'apt.setRequestHeader("x-variable",pm.environment.get("candidate"));',
    ),
  ];
  api.request.post_tasks = [
    variable("tempVars", "localOnly", "eq", "temporary"),
    script('pm.environment.set("candidate","after");'),
    variable("envVars", "candidate", "eq", "deliberate soft false"),
    script('pm.environment.set("completed","yes");'),
  ];
  for (const phase of ["pre_tasks", "post_tasks"])
    api.request[phase].forEach((task, i) => {
      task.id = `${phase}-${i}`;
      task.name ??= task.id;
    });
  const original = structuredClone(source),
    p = await app.store.create("variable phases");
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  await app.store.save(p);
  assert.equal(p.requests[0].nativeTasks.before.length, 5);
  const bad = structuredClone(p.requests[0]);
  bad.nativeTasks.before[1].data.expression.compareValue = "blocked";
  const blockedPlan = await post(`/api/projects/${p.id}/plans`, {
    steps: [{ request: bad }],
  });
  const blocked = await post(`/api/projects/${p.id}/run`, {
    planId: blockedPlan.id,
  });
  assert.equal(blocked.status, "failed", JSON.stringify(blocked));
  assert.equal(blocked.recordSaved, true);
  assert.equal(seen.length, 0);
  assert.match(blocked.results[0].error, /前置脚本断言失败/);
  let disk = await new Store(root).get(p.id);
  assert(
    disk.environments.every((e) => !Object.hasOwn(e.variables, "candidate")),
  );
  assert(!Object.hasOwn(disk.globalVariables, "shared"));
  const plan = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: p.requests[0] },
      { request: { url: api.url + "/later", inheritSharedScripts: false } },
    ],
  });
  const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results[1].status, "passed");
  assert.equal(seen[0].header, "before");
  assert.equal(
    run.results[0].assertions.filter((x) => x.phase === "before").length,
    3,
  );
  assert(
    run.results[0].assertions
      .filter((x) => x.phase === "before")
      .every((x) => x.passed),
  );
  assert.deepEqual(
    run.results[0].assertions
      .filter((x) => x.phase === "after")
      .map((x) => x.passed),
    [true, false],
  );
  disk = await new Store(root).get(p.id);
  assert.equal(disk.environments[0].variables.candidate, "after");
  assert.equal(disk.environments[0].variables.completed, "yes");
  assert(!Object.hasOwn(disk.environments[0].variables, "localOnly"));
  assert.equal(disk.globalVariables.shared, "G");
  const isolated = await app.store.create("other");
  assert(!Object.hasOwn(isolated.globalVariables, "shared"));
  assert(
    isolated.environments.every(
      (e) => !Object.hasOwn(e.variables, "candidate"),
    ),
  );
  const restored = await post("/api/restore", { document: disk }, 201);
  assert.deepEqual(
    restored.requests[0].nativeTasks,
    disk.requests[0].nativeTasks,
  );
  assert.deepEqual(
    restored.plans.find((x) => x.id === plan.id).steps[0].request.nativeTasks,
    plan.steps[0].request.nativeTasks,
  );
  await close();
  app = await createApp({ root, port: 0 });
  const rerun = await post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
  });
  assert.equal(rerun.status, "failed");
  assert.equal(rerun.results[1].status, "passed");
  assert.equal(rerun.recordSaved, true);
});

test("variable assertions retain private failure evidence and shared assertion quota", async () => {
  const result = await phase([
    script("pm.test=()=>{};"),
    variable("envVars", "shared", "eq", "wrong"),
    script("tests.length=0;"),
    variable("globalVars", "shared", "eq", "G"),
  ]);
  assert.equal(result.tests.filter((t) => !t.passed).length, 1);
  await assert.rejects(
    phase(
      [
        script('pm.test("ordinary",()=>{});'),
        variable("envVars", "shared", "eq", "E"),
      ],
      {},
      { assertionLimit: 1 },
    ),
    /断言|预算|最多/,
  );
});
