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
      url: `http://127.0.0.1:${server.address().port}/echo?literal=one`,
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
      url: "/echo?literal=one&q=one&q=two",
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
    (p) => (p.requests[0].url = "http://127.0.0.1/echo?literal=%2f"),
    (p) =>
      (p.servers = [
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ]),

    (p) => (p.protocols = [{ id: "ws" }]),
    (p) => (p.settings.globalScripts = { beforeScript: "danger()" }),
    (p) => (p.requests[0].bodyDynamic = { a: { source: "x" } }),
    (p) => (p.requests[0].auth = { type: "hawk", user: "unmapped-extension" }),
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

test("native export matrix preserves service, URL-only query, path and multipart through restore; API-key export shape is explicit", async (t) => {
  const { nativeExportMatrix } = await import(
    "./fixtures/native-export-matrix.mjs"
  );
  const { runPlan } = await import("../src/core.mjs");
  const { scopedExecution } = await import("../src/variable-scopes.mjs");
  const { resolveServiceRequest } = await import("../src/environments.mjs");
  const seen = [],
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const type = req.headers["content-type"];
      const fields = type?.startsWith("multipart/form-data")
        ? [
            ...(await new Response(body, {
              headers: { "content-type": type },
            }).formData()),
          ]
        : null;
      seen.push({
        path: req.url,
        body,
        fields,
        auth: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      res.end('{"fixture":"native-roundtrip"}');
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-export-matrix-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const source = nativeExportMatrix(server.address().port);
  // The isolated PR #5 base has no native kv importer (provided by PR #8).
  // Verify export shape here; combined/original acceptance runs the actual key.
  assert.deepEqual(
    exportApipost(source).apis.find((a) => a.name === "Export Path Key").request
      .auth,
    { type: "kv", kv: { in: "query", key: "api-key", value: "fictional-key" } },
  );
  source.requests[1].auth = { type: "none" };
  const before = structuredClone(source),
    doc = exportApipost(source);
  assert.equal(doc.global.servers[0].server_id, "1");
  assert.equal(
    doc.apis.find((a) => a.name === "Export Path Key").request.query
      .parameter[0].key,
    "literal",
  );
  const store = new Store(root),
    p = await store.create("matrix");
  p.environments = [];
  importIntoProject(p, doc);
  await store.save(p);
  const restored = restoreProject(await store.get(p.id));
  await store.save(restored);
  for (const id of [p.id, restored.id]) {
    const reopened = new Store(root),
      copy = await reopened.get(id),
      env = copy.environments[0];
    env.variables = { value: "reset-before-run" };
    await reopened.save(copy);
    const steps = copy.requests.map((r) => ({
      request: resolveServiceRequest(copy, r, env.id),
    }));
    const result = await runPlan(
      { steps },
      {},
      executeRequest,
      scopedExecution(reopened, copy, env.id),
    );
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(
      (await reopened.get(id)).environments[0].variables.after,
      "native-roundtrip",
    );
  }
  assert.equal(seen.length, 6);
  for (const offset of [0, 3]) {
    assert.equal(seen[offset].path, "/echo?fixture=export-script");
    assert.equal(
      seen[offset].body,
      "value=from-export-script&repeat=one&repeat=two",
    );
    assert.equal(seen[offset].auth, "Bearer fictional-export-bearer");
    assert.equal(
      seen[offset + 1].path,
      "/echo/alpha?literal=one&fixture=export-path",
    );
    assert.equal(seen[offset + 1].body, '{"kind":"path-key"}');
    assert.equal(seen[offset + 2].path, "/echo?fixture=export-multipart");
    assert.deepEqual(seen[offset + 2].fields, [
      ["value", "literal text"],
      ["repeat", "one"],
      ["repeat", "two"],
    ]);
  }
  assert.deepEqual(source, before);
});

test("native task pipelines cannot be silently erased by native JSON export", () => {
  for (const nativeTasks of [
    {
      version: 1,
      before: [
        {
          type: "customScript",
          enabled: 1,
          data: 'apt.environment.set("owned","before");',
        },
      ],
      after: [],
    },
    {
      version: 1,
      before: [],
      after: [
        {
          type: "customScript",
          enabled: -1,
          data: "disabled source must survive",
        },
      ],
    },
    {
      version: 1,
      before: [
        {
          type: "database",
          enabled: 1,
          data: {
            connectionId: "fixture",
            query: "SELECT 1",
            variables: [],
            isConsoleOutput: -1,
          },
        },
      ],
      after: [],
    },
  ]) {
    const p = {
      id: "p",
      name: "P",
      environments: [],
      settings: {},
      requests: [
        {
          ...normalizeRequest({
            id: "r",
            url: "http://127.0.0.1/echo",
            inheritSharedScripts: false,
            scriptDialect: "apipost8",
          }),
          nativeTasks,
        },
      ],
    };
    const before = structuredClone(p);
    assert.throws(() => exportApipost(p), /nativeTasks/);
    assert.deepEqual(p, before);
    const inert = structuredClone(p);
    inert.requests[0].importedNativeTaskSource = inert.requests[0].nativeTasks;
    delete inert.requests[0].nativeTasks;
    const inertBefore = structuredClone(inert);
    assert.throws(() => exportApipost(inert), /importedNativeTaskSource/);
    assert.deepEqual(inert, inertBefore);
  }
});
test("HTTP native export refuses a stored native pipeline without changing the project", async (t) => {
  const { createApp } = await import("../src/server.mjs"),
    root = await mkdtemp(path.join(os.tmpdir(), "native-task-export-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Task export");
  p.requests = [
    {
      ...normalizeRequest({
        id: "r",
        url: "http://127.0.0.1/echo",
        inheritSharedScripts: false,
        scriptDialect: "apipost8",
      }),
      nativeTasks: {
        version: 1,
        before: [
          {
            type: "customScript",
            enabled: 1,
            data: 'apt.environment.set("mustNotDisappear","yes");',
          },
        ],
        after: [],
      },
    },
  ];
  await app.store.save(p);
  const before = JSON.stringify(await app.store.get(p.id));
  const response = await fetch(
    app.url + "/api/projects/" + p.id + "/export?format=apipost",
    { headers: { "x-local-token": app.token } },
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /nativeTasks/);
  assert.equal(JSON.stringify(await app.store.get(p.id)), before);
});

test("native exports preserve disabled Mock by refusing it, while neutral false and empty settings remain exportable", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  const root = await mkdtemp(
    path.join(os.tmpdir(), "native-export-disabled-mock-"),
  );
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Closed Mock");
  project.requests = [
    normalizeRequest({
      id: "mock",
      name: "Mock",
      url: "http://127.0.0.1/echo",
    }),
  ];
  project.settings = { mockEnabled: false };
  await app.store.save(project);
  const before = await app.store.get(project.id);
  const mockURL = `${app.url}/mock/${project.id}/mock`;
  assert.equal((await fetch(mockURL)).status, 503);
  for (const [format, exporter] of [
    ["apipost", exportApipost],
    ["apipost-directory", exportApipostDirectory],
  ]) {
    assert.throws(() => exporter(project), /项目Mock关闭/);
    const url = `${app.url}/api/projects/${project.id}/export?format=${format}`;
    assert.equal((await fetch(url)).status, 403);
    const response = await fetch(url, {
      headers: { "x-local-token": app.token },
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /项目Mock关闭/);
    assert.deepEqual(await app.store.get(project.id), before);
  }
  assert.equal((await fetch(mockURL)).status, 503);
  const backup = restoreProject(before);
  assert.equal(backup.settings.mockEnabled, false);
  project.settings = {
    smartMockBuiltins: false,
    builtinDictionary: false,
    recursiveFolderScopes: false,
    mockFieldRules: [],
    folderParameters: {},
    functions: [],
  };
  for (const exporter of [exportApipost, exportApipostDirectory])
    assert.doesNotThrow(() => exporter(project));
  project.settings.mockSeed = 0;
  assert.throws(() => exportApipost(project), /mockSeed/);
});

test("native exports refuse SDK URL mode without disabling its real execution or backup/frozen-plan recovery", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-export-sdk-mode-"));
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
  const post = async (route, body, status = 200) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const project = await app.store.create("SDK mode");
  const request = normalizeRequest({
    id: "sdk",
    name: "SDK mode",
    url: `http://127.0.0.1:${upstream.address().port}/echo`,
    scriptDialect: "apipost8",
    scriptURLMode: "sdk",
    beforeScript: "pm.request.url.query.add({key:'proof',value:'kept'});",
  });
  project.requests = [request];
  await app.store.save(project);
  await post(`/api/projects/${project.id}/execute`, { request });
  assert.equal(seen.at(-1), "/echo?proof=kept");
  const before = await app.store.get(project.id);
  const count = seen.length;
  for (const format of ["apipost", "apipost-directory"]) {
    const url = `${app.url}/api/projects/${project.id}/export?format=${format}`;
    assert.equal((await fetch(url)).status, 403);
    const response = await fetch(url, {
      headers: { "x-local-token": app.token },
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /SDK URL/);
    assert.deepEqual(await app.store.get(project.id), before);
  }
  assert.equal(seen.length, count);
  const withoutScript = structuredClone(before);
  withoutScript.requests[0].beforeScript = "";
  for (const exporter of [exportApipost, exportApipostDirectory])
    assert.throws(() => exporter(withoutScript), /SDK URL/);
  const plan = await post(`/api/projects/${project.id}/plans`, {
    name: "Frozen SDK",
    environmentId: project.environments[0].id,
    steps: [{ request }],
  });
  const live = await app.store.get(project.id);
  delete live.requests[0].scriptURLMode;
  live.requests[0].beforeScript = "";
  await app.store.save(live);
  assert.throws(() => exportApipostDirectory(live), /SDK URL/);
  const frozenError = await fetch(
    `${app.url}/api/projects/${project.id}/export?format=apipost-directory`,
    { headers: { "x-local-token": app.token } },
  );
  assert.equal(frozenError.status, 400);
  assert.match((await frozenError.json()).error, /SDK URL/);
  assert.equal(live.plans[0].steps[0].request.scriptURLMode, "sdk");
  const backupResponse = await fetch(
    `${app.url}/api/projects/${project.id}/export`,
    { headers: { "x-local-token": app.token } },
  );
  assert.equal(backupResponse.status, 200);
  const backup = await backupResponse.json();
  const restored = await post("/api/restore", { document: backup }, 201);
  await stop();
  app = await createApp({ root, port: 0 });
  const run = await post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
  });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(seen.at(-1), "/echo?proof=kept");
  assert.equal(
    (await app.store.get(restored.id)).plans[0].steps[0].request.scriptURLMode,
    "sdk",
  );
  for (const dialect of ["legacy", "apipost8"]) {
    const simple = structuredClone(before);
    simple.plans = [];
    delete simple.requests[0].scriptURLMode;
    simple.requests[0].scriptDialect = dialect;
    simple.requests[0].beforeScript = "";
    for (const exporter of [exportApipost, exportApipostDirectory])
      assert.doesNotThrow(() => exporter(simple));
  }
});
