import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
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
    { compareType: "lt" },
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
});
