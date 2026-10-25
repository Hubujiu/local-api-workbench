import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportApipost } from "../src/apipost-export.mjs";
import {
  normalizeRequest,
  importIntoProject,
  restoreProject,
  interpolate,
} from "../src/core.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { environmentVariables } from "../src/environments.mjs";

test("native JSON definition export reimports, persists and restores literal HTTP and environment values without mutation", async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({
      method: req.method,
      url: req.url,
      body,
      auth: req.headers.authorization,
      header: req.headers["x-value"],
    });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-export-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    p = await store.create("Fictional native export");
  p.environments[0].variables.value = "current";
  p.environments[0].variableDefinitions = {
    value: { initialValue: "initial", description: "preserved" },
  };
  p.folders = ["A", "A/B"];
  p.requests = [
    normalizeRequest({
      id: "source",
      name: "Echo",
      folder: "A/B",
      method: "POST",
      url: `http://127.0.0.1:${server.address().port}/echo?literal=%2f`,
      query: [
        { key: "q", value: "one" },
        { key: "q", value: "two" },
        { key: "skip", value: "disabled", enabled: false },
      ],
      headers: [{ key: "X-Value", value: "{{value}}" }],
      bodyType: "json",
      body: '{"value":"{{value}}"}',
      auth: { type: "basic", username: "fixture", password: "fictional" },
    }),
  ];
  const before = structuredClone(p),
    document = exportApipost(p);
  assert.deepEqual(p, before);
  assert.deepEqual(exportApipost(p), document);
  const target = await store.create("Imported");
  target.environments = [];
  importIntoProject(target, JSON.stringify(document));
  await store.save(target);
  const saved = await store.get(target.id),
    restored = restoreProject(saved);
  const repeatedExport = exportApipost(saved),
    third = await store.create("Second export");
  third.environments = [];
  importIntoProject(third, repeatedExport);
  assert.equal(third.requests[0].url, saved.requests[0].url);
  assert.deepEqual(third.requests[0].query, saved.requests[0].query);

  await store.save(restored);
  for (const copy of [saved, await store.get(restored.id)]) {
    assert.equal(copy.requests[0].folder, "A/B");
    assert.equal(
      copy.environments[0].variableDefinitions.value.initialValue,
      "initial",
    );
    const r = interpolate(
      copy.requests[0],
      environmentVariables(copy, copy.environments[0].id),
    );
    assert.equal((await executeRequest(r)).status, 200);
  }
  assert.deepEqual(
    seen,
    Array(2).fill({
      method: "POST",
      url: "/echo?literal=%2f&q=one&q=two",
      body: '{"value":"current"}',
      auth: "Basic Zml4dHVyZTpmaWN0aW9uYWw=",
      header: "current",
    }),
  );
  assert.notEqual(restored.id, target.id);
  assert.deepEqual(p, before);
});

test("unsupported native export dependencies reject rather than create silently partial definitions", () => {
  const base = {
    id: "p",
    name: "P",
    requests: [normalizeRequest({ id: "r", url: "http://127.0.0.1/a" })],
    environments: [],
    settings: {},
  };
  for (const change of [
    (p) => (p.plans = [{ id: "plan" }]),
    (p) => (p.protocols = [{ id: "ws" }]),
    (p) => (p.settings.globalScripts = { beforeScript: "danger()" }),
    (p) => (p.requests[0].bodyDynamic = { a: { source: "x" } }),
    (p) => (p.requests[0].auth = { type: "hawk" }),
    (p) => (p.requests[0].timeout = 1000),
    (p) => (p.requests[0].beforeScript = "danger()"),
    (p) => (p.requests[0].examples = [{ status: 200, body: "x" }]),
    (p) => p.requests.push(p.requests[0]),
    (p) =>
      (p.environments = [
        { id: "dup", name: "A" },
        { id: "dup", name: "B" },
      ]),
    (p) =>
      (p.environments = [
        {
          id: "e",
          name: "A",
          variables: {},
          serverUrls: { missing: "http://127.0.0.1" },
        },
      ]),
    (p) =>
      (p.servers = [
        { id: "s", name: "S" },
        { id: "s", name: "S2" },
      ]),
    (p) =>
      (p.environments = [
        { id: "e", name: "A", variables: { nullValue: null } },
      ]),
  ]) {
    const p = structuredClone(base);
    change(p);
    const snapshot = structuredClone(p);
    assert.throws(() => exportApipost(p));
    assert.deepEqual(p, snapshot);
  }
});

test("current native script source cannot be silently replaced by stale provenance", () => {
  const p = {
    id: "p",
    name: "P",
    environments: [],
    settings: {},
    requests: [
      normalizeRequest({
        id: "r",
        url: "http://127.0.0.1/echo",
        scriptDialect: "apipost8",
        beforeScript: 'console.log("current");',
      }),
    ],
  };
  const out = exportApipost(p);
  assert.equal(
    out.apis[0].request.pre_tasks[0].data,
    'console.log("current");',
  );
  p.requests[0].importedScriptTasks = {
    version: 1,
    before: [
      {
        id: "t",
        name: "old",
        enabled: 1,
        type: "customScript",
        data: 'console.log("old");',
      },
    ],
    after: [],
  };
  assert.throws(() => exportApipost(p), /当前脚本已修改/);
  p.requests[0].beforeScript = 'console.log("old");';
  assert.equal(
    exportApipost(p).apis[0].request.pre_tasks[0].data,
    p.requests[0].beforeScript,
  );
  p.environments = [
    {
      id: "e",
      name: "Env",
      variables: {},
      variableDefinitions: {
        missing: { initialValue: "not-current", description: "" },
      },
    },
  ];
  assert.throws(() => exportApipost(p), /未设置/);
});

test("public export endpoint is authenticated, read-only and rejects partial native exports", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "native-export-http-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Endpoint");
  p.requests = [normalizeRequest({ id: "r", url: "http://127.0.0.1/echo" })];
  await app.store.save(p);
  const endpoint = app.url + "/api/projects/" + p.id + "/export?format=apipost";
  assert.equal((await fetch(endpoint)).status, 403);
  const before = await app.store.get(p.id);
  const res = await fetch(endpoint, {
    headers: { "x-local-token": app.token },
  });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.apis.length, 1);
  assert.equal(doc.name, "Endpoint");
  assert.deepEqual(await app.store.get(p.id), before);
  const q = await app.store.create("Separate");
  q.requests = [normalizeRequest({ id: "q", url: "http://127.0.0.1/other" })];
  await app.store.save(q);
  const other = await (
    await fetch(app.url + "/api/projects/" + q.id + "/export?format=apipost", {
      headers: { "x-local-token": app.token },
    })
  ).json();
  assert.notEqual(other.project_id, doc.project_id);
  assert.equal(other.apis[0].url, "http://127.0.0.1/other");
  p.requests[0].beforeScript = 'throw Error("not executed")';
  await app.store.save(p);
  const bad = await fetch(endpoint, {
    headers: { "x-local-token": app.token },
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /脚本方言/);
  assert.equal(
    (await app.store.get(p.id)).requests[0].beforeScript,
    p.requests[0].beforeScript,
  );
});

test("native custom scripts and text forms execute after export/import, while disabled source remains inert", async (t) => {
  const { runPlan } = await import("../src/core.mjs");
  const { scopedExecution } = await import("../src/variable-scopes.mjs");
  const seen = [],
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen.push({ body, type: req.headers["content-type"], url: req.url });
      res.setHeader("content-type", "application/json");
      res.end('{"result":"after"}');
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-export-script-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    source = await store.create("Scripts and forms");
  source.environments[0].variables = {};
  source.requests = [
    normalizeRequest({
      id: "r",
      name: "Script form",
      method: "POST",
      url: `http://127.0.0.1:${server.address().port}/forms`,
      bodyType: "urlencoded",
      form: [
        { key: "value", value: "{{value}}" },
        { key: "repeat", value: "one" },
        { key: "repeat", value: "two" },
        { key: "skip", value: "off", enabled: false },
      ],
      scriptDialect: "apipost8",
      beforeScript: 'apt.environment.set("value", "from-script");',
      afterScript: 'apt.environment.set("after", apt.response.json().result);',
    }),
  ];
  source.requests[0].importedScriptTasks = {
    version: 1,
    before: [
      {
        id: "active",
        name: "active",
        type: "customScript",
        enabled: 1,
        data: source.requests[0].beforeScript,
      },
      {
        id: "disabled",
        name: "disabled",
        type: "customScript",
        enabled: -1,
        data: 'throw Error("must remain disabled")',
      },
    ],
    after: [],
  };
  const target = await store.create("Imported");
  target.environments = [];
  importIntoProject(target, exportApipost(source));
  await store.save(target);
  const env = target.environments[0];
  const result = await runPlan(
    { steps: [{ request: target.requests[0] }] },
    {},
    executeRequest,
    scopedExecution(store, target, env.id),
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, "value=from-script&repeat=one&repeat=two");
  assert.match(seen[0].type, /application\/x-www-form-urlencoded/);
  const saved = await store.get(target.id);
  assert.equal(saved.environments[0].variables.after, "after");
  assert.equal(saved.requests[0].importedScriptTasks.before[1].enabled, -1);
  assert.deepEqual(source.environments[0].variables, {});
});
