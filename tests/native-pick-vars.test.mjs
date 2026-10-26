import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, runPlan, snapshotPlan } from "../src/core.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  normalizePickVarsData,
  compilePickVarsOperations,
} from "../src/native-response-extraction.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const pick = (variables, enabled = 1) => ({
  type: "pickVars",
  id: "extract",
  name: "Extract",
  enabled,
  data: { source: "responseJson", variables },
});
const row = (name, expression, type = "envVars") => ({
  name,
  expression,
  type,
});
function sourceFor(url) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.post_tasks = [
    script("project", 'const order=["project"];'),
  ];
  source.apis[0].request.post_tasks = [
    script("folder", 'order.push("folder");'),
  ];
  const api = source.apis[1];
  api.url = url + "/login/{{tenant}}";
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.post_tasks = [
    script(
      "before-extract",
      'order.push("api");const prefix="prefix:";const view=pm.response.json();view.session.token+="-view";apt.response.setBody(view);',
    ),
    pick([
      row("token", "$.session.token"),
      row("sameRequest", "$.session.token", "tempVars"),
      row("zero", "$.zero"),
      row("no", "$.no"),
      row("nothing", "$.nothing", "globalVars"),
    ]),
    script(
      "after-extract",
      'pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("order",order.join(","));pm.test("same phase",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(pm.environment.get("token")));',
    ),
  ];
  return source;
}

test("pickVars validates descriptors and keeps disabled supported source inert", () => {
  let calls = 0;
  for (const key of ["variables", "toJSON"]) {
    const data = { source: "responseJson", variables: [] };
    Object.defineProperty(data, key, {
      enumerable: true,
      get() {
        calls++;
        return [];
      },
    });
    assert.throws(() => compilePickVarsOperations([data]), /访问器/);
  }
  assert.equal(calls, 0);
  const inert = { source: "responseJson", variables: [row("", "$..*")] };
  assert.deepEqual(normalizePickVarsData(inert, { enabled: false }), inert);
  assert.throws(() => normalizePickVarsData(inert));
  for (const expression of [
    "$..x",
    "$[*]",
    "$[?(@.token)]",
    "$.constructor",
    "$[0:2]",
  ])
    assert.throws(() =>
      normalizePickVarsData({
        source: "responseJson",
        variables: [row("value", expression)],
      }),
    );
  for (const source of ["responseHeaders", "responseXML", "requestJson"])
    assert.throws(() => normalizePickVarsData({ source, variables: [] }));
  const sparse = new Array(1);
  sparse.extra = {};
  assert.throws(() => compilePickVarsOperations(sparse));
});

test("pickVars keeps one VM lexical order and preserves zero false null without stringifying", async () => {
  const input = {
    variables: {},
    request: {},
    response: {
      status: 200,
      body: '{"zero":0,"no":false,"nothing":null,"list":[{"token":"雪"}]}',
    },
  };
  const before = structuredClone(input);
  const result = await runNativeTaskPhase(
    [
      script("prefix", 'const marker="prefix:";'),
      pick([
        row("zero", "$.zero"),
        row("no", "$.no"),
        row("nothing", "$.nothing"),
        row("value", "$['list'][0].token", "tempVars"),
      ]),
      script(
        "read",
        'pm.environment.set("joined",marker+pm.variables.get("value"));',
      ),
    ],
    input,
  );
  assert.equal(result.scopes.environment.zero, 0);
  assert.equal(result.scopes.environment.no, false);
  assert.equal(result.scopes.environment.nothing, null);
  assert.equal(result.scopes.environment.joined, "prefix:雪");
  assert.equal(result.localVariables.value, "雪");
  assert.deepEqual(input, before);
});

test("native login response extraction reaches next real Bearer HTTP, freezes source, and survives backup/restart", async (t) => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      req.url.startsWith("/login/")
        ? JSON.stringify({
            session: { token: "wire-" + req.url.slice(7) },
            zero: 0,
            no: false,
            nothing: null,
          })
        : JSON.stringify({ authorization: req.headers.authorization }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "native-pick-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + upstream.address().port,
    source = sourceFor(url),
    original = structuredClone(source),
    p = await app.store.create("pick fixture");
  importIntoProject(p, source);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "other-env",
    name: "B",
    variables: { tenant: "B" },
  });
  await app.store.save(p);
  assert.deepEqual(source, original);
  assert.deepEqual(
    p.requests[0].nativeTasks.after.slice(0, 2).map((t) => t.origin.scope),
    ["project", "folder"],
  );
  const post = async (route, body) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const planResponse = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: p.requests[0] },
      {
        request: {
          method: "GET",
          url: url + "/resource",
          beforeScript:
            'pm.test("local isolation",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(undefined));',
          headers: [
            { key: "Authorization", value: "Bearer {{token}}", enabled: true },
          ],
        },
      },
    ],
  });
  assert.equal(planResponse.status, 200, JSON.stringify(planResponse));
  const plan = planResponse.value;
  const live = await app.store.get(p.id);
  live.requests[0].nativeTasks.after.find(
    (t) => t.type === "pickVars",
  ).data.variables[0].expression = "$.missing";
  await app.store.save(live);
  for (const [environmentId, tenant] of [
    [p.environments[0].id, "A"],
    ["other-env", "B"],
  ]) {
    const run = await post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId,
    });
    assert.equal(run.status, 200, JSON.stringify(run));
    assert.equal(run.value.status, "passed", JSON.stringify(run.value.results));
    assert.equal(received.at(-1).authorization, `Bearer wire-${tenant}-view`);
    assert.equal(
      JSON.parse(run.value.results[0].response.body).session.token,
      `wire-${tenant}`,
    );
    assert.equal(
      JSON.parse(run.value.results[0].scriptResponse.body).session.token,
      `wire-${tenant}-view`,
    );
    const saved = await new Store(root).get(p.id),
      env = saved.environments.find((e) => e.id === environmentId);
    assert.equal(env.variables.derived, `prefix:wire-${tenant}-view`);
    assert.equal(env.variables.order, "project,folder,api");
    assert.equal(env.variables.zero, 0);
    assert.equal(env.variables.no, false);
    assert.equal(saved.globalVariables.nothing, null);
    assert(!Object.hasOwn(env.variables, "sameRequest"));
  }
  const other = await app.store.create("isolated other project");
  importIntoProject(other, source);
  other.environments[0].variables.tenant = "C";
  await app.store.save(other);
  const otherPlan = await post(`/api/projects/${other.id}/plans`, {
    steps: [{ request: other.requests[0] }, plan.steps[1]],
  });
  assert.equal(otherPlan.status, 200);
  const concurrent = await Promise.all([
    post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId: p.environments[0].id,
    }),
    post(`/api/projects/${other.id}/run`, { planId: otherPlan.value.id }),
  ]);
  for (const run of concurrent)
    assert.equal(run.value.status, "passed", JSON.stringify(run));
  assert.equal(
    (await new Store(root).get(p.id)).environments[0].variables.token,
    "wire-A-view",
  );
  assert.equal(
    (await new Store(root).get(other.id)).environments[0].variables.token,
    "wire-C-view",
  );
  const count = received.length;
  const foreign = await post(`/api/projects/${p.id}/run`, {
    planId: plan.id,
    environmentId: other.environments[0].id,
  });
  assert.equal(foreign.status, 400);
  assert.equal(received.length, count);
  const saved = await new Store(root).get(p.id);
  const restored = await post("/api/restore", { document: saved });
  assert.equal(restored.status, 201, JSON.stringify(restored));
  assert.deepEqual(
    restored.value.plans[0].steps[0].request.nativeTasks,
    saved.plans[0].steps[0].request.nativeTasks,
  );
  await stop();
  app = await createApp({ root, port: 0 });
  const run = await post(`/api/projects/${restored.value.id}/run`, {
    planId: plan.id,
    environmentId: "other-env",
  });
  assert.equal(run.value.status, "passed", JSON.stringify(run));
  assert.equal(received.at(-1).authorization, "Bearer wire-B-view");
});

test("pickVars response-stage failures roll back only post scopes and stop real later HTTP, including Store conflicts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "native-pick-errors-"));
  const app = await createApp({ root, port: 0 });
  const seen = [];
  let active;
  const upstream = http.createServer(async (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    if (active.disconnect) {
      req.socket.destroy();
      return;
    }
    if (active.conflict && req.url === "/login") {
      const independent = new Store(root),
        current = await independent.get(active.projectId);
      current.environments[0].variables.token = "concurrent-owner-edit";
      await independent.save(current);
    }
    res.statusCode = req.url === "/login" ? active.status || 200 : 200;
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/login" ? (active.body ?? '{"token":"fresh"}') : "{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => upstream.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + upstream.address().port;
  const post = async (projectId, route, body) => {
    const response = await fetch(
      `${app.url}/api/projects/${projectId}/${route}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const failure =
    'pm.test("post failure",()=>pm.expect(false).to.equal(true));';
  const valid = pick([row("token", "$.token")]);
  const cases = [
    {
      name: "pre-stage assertion prevents stale followup",
      before: [script("reject", failure)],
      error: /前置脚本断言失败/,
    },
    {
      name: "pre-stage throw prevents stale followup",
      before: [script("reject", 'throw Error("before request failed")')],
      error: /before request failed/,
    },
    {
      name: "network failure prevents stale followup",
      disconnect: true,
      error: /socket hang up|fetch failed/,
    },
    {
      name: "missing later row",
      tasks: [pick([row("token", "$.token"), row("absent", "$.missing")])],
      error: /路径不存在/,
    },
    {
      name: "return before extraction cannot claim success",
      tasks: [script("early", "return;"), valid],
      error: /未完成/,
    },
    {
      name: "return after first extraction rolls back partial stage",
      tasks: [
        valid,
        script("early", "return;"),
        pick([row("another", "$.token")]),
      ],
      error: /未完成/,
    },
    {
      name: "cross-task catch cannot hide failed extraction",
      tasks: [
        script("try", "try {"),
        pick([row("missing", "$.missing")]),
        script("catch", "} catch (ignored) {}"),
      ],
      error: /未完成/,
    },
    {
      name: "caught extraction failure stays sticky across later tasks",
      tasks: [
        script("try", "try {"),
        pick([row("missing", "$.missing")]),
        script("catch", "} catch (ignored) {} try {"),
        valid,
        script("catch-again", "} catch (ignored) {}"),
      ],
      error: /未完成/,
    },
    {
      name: "invalid JSON",
      body: "<token>no XML fallback</token>",
      error: /严格JSON/,
    },
    ...["null", "0", "false", '"text"'].map((body) => ({
      name: "root " + body,
      body,
      error: /响应根/,
    })),
    {
      name: "assert before",
      tasks: [script("reject", failure), valid],
      error: /断言/,
    },
    {
      name: "assert after",
      tasks: [valid, script("reject", failure)],
      error: /断言/,
    },
    {
      name: "throw before",
      tasks: [script("reject", 'throw Error("post rejection")'), valid],
      error: /post rejection/,
    },
    {
      name: "throw after",
      tasks: [valid, script("reject", 'throw Error("post rejection")')],
      error: /post rejection/,
    },
    {
      name: "wire response assertion",
      assertions: [{ target: "status", op: "eq", value: 201 }],
      error: /断言/,
    },
    {
      name: "declarative runtime extraction also rolls back",
      extract: [{ name: "runtimePartial", path: "$.token", scope: "runtime" }],
      tasks: [valid, script("reject", failure)],
      error: /断言/,
    },
    {
      name: "wire status cannot be replaced",
      status: 500,
      tasks: [script("view", "apt.response.setCode(200);"), valid],
      error: /原始响应状态/,
    },
    {
      name: "real Store optimistic conflict",
      conflict: true,
      error: /变量冲突/,
    },
  ];
  for (const sample of cases)
    await t.test(sample.name, async () => {
      const p = await app.store.create(sample.name);
      p.environments[0].variables.token = "stale";
      p.globalVariables.priorGlobal = "saved";
      await app.store.save(p);
      active = { ...sample, projectId: p.id };
      seen.length = 0;
      const plan = await post(p.id, "plans", {
        steps: [
          {
            request: {
              method: "GET",
              url: base + "/login",
              inheritSharedScripts: false,
              assertions: sample.assertions || [],
              extract: sample.extract || [],
              nativeTasks: {
                version: 1,
                before: sample.before || [
                  script(
                    "before",
                    'pm.environment.set("beforeProof","committed");',
                  ),
                ],
                after: [
                  script(
                    "post-change",
                    'pm.environment.set("postOnly","must rollback");pm.globals.set("postGlobal","must rollback");',
                  ),
                  ...(sample.tasks || [valid]),
                ],
              },
            },
          },
          {
            request: {
              method: "GET",
              url: base + "/later",
              auth: { type: "bearer", token: "{{token}}" },
            },
          },
        ],
      });
      const run = await post(p.id, "run", { planId: plan.id });
      assert.equal(run.status, "failed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 1, JSON.stringify(run));
      assert.match(run.results[0].error, sample.error);
      assert.deepEqual(
        seen.map((x) => x.path),
        sample.before ? [] : ["/login"],
      );
      assert.equal(run.variables.token, "stale");
      assert(!Object.hasOwn(run.variables, "postOnly"));
      assert(!Object.hasOwn(run.variables, "runtimePartial"));
      if (sample.status === 500) {
        assert.equal(run.results[0].response.status, 500);
        assert.equal(run.results[0].scriptResponse.status, 200);
      }
      const disk = await new Store(root).get(p.id);
      assert.equal(
        disk.environments[0].variables.beforeProof,
        sample.before ? undefined : "committed",
      );
      assert.equal(
        disk.environments[0].variables.token,
        sample.conflict ? "concurrent-owner-edit" : "stale",
      );
      assert(!Object.hasOwn(disk.environments[0].variables, "postOnly"));
      assert(!Object.hasOwn(disk.globalVariables, "postGlobal"));
      assert.equal(disk.globalVariables.priorGlobal, "saved");
      assert.equal(disk.runs.find((r) => r.id === run.id).results.length, 1);
    });
  for (const disabled of [false, true])
    await t.test(
      disabled
        ? "disabled pick retains legacy continue"
        : "no pick cannot forge host policy",
      async () => {
        const p = await app.store.create("old behavior");
        p.environments[0].variables.token = "stale";
        await app.store.save(p);
        active = { projectId: p.id };
        seen.length = 0;
        const plan = await post(p.id, "plans", {
          steps: [
            {
              request: {
                method: "GET",
                url: base + "/login",
                inheritSharedScripts: false,
                nativeTasks: {
                  version: 1,
                  before: [],
                  after: [
                    ...(disabled ? [pick([row("", "$..*")], 0)] : []),
                    script(
                      "throw",
                      'const e=Error("legacy");e.nativeExtractionPhaseFailure=true;e[Symbol.for("native-response-extraction-phase")]=true;throw e;',
                    ),
                  ],
                },
              },
            },
            {
              request: {
                method: "GET",
                url: base + "/later",
                auth: { type: "bearer", token: "{{token}}" },
              },
            },
          ],
        });
        const run = await post(p.id, "run", { planId: plan.id });
        assert.equal(run.status, "failed");
        assert.equal(run.results.length, 2);
        assert.equal(seen.at(-1).authorization, "Bearer stale");
      },
    );
});

test("pickVars bounded own JSON selection is not replaced by user intrinsics or setters", async () => {
  const result = await runNativeTaskPhase(
    [
      script(
        "intrinsics",
        'JSON.parse=()=>({token:"forged"});Object.getOwnPropertyDescriptor=()=>({value:"forged",enumerable:true});pm.environment.set=()=>{};',
      ),
      pick([row("token", "$.token"), row("whole", "")]),
    ],
    {
      request: {},
      response: {
        status: 200,
        body: '{"token":"actual","nested":[0,false,null]}',
      },
    },
  );
  assert.equal(result.scopes.environment.token, "actual");
  assert.deepEqual(result.scopes.environment.whole, {
    token: "actual",
    nested: [0, false, null],
  });
  const array = await runNativeTaskPhase(
    [pick([row("item", "$[0]"), row("all", "$")])],
    { request: {}, response: { body: "[false,0,null]" } },
  );
  assert.equal(array.scopes.environment.item, false);
  assert.deepEqual(array.scopes.environment.all, [false, 0, null]);
  const afterReturn = await runNativeTaskPhase(
    [pick([row("token", "$.token")]), script("done", "return;")],
    {
      request: {},
      response: { body: '{"token":"new VM after failed phases"}' },
    },
  );
  assert.equal(
    afterReturn.scopes.environment.token,
    "new VM after failed phases",
  );
});

test("pickVars import rejects unknown shapes and limits atomically before mutating the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pick-atomic-"));
  try {
    const store = new Store(root),
      p = await store.create("atomic"),
      original = structuredClone(p);
    for (const change of [
      (task) => (task.data.source = "responseHeaders"),
      (task) => (task.data.variables[0].expression = "$[*]"),
      (task) => (task.data.variables[0].enabled = 1),
      (task) =>
        (task.data.variables = Array.from({ length: 101 }, () =>
          row("value", "$.x"),
        )),
      (task) =>
        (task.data.variables = Array.from({ length: 100 }, (_, i) =>
          row("value" + i, "$." + "雪".repeat(300)),
        )),
    ]) {
      const source = sourceFor("http://127.0.0.1:1"),
        task = source.apis[1].request.post_tasks[1];
      change(task);
      assert.throws(() => importIntoProject(p, source));
      assert.deepEqual(p, original);
    }
    const source = sourceFor("http://127.0.0.1:1");
    let calls = 0;
    Object.defineProperty(source.apis[1].request.post_tasks, "0", {
      enumerable: true,
      get() {
        calls++;
        return script("no", "");
      },
    });
    assert.throws(() => importIntoProject(p, source));
    assert.equal(calls, 0);
    assert.deepEqual(p, original);
    assert.deepEqual(await new Store(root).get(p.id), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pickVars enforces phase descriptor, UTF8, response depth and node budgets", async () => {
  const request = (after) => ({
    inheritSharedScripts: false,
    nativeTasks: { version: 1, before: [], after },
  });
  assert.equal(
    normalizeNativeTaskRequest(
      request(Array.from({ length: 16 }, () => pick([]))),
    ).after.length,
    16,
  );
  assert.throws(
    () =>
      normalizeNativeTaskRequest(
        request(Array.from({ length: 17 }, () => pick([]))),
      ),
    /超限|最多/,
  );
  const rows = Array.from({ length: 80 }, (_, i) =>
    row("value" + i, "$." + "x".repeat(500)),
  );
  assert.throws(
    () =>
      normalizeNativeTaskRequest(
        request(Array.from({ length: 7 }, () => pick(rows))),
      ),
    /256KiB/,
  );
  assert.equal(
    normalizePickVarsData({
      source: "responseJson",
      variables: Array.from({ length: 100 }, (_, i) => row("v" + i, "$")),
    }).variables.length,
    100,
  );
  let deep = { value: 0 };
  for (let i = 0; i < 66; i++) deep = { child: deep };
  for (const body of [
    JSON.stringify(deep),
    JSON.stringify(Array.from({ length: 10001 }, () => 0)),
  ])
    await assert.rejects(
      runNativeTaskPhase([pick([row("whole", "$")])], {
        request: {},
        response: { body },
      }),
      /结构超限/,
    );
  await assert.rejects(
    runNativeTaskPhase([pick([row("number", "$.number")])], {
      request: {},
      response: { body: '{"number":1e999}' },
    }),
    /有限JSON数字/,
  );
});

test("real scope persistence I/O failure stops later HTTP without assuming disk rollback or replaying login", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pick-save-failure-"));
  const app = await createApp({ root, port: 0 }),
    project = await app.store.create("I/O failure");
  project.environments[0].variables.token = "stale";
  await app.store.save(project);
  const history = path.join(app.store.directory(project.id), "history"),
    kept = history + "-kept",
    seen = [];
  let obstructed = false;
  const upstream = http.createServer(async (req, res) => {
    seen.push(req.url);
    if (req.url === "/login") {
      await rename(history, kept);
      await writeFile(history, "controlled non-directory obstacle");
      obstructed = true;
    }
    res.setHeader("content-type", "application/json");
    res.end('{"token":"fresh"}');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => upstream.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + upstream.address().port;
  const post = async (route, body) => {
    const response = await fetch(
      `${app.url}/api/projects/${project.id}/${route}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const plan = await post("plans", {
    steps: [
      {
        request: {
          method: "GET",
          url: base + "/login",
          inheritSharedScripts: false,
          nativeTasks: {
            version: 1,
            before: [],
            after: [pick([row("token", "$.token")])],
          },
        },
      },
      {
        request: {
          method: "GET",
          url: base + "/later",
          auth: { type: "bearer", token: "{{token}}" },
        },
      },
    ],
  });
  const run = await post("run", { planId: plan.id });
  assert.equal(obstructed, true);
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 1);
  assert.match(run.results[0].error, /变量持久化失败/);
  assert.equal(run.recordSaved, false);
  assert.deepEqual(seen, ["/login"]);
  await rm(history);
  await rename(kept, history);
  const recovered = await new Store(root).get(project.id);
  // A published journal may roll forward; a stronger Store can reject earlier.
  // Neither outcome permits replaying a completed login automatically.
  assert(
    ["stale", "fresh"].includes(recovered.environments[0].variables.token),
  );
  assert(!recovered.runs.some((r) => r.id === run.id));
  assert.deepEqual(seen, ["/login"]);
});

test("only host persistence uncertainty creates a safe non-retry marker; VM fields cannot forge it", async () => {
  const create = (tasks) =>
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://fixture.invalid/login",
            inheritSharedScripts: false,
            nativeTasks: { version: 1, before: [], after: tasks },
          },
        },
        { request: { url: "http://fixture.invalid/later" } },
      ],
    });
  const hostError = Object.assign(
    Error("private /fixture/credential.pem and sensitive detail"),
    {
      code: "PROJECT_COMMIT_UNCERTAIN",
      cause: { password: "must-not-propagate" },
    },
  );
  let calls = 0;
  const execute = async () => {
    calls++;
    return { status: 200, body: '{"token":"fresh"}', headers: {}, duration: 1 };
  };
  const result = await runPlan(
    create([pick([row("token", "$.token")])]),
    { token: "stale" },
    execute,
    {
      onScopeChanges: async () => {
        throw hostError;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.results[0].scopeCommit, {
    outcome: "unknown",
    retrySafe: false,
  });
  assert.match(result.results[0].error, /提交未确认/);
  assert(!JSON.stringify(result).includes("credential.pem"));
  assert(!JSON.stringify(result).includes("must-not-propagate"));
  const forged = await runPlan(
    create([
      script(
        "forge",
        'const e=Error("user throw");e.code="PROJECT_COMMIT_UNCERTAIN";e.scopeCommit={outcome:"unknown",retrySafe:false};throw e;',
      ),
      pick([]),
    ]),
    {},
    execute,
  );
  assert.equal(forged.status, "failed");
  assert.equal(forged.results[0].scopeCommit, undefined);
});
