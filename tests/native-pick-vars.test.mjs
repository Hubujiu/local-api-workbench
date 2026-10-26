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
