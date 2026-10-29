import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
// Requires the dependency base containing the reviewed Unicode OOM fix.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import {
  normalizeNativeAssertionData,
  compileNativeAssertions,
} from "../src/native-response-assertions.mjs";
const match = (type, path, compareValue, name = type) => ({
  type: "assert",
  enabled: 1,
  name,
  data: {
    type,
    expression: { path, compareType: "regularmatch", compareValue },
  },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
const phase = (tasks, patch = {}, options) =>
  runNativeTaskPhase(
    tasks,
    {
      request: {},
      scopes: {
        globals: { value: "global" },
        environment: { value: "environment" },
        runtime: { value: "temporary" },
      },
      ...patch,
    },
    options,
  );
async function response(t) {
  const server = http.createServer((_q, r) => {
    r.setHeader("x-value", "header");
    r.setHeader("set-cookie", "session=cookie");
    r.end('{"value":"json"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return executeRequest({ url: `http://127.0.0.1:${server.address().port}/` });
}

test("regularmatch literal bounds preserve syntax lazily without host compilation", () => {
  for (const raw of [
    "[",
    "{{dynamic}}",
    "///",
    "/abc/i",
    "//abc//",
    " ",
    "x".repeat(1024),
    "汉".repeat(1024),
  ]) {
    const task = match("envVars", "value", raw);
    assert.equal(
      normalizeNativeAssertionData(task.data).expression.compareValue,
      raw,
    );
    assert.equal(
      compileNativeAssertions([{ name: "lazy", data: task.data }])[0].expected,
      raw,
    );
  }
  for (const raw of ["", "x".repeat(1025), "汉".repeat(1025), "\ud800"])
    assert.throws(() =>
      normalizeNativeAssertionData(match("envVars", "value", raw).data),
    );
  const inert = match("envVars", "value", "[").data;
  assert.deepEqual(
    normalizeNativeAssertionData(inert, { enabled: false }),
    inert,
  );
  const empty = match("envVars", "value", "").data;
  assert.deepEqual(
    normalizeNativeAssertionData(empty, { enabled: false }),
    empty,
  );
});

test("regularmatch covers all eleven sources with current values and before variables", async (t) => {
  const pre = await phase([
    match("tempVars", "{{value}}", "/^temporary$/"),
    match("envVars", "value", "^environment$"),
    match("globalVars", "value", "^global$"),
  ]);
  assert(pre.tests.every((x) => x.passed));
  const wire = await response(t);
  const post = await phase(
    [
      match("responseCode", "", "^200$"),
      match("responseJson", "$.value", "^json$"),
      match("responseHeader", "x-value", "^header$"),
      match("responseCookie", "session", "^cookie$"),
      match("responseTime", "", "^[0-9]+(?:\\.[0-9]+)?$"),
      match("responseSize", "", "^[0-9]+$"),
      match("tempVars", "value", "^temporary$"),
      match("envVars", "value", "^environment$"),
      match("globalVars", "value", "^global$"),
      script('pm.response.setBody("<root><value>xml</value></root>");'),
      match("responseXml", "string(/root/value)", "^xml$"),
      match("responseText", "", "^<root>"),
    ],
    { response: wire },
  );
  assert.equal(post.tests.length, 11);
  assert(post.tests.every((x) => x.passed));
});

test("regularmatch strips only outer slash characters, has no flags, and converts safe primitives", async () => {
  const rows = [
    ["abc", "//abc//", true],
    ["ABC", "/abc/i", false],
    ["abc/i", "/abc/i", true],
    ["anything", "///", true],
    [" abc ", " /abc/ ", false],
    [null, "^null$", true],
    [undefined, "^undefined$", true],
    [false, "^false$", true],
    [0, "^0$", true],
    [12.5, "^12\\.5$", true],
  ];
  for (const [value, pattern, passed] of rows) {
    const result = await phase([match("envVars", "value", pattern)], {
      scopes: { environment: { value } },
    });
    assert.equal(result.tests[0].passed, passed, pattern);
  }
});

test("regularmatch reads safe source before runtime syntax and retains current getter refusal", async () => {
  await assert.rejects(
    () => phase([match("envVars", "value", "[")]),
    /SyntaxError|invalid|unterminated|unexpected|正则|regular/i,
  );
  await assert.rejects(
    () =>
      phase([match("envVars", "value", "[")], {
        scopes: { environment: { value: { bad: true } } },
      }),
    /原始值|对象/,
  );
  for (const value of ["x".repeat(65537), "汉".repeat(22000), "\ud800"])
    await assert.rejects(
      () =>
        phase([match("envVars", "value", "///")], {
          scopes: { environment: { value } },
        }),
      /64KiB|Unicode/,
    );
  for (const [type, path, code] of [
    ["responseCode", "", "pm.response.code='x'.repeat(65537)"],
    [
      "responseJson",
      "$.value",
      "pm.response.setBody(JSON.stringify({value:'x'.repeat(65537)}))",
    ],
  ])
    await assert.rejects(
      () =>
        phase([script(code), match(type, path, "///")], {
          response: { status: 200, body: "{}" },
        }),
      /64KiB/,
    );
  const inert = { ...match("responseText", "", "["), enabled: 0 };
  const skipped = await phase([inert]);
  assert.equal(skipped.tests.length, 0);
  await assert.rejects(
    () =>
      phase([
        script(
          "Object.defineProperty(scopeState.environment,'value',{get(){throw Error('getter invoked')},enumerable:true})",
        ),
        match("envVars", "value", "///"),
      ]),
    (error) => {
      assert.match(error.message, /自有数据/);
      assert.doesNotMatch(error.message, /getter invoked/);
      return true;
    },
  );
});

test("regularmatch captures constructor and direct exec and preserves private soft-failure evidence", async () => {
  const result = await phase([
    script(
      "const Original=RegExp;Original.prototype.exec=()=>{throw Error('public exec')};Original.prototype.test=()=>true;globalThis.RegExp=function(){throw Error('public constructor')};pm.test=()=>{};",
    ),
    match("envVars", "value", "^wrong$", "false remains"),
    script("tests.length=0;pm.environment.set('value','edited');"),
    match("envVars", "value", "^edited$", "current"),
  ]);
  assert.deepEqual(
    Object.fromEntries(result.tests.map((x) => [x.name, x.passed])),
    { "false remains": false, current: true },
  );
});

test("regularmatch syntax errors and interrupted matching cannot complete or leak scopes", async () => {
  await assert.rejects(
    () =>
      phase([
        script("pm.environment.set('marker','uncommitted')"),
        match("envVars", "value", "["),
      ]),
    /SyntaxError|invalid|unterminated|unexpected|正则|regular/i,
  );
  await assert.rejects(
    () =>
      phase([
        script(
          "pm.environment.set('value','a'.repeat(64)+'!');pm.environment.set('marker','uncommitted');",
        ),
        match("envVars", "value", "(a+)+$"),
      ]),
    (error) => {
      assert.equal(error.message, "脚本执行超时");
      assert.equal(error.scriptStage, "script");
      assert.equal(error.activityOperation, "promise-state");
      assert.equal(error.scriptDiagnostics.activityBudgetMs, 250);
      return true;
    },
  );
  const fresh = await phase([
    match("envVars", "marker", "^undefined$"),
    match("envVars", "value", "^environment$"),
  ]);
  assert(fresh.tests.every((x) => x.passed));
});

test("regularmatch rejects bounded-phase OOM and fresh invocation remains usable", async () => {
  await assert.rejects(
    () =>
      phase([
        script(
          "pm.environment.set('value','a'.repeat(32768));let retained=[];for(let i=0;i<15;i++)retained.push(new ArrayBuffer(1024*1024));",
        ),
        match("envVars", "value", "^(a)*$"),
      ]),
    /memory|内存/i,
  );
  const fresh = await phase([match("envVars", "value", "^environment$")]);
  assert.equal(fresh.tests[0].passed, true);
});

test("regularmatch imported HTTP lifecycle preserves before failure, post soft/strict policies and restored frozen evidence", async (t) => {
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.end('{"value":"wire"}');
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(tmpdir(), "native-regex-http-"));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await close();
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, body, status = 200) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, status, JSON.stringify(result));
    return result;
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
  api.url = `http://127.0.0.1:${peer.address().port}/regex`;
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [
    script(
      "pm.environment.set('candidate','before');pm.variables.set('beforePattern','/^before$/');",
    ),
    match("envVars", "{{candidate}}", "{{beforePattern}}", "before match"),
  ];
  api.request.post_tasks = [
    script(
      "pm.response.setBody('{\"value\":\"edited\"}');pm.environment.set('candidate','after');pm.variables.set('afterPattern','/^edited$/');pm.variables.set('falsePattern','^deliberate-false$');",
    ),
    match("responseJson", "$.value", "{{afterPattern}}", "current match"),
    match("responseJson", "$.value", "{{falsePattern}}", "soft false"),
    script("pm.globals.set('finished','yes');"),
  ];
  for (const key of ["pre_tasks", "post_tasks"])
    api.request[key].forEach((task, i) => {
      task.id = `${key}-${i}`;
      task.name ??= task.id;
    });
  const original = structuredClone(source),
    p = await app.store.create("regex lifecycle"),
    other = await app.store.create("isolated");
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  await app.store.save(p);
  const untouched = await app.store.get(other.id);
  const request = p.requests[0],
    beforeBad = structuredClone(request);
  beforeBad.nativeTasks.before[1].data.expression.compareValue = "^no$";
  const beforePlan = await post(`/api/projects/${p.id}/plans`, {
    steps: [{ request: beforeBad }],
  });
  const beforeRun = await post(`/api/projects/${p.id}/run`, {
    planId: beforePlan.id,
  });
  assert.equal(beforeRun.status, "failed");
  assert.equal(beforeRun.recordSaved, true);
  assert.equal(seen.length, 0);
  assert.match(beforeRun.results[0].error, /前置脚本断言失败/);
  assert(
    !Object.hasOwn(
      (await app.store.get(p.id)).environments[0].variables,
      "candidate",
    ),
  );
  const plan = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request },
      { request: { url: api.url + "/later", inheritSharedScripts: false } },
    ],
  });
  const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results[1].status, "passed");
  assert.deepEqual(
    run.results[0].assertions.map((x) => x.passed),
    [true, true, false],
  );
  assert.equal(seen.length, 2);
  let disk = await app.store.get(p.id);
  assert.equal(disk.environments[0].variables.candidate, "after");
  assert.equal(disk.globalVariables.finished, "yes");
  const syntax = structuredClone(request);
  syntax.nativeTasks.after[0].data += "pm.variables.set('afterPattern', '[');";
  const syntaxPlan = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: syntax },
      {
        request: {
          url: api.url + "/syntax-later",
          inheritSharedScripts: false,
        },
      },
    ],
  });
  const bad = await post(`/api/projects/${p.id}/run`, {
    planId: syntaxPlan.id,
  });
  assert.equal(bad.status, "failed");
  assert.equal(bad.recordSaved, true);
  assert.equal(bad.results[1].status, "passed");
  assert(bad.results[0].error);
  disk = await app.store.get(p.id);
  assert.equal(
    disk.environments[0].variables.candidate,
    "before",
    "syntax failure must roll back its post scope",
  );
  const strict = structuredClone(request);
  strict.nativeTasks.after.push({
    type: "pickVars",
    enabled: 1,
    data: {
      source: "responseJson",
      variables: [{ name: "picked", type: "envVars", expression: "$.value" }],
    },
  });
  const strictPlan = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: strict },
      {
        request: {
          url: api.url + "/strict-must-not-send",
          inheritSharedScripts: false,
        },
      },
    ],
  });
  const strictRun = await post(`/api/projects/${p.id}/run`, {
    planId: strictPlan.id,
  });
  assert.equal(strictRun.status, "failed");
  assert.equal(strictRun.recordSaved, true);
  assert(!seen.some((x) => x.includes("strict-must-not-send")));
  disk = await app.store.get(p.id);
  assert.equal(disk.environments[0].variables.candidate, "before");
  assert(!Object.hasOwn(disk.environments[0].variables, "picked"));
  const restored = await post("/api/restore", { document: disk }, 201);
  assert.deepEqual(
    restored.requests[0].nativeTasks,
    disk.requests[0].nativeTasks,
  );
  assert.deepEqual(
    restored.plans.find((x) => x.id === syntaxPlan.id).steps[0].request
      .nativeTasks,
    syntaxPlan.steps[0].request.nativeTasks,
  );
  await close();
  app = await createApp({ root, port: 0 });
  const rerun = await post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
  });
  assert.equal(rerun.status, "failed");
  assert.equal(rerun.recordSaved, true);
  assert.equal(rerun.results[1].status, "passed");
  assert.deepEqual(
    rerun.results[0].assertions.map((x) => x.passed),
    [true, true, false],
  );
  assert.deepEqual(await new Store(root).get(other.id), untouched);
});
