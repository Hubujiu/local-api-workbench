import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, interpolate } from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  normalizeNativeAssertionData,
  compileNativeAssertions,
} from "../src/native-response-assertions.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const assertion = (
  id,
  path,
  compareValue,
  compareType = "eq",
  type = "responseJson",
) => ({
  type: "assert",
  id,
  name: id,
  enabled: 1,
  data: { type, expression: { path, compareType, compareValue } },
});
const input = (body) => ({ request: {}, response: { status: 200, body } });
function fixture(base) {
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
  api.url = base + "/business/{{tenant}}";
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.post_tasks = [
    script("view", 'order.push("api");apt.response.setCode(201);'),
    assertion("status view", "", "201", "eq", "responseCode"),
    assertion("Business result", "$.ok", "true"),
    script(
      "after",
      'order.push("after");pm.environment.set("order",order.join(","));pm.environment.set("visited",pm.response.json().tenant);',
    ),
  ];
  return source;
}

test("native assert data keeps disabled defaults inert and rejects active unsafe semantics without coercion", () => {
  const data = {
    type: "responseJson",
    expression: { path: "", compareValue: "" },
  };
  assert.deepEqual(
    normalizeNativeAssertionData(data, { enabled: false }),
    data,
  );
  assert.throws(() => normalizeNativeAssertionData(data));
  for (const patch of [
    { path: "$[*]" },
    { compareType: "unsupportedComparison" },
    { compareValue: "{{token}}" },
    { compareValue: 0 },
  ])
    assert.throws(() =>
      normalizeNativeAssertionData({
        type: "responseJson",
        expression: {
          path: "$.ok",
          compareType: "eq",
          compareValue: "true",
          ...patch,
        },
      }),
    );
  let calls = 0;
  const accessor = { name: "no", data };
  Object.defineProperty(accessor, "data", {
    enumerable: true,
    get() {
      calls++;
      return data;
    },
  });
  assert.throws(() => compileNativeAssertions([accessor]));
  assert.equal(calls, 0);
});

test("native assertions compare primitive strings and remain soft, ordered and immune to public test mutation", async () => {
  const tasks = [
    script("first", 'const proof="same lexical scope";'),
    assertion("false vs true", "$.ok", "true"),
    assertion("zero", "$.zero", "0"),
    assertion("null", "$.nothing", "null"),
    assertion("missing", "$.absent", "undefined"),
    assertion("uneq", "$.ok", "true", "uneq"),
    script(
      "after",
      'tests[0].passed=true;tests.length=0;pm.environment.set("proof",proof);',
    ),
  ];
  const result = await runNativeTaskPhase(
    tasks,
    input('{"ok":false,"zero":0,"nothing":null}'),
  );
  assert.equal(result.scopes.environment.proof, "same lexical scope");
  assert.equal(result.tests.length, 5);
  assert.equal(result.tests[0].passed, false);
  assert(result.tests.slice(1).every((t) => t.passed));
});

test("real HTTP business assertion soft failure continues tasks and plan, persists, freezes and restores", async (t) => {
  const received = [];
  let success = false;
  const upstream = http.createServer((req, res) => {
    received.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: success, tenant: req.url.split("/").at(-1) }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(tmpdir(), "native-assert-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + upstream.address().port,
    source = fixture(base),
    original = structuredClone(source),
    p = await app.store.create("business assertions");
  importIntoProject(p, source);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "environment-B",
    name: "B",
    variables: { tenant: "B" },
  });
  await app.store.save(p);
  assert.deepEqual(source, original);
  const post = async (route, body) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  const created = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: p.requests[0] },
      { request: { method: "GET", url: base + "/following/{{visited}}" } },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const plan = created.value;
  const live = await app.store.get(p.id);
  live.requests[0].nativeTasks.after.find(
    (t) => t.type === "assert",
  ).data.expression.compareValue = "999";
  await app.store.save(live);
  const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, 200);
  assert.equal(run.value.status, "failed");
  assert.equal(run.value.results.length, 2);
  assert.equal(run.value.results[1].status, "passed");
  assert.equal(run.value.results[0].response.status, 200);
  assert.equal(run.value.results[0].scriptResponse.status, 201);
  assert.deepEqual(
    run.value.results[0].assertions.map((t) => [t.name, t.passed]),
    [
      ["status view", true],
      ["Business result", false],
    ],
  );
  assert.deepEqual(received, ["/business/A", "/following/A"]);
  const disk = await new Store(root).get(p.id);
  assert.equal(
    disk.environments[0].variables.order,
    "project,folder,api,after",
  );
  assert.equal(disk.runs.at(-1).status, "failed");
  const restored = await post("/api/restore", { document: disk });
  assert.equal(restored.status, 201);
  assert.deepEqual(
    restored.value.plans[0].steps[0].request.nativeTasks,
    disk.plans[0].steps[0].request.nativeTasks,
  );
  await stop();
  app = await createApp({ root, port: 0 });
  success = true;
  const rerun = await post(`/api/projects/${restored.value.id}/run`, {
    planId: plan.id,
  });
  assert.equal(rerun.value.status, "passed", JSON.stringify(rerun));
  const other = await app.store.create("other project");
  importIntoProject(other, source);
  other.environments[0].variables.tenant = "C";
  await app.store.save(other);
  const otherPlan = await post(`/api/projects/${other.id}/plans`, {
    steps: [{ request: other.requests[0] }, plan.steps[1]],
  });
  assert.equal(otherPlan.status, 200);
  const runs = await Promise.all([
    post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId: "environment-B",
    }),
    post(`/api/projects/${other.id}/run`, { planId: otherPlan.value.id }),
  ]);
  assert(
    runs.every((r) => r.value.status === "passed"),
    JSON.stringify(runs),
  );
  const first = await new Store(root).get(p.id),
    second = await new Store(root).get(other.id);
  assert.equal(first.environments[0].variables.visited, "A");
  assert.equal(first.environments[1].variables.visited, "B");
  assert.equal(second.environments[0].variables.visited, "C");
  const count = received.length;
  const foreign = await post(`/api/projects/${p.id}/run`, {
    planId: plan.id,
    environmentId: other.environments[0].id,
  });
  assert.equal(foreign.status, 400);
  assert.equal(received.length, count);
});

test("native evidence survives duplicate public references, erased arrays and forged serialization", async () => {
  for (const [before, after] of [
    [
      'const fake={name:"forged",passed:true};tests.push=()=>{tests[tests.length]=fake;};',
      "",
    ],
    ["", 'tests.length=0;pm.test("ordinary",()=>{});'],
    [
      "",
      'JSON.stringify=()=>\'{"tests":[],"variables":{},"scopes":{"environment":{},"globals":{},"runtime":{},"defaults":{},"hidden":[]},"localVariables":{},"request":{},"logs":[]}\';',
    ],
    [
      'JSON.parse=()=>({ok:true});Object.getOwnPropertyDescriptor=()=>({value:true,enumerable:true});String=()=>"true";pm.test=()=>{};',
      "",
    ],
    [
      "",
      'Object.prototype.toJSON=()=>({name:"forged",passed:true});Array.prototype.toJSON=()=>[];Object.defineProperty(Array.prototype,"0",{configurable:true,set(){},get(){return {name:"forged",passed:true};}});JSON.stringify=()=>\'{"tests":[],"variables":{},"scopes":{"environment":{},"globals":{},"runtime":{},"defaults":{},"hidden":[]},"localVariables":{},"request":{},"logs":[]}\';',
    ],
  ]) {
    const result = await runNativeTaskPhase(
      [
        script("tamper-before", before),
        assertion("failure", "$.ok", "true"),
        assertion("success", "$.ok", "false"),
        script("tamper-after", after),
      ],
      input('{"ok":false}'),
    );
    assert.equal(
      result.tests.find((t) => t.name === "failure")?.passed,
      false,
      JSON.stringify(result.tests),
    );
    assert.equal(
      result.tests.find((t) => t.name === "success")?.passed,
      true,
      JSON.stringify(result.tests),
    );
  }
});

test("assert completion, errors, shared quota and cancellation remain distinct from comparison false", async () => {
  const valid = assertion("valid", "$.ok", "true");
  for (const tasks of [
    [script("return", "return;"), valid],
    [valid, script("return", "return;"), assertion("later", "$.ok", "true")],
    [
      script("try", "try {"),
      assertion("object", "$", "ignored"),
      script("catch", "} catch(e) {}"),
    ],
    [
      script("try", "try {"),
      assertion("object", "$", "ignored"),
      script("catch", "} catch(e) {} try {"),
      valid,
      script("catch2", "} catch(e) {}"),
    ],
  ])
    await assert.rejects(
      runNativeTaskPhase(tasks, input('{"ok":true}')),
      /未完成/,
    );
  const complete = await runNativeTaskPhase(
    [valid, script("return", "return;")],
    input('{"ok":true}'),
  );
  assert.equal(complete.tests[0].passed, true);
  for (const body of ["<ok>true</ok>", "0", "null", "false", '"text"'])
    await assert.rejects(
      runNativeTaskPhase([valid], input(body)),
      /严格JSON|响应根/,
    );
  for (const body of ['{"ok":{}}', '{"ok":[]}', '{"ok":1e999}'])
    await assert.rejects(
      runNativeTaskPhase([valid], input(body)),
      /有限JSON原始值/,
    );
  const array = await runNativeTaskPhase(
    [
      assertion("first", "$[0]", "false"),
      assertion("missing", "$[4]", "undefined"),
    ],
    input("[false,0,null]"),
  );
  assert(array.tests.every((t) => t.passed));
  const quote = await runNativeTaskPhase(
    [
      assertion(
        'not code ";throw Error("injection")//',
        '$["weird.key"]',
        'text"\\\n雪',
      ),
    ],
    input(JSON.stringify({ "weird.key": 'text"\\\n雪' })),
  );
  assert.equal(quote.tests[0].passed, true);
  await assert.rejects(
    runNativeTaskPhase(
      [
        script("fill", 'for(let i=0;i<1000;i++)pm.test.skip("existing");'),
        valid,
      ],
      input('{"ok":true}'),
    ),
    /最多1000条/,
  );
  await assert.rejects(
    async () =>
      runNativeTaskPhase(
        [valid, script("clear", "tests.length=0;"), valid],
        input('{"ok":true}'),
        {
          assertionLimit: 1,
        },
      ),
    /断言预算/,
  );
  await assert.rejects(
    runNativeTaskPhase(
      [valid, script("clear", 'tests.length=0;pm.test("ordinary",()=>{});')],
      input('{"ok":true}'),
      { assertionLimit: 1 },
    ),
    /断言预算/,
  );
  const code = await runNativeTaskPhase(
    [
      script("code", "pm.response.code=201;"),
      assertion("direct facade", "", "201", "eq", "responseCode"),
    ],
    input("{}"),
  );
  assert.equal(code.tests[0].passed, true);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runNativeTaskPhase([valid], input('{"ok":true}'), { signal: abort.signal }),
    /取消/,
  );
  const during = new AbortController();
  const pending = runNativeTaskPhase(
    [script("pending", "await new Promise(r=>setTimeout(r,1000));"), valid],
    input('{"ok":true}'),
    { signal: during.signal },
  );
  setTimeout(() => during.abort(), 50);
  await assert.rejects(pending, /取消/);
});

test("real HTTP assertion stage errors keep ordinary continuation but coexisting pick retains strict fail-stop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "assert-errors-")),
    app = await createApp({ root, port: 0 });
  const seen = [];
  let current;
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      req.url === "/first"
        ? (current.body ?? '{"ok":false,"token":"fresh"}')
        : "{}",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => server.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const pick = {
    type: "pickVars",
    id: "pick",
    name: "pick",
    enabled: 1,
    data: {
      source: "responseJson",
      variables: [{ name: "token", expression: "$.token", type: "envVars" }],
    },
  };
  const samples = [
    {
      name: "soft failed then user tests erased",
      tasks: [
        assertion("business", "$.ok", "true"),
        script("erase", "tests.length=0;"),
      ],
      soft: true,
    },
    {
      name: "invalid JSON is stage error, not a test",
      body: "<ok>false</ok>",
      tasks: [assertion("business", "$.ok", "true")],
      error: /严格JSON/,
    },
    {
      name: "object result is unsupported",
      body: '{"ok":{}}',
      tasks: [assertion("business", "$.ok", "true")],
      error: /有限JSON/,
    },
    {
      name: "early return fails declared task",
      tasks: [
        script("return", "return;"),
        assertion("business", "$.ok", "true"),
      ],
      error: /未完成/,
    },
    {
      name: "active pick stops on soft assertion false",
      tasks: [pick, assertion("business", "$.ok", "true")],
      strict: true,
      error: /断言/,
    },
    {
      name: "active pick stops before later pick when assertion parse fails",
      body: "bad JSON",
      tasks: [assertion("business", "$.ok", "true"), pick],
      strict: true,
      error: /严格JSON/,
    },
    {
      name: "disabled pick leaves assertion soft",
      tasks: [{ ...pick, enabled: 0 }, assertion("business", "$.ok", "true")],
      soft: true,
    },
    {
      name: "disabled default and invalid path remain inert",
      tasks: [
        script(
          "literal",
          'pm.environment.set("sourceLiteral","{{unresolved}}");pm.environment.set("expanded",pm.variables.replaceIn("{{token}}"));',
        ),
        {
          type: "assert",
          enabled: -1,
          id: "disabled",
          name: "disabled",
          data: {
            type: "responseJson",
            expression: { path: "$[*] {{path}}", compareValue: "{{token}}" },
          },
        },
      ],
      passed: true,
      soft: true,
    },
    {
      name: "current body view is authoritative for native comparison",
      tasks: [
        script("view", 'apt.response.setBody({ok:true,token:"view"});'),
        assertion("business", "$.ok", "true"),
      ],
      passed: true,
      soft: true,
    },
  ];
  const post = async (p, route, body) => {
    const r = await fetch(`${app.url}/api/projects/${p.id}/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  for (const sample of samples)
    await t.test(sample.name, async () => {
      current = sample;
      seen.length = 0;
      const p = await app.store.create(sample.name);
      p.environments[0].variables.token = "stale";
      await app.store.save(p);
      const plan = await post(p, "plans", {
        steps: [
          {
            request: {
              method: "GET",
              url: base + "/first",
              inheritSharedScripts: false,
              nativeTasks: {
                version: 1,
                before: [],
                after: [
                  script("change", 'pm.environment.set("postOnly","yes");'),
                  ...sample.tasks,
                  script("after", 'pm.environment.set("followingTask","yes");'),
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
      const run = await post(p, "run", { planId: plan.id });
      assert.equal(run.status, sample.passed ? "passed" : "failed");
      assert.equal(run.results.length, sample.strict ? 1 : 2);
      assert.equal(seen.length, sample.strict ? 1 : 2);
      if (!sample.strict) assert.equal(seen.at(-1).auth, "Bearer stale");
      const disk = await new Store(root).get(p.id);
      assert.equal(disk.environments[0].variables.token, "stale");
      assert.equal(
        disk.environments[0].variables.postOnly,
        sample.soft ? "yes" : undefined,
      );
      assert.equal(
        disk.environments[0].variables.followingTask,
        sample.soft ? "yes" : undefined,
      );
      if (sample.error) assert.match(run.results[0].error, sample.error);
      assert.deepEqual(
        run.results[0].request.nativeTasks,
        plan.steps[0].request.nativeTasks,
      );
      if (sample.name.includes("disabled default"))
        assert.equal(
          disk.environments[0].variables.sourceLiteral,
          "{{unresolved}}",
        );
      if (sample.name.includes("disabled default"))
        assert.equal(disk.environments[0].variables.expanded, "stale");
      if (sample.name.includes("current body"))
        assert.equal(JSON.parse(run.results[0].response.body).ok, false);
    });
});

test("native assertion closed data and aggregate limits reject atomically without invoking user coercion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "assert-import-"));
  try {
    const store = new Store(root),
      p = await store.create("atomic assertions"),
      original = structuredClone(p);
    for (const alter of [
      (task) => (task.data.type = "responseXml"),
      (task) => (task.data.expression.compareType = "regex"),
      (task) => (task.data.expression.compareValue = "{{secret}}"),
      (task) => (task.data.expression.path = "$[?(@.secret)]"),
      (task) => (task.data.expression.unknown = true),
      (task) => (task.data.expression.compareValue = "雪".repeat(30000)),
    ]) {
      const source = fixture("http://127.0.0.1:1");
      alter(source.apis[1].request.post_tasks[2]);
      assert.throws(() => importIntoProject(p, source));
      assert.deepEqual(p, original);
    }
    const request = (tasks) => ({
      inheritSharedScripts: false,
      nativeTasks: { version: 1, before: [], after: tasks },
    });
    const valid = assertion("ok", "$.ok", "true");
    assert.equal(
      normalizeNativeTaskRequest(
        request(Array.from({ length: 16 }, () => valid)),
      ).after.length,
      16,
    );
    assert.throws(
      () =>
        normalizeNativeTaskRequest(
          request(Array.from({ length: 17 }, () => valid)),
        ),
      /超限|最多/,
    );
    assert.throws(
      () =>
        normalizeNativeTaskRequest(
          request(
            Array.from({ length: 5 }, (_, i) =>
              assertion("large" + i, "$.ok", "x".repeat(60000)),
            ),
          ),
        ),
      /256KiB/,
    );
    assert.throws(
      () =>
        normalizeNativeTaskRequest({
          inheritSharedScripts: false,
          nativeTasks: { version: 1, before: [valid], after: [] },
        }),
      /后置/,
    );
    let calls = 0;
    const object = {
      [Symbol.toPrimitive]() {
        calls++;
        return "eq";
      },
    };
    assert.throws(() =>
      normalizeNativeAssertionData({
        type: "responseJson",
        expression: { path: "$", compareType: object, compareValue: "" },
      }),
    );
    const data = {
      type: "responseJson",
      expression: { path: "$", compareType: "eq", compareValue: "" },
    };
    Object.defineProperty(data.expression, "compareValue", {
      enumerable: true,
      get() {
        calls++;
        return "";
      },
    });
    assert.throws(() => compileNativeAssertions([{ name: "getter", data }]));
    assert.equal(calls, 0);
    assert.deepEqual(await new Store(root).get(p.id), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request wire interpolation never rewrites active or inert native task sources", async () => {
  const task = script(
    "literal",
    'pm.environment.set("literal","{{missing}}");',
  );
  const request = {
    url: "http://127.0.0.1/{{wire}}",
    headers: [{ key: "x-fixture", value: "{{wire}}" }],
    body: "{{wire}}",
    nativeTasks: { version: 1, before: [], after: [task] },
    importedScriptTasks: { version: 1, before: [], after: [task] },
    importedNativeTaskSource: { version: 1, before: [], after: [task] },
  };
  const original = structuredClone(request);
  const resolved = await resolveDynamicRequest(
    request,
    { wire: "resolved" },
    [],
    interpolate,
  );
  assert.equal(resolved.url, "http://127.0.0.1/resolved");
  assert.equal(resolved.headers[0].value, "resolved");
  assert.equal(resolved.body, "resolved");
  for (const key of [
    "nativeTasks",
    "importedScriptTasks",
    "importedNativeTaskSource",
  ])
    assert.deepEqual(resolved[key], original[key]);
  assert.deepEqual(request, original);
});
