import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
} from "../src/core.mjs";
import { createMCP } from "../src/mcp.mjs";
import { freezeServiceBinding } from "../src/environments.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-inheritance-"));
  const wire = [];
  const peer = http
    .createServer((req, res) => {
      wire.push({ url: req.url, headers: req.headers });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    })
    .listen(0, "127.0.0.1");
  await once(peer, "listening");
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await close(app.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  });
  async function call(route, data, status = 200, method = "POST") {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  function source(token) {
    const d = nativeInheritanceFixture();
    d.global.envs[0].server_list[0].uri = `http://127.0.0.1:${peer.address().port}`;
    d.global.envs[0].env_var_list.token = {
      value: token,
      current_value: token,
    };
    d.global.envs[0].env_var_list.zero = { value: 0, current_value: 0 };
    d.global.envs[0].env_var_list.falseValue = {
      value: false,
      current_value: false,
    };
    d.global.envs[0].env_var_list.empty = { value: "", current_value: "" };
    d.global.global_param.query.parameter = [
      { key: "zero", value: "{{zero}}", is_checked: 1 },
      { key: "false", value: "{{falseValue}}", is_checked: 1 },
      { key: "empty", value: "{{empty}}", is_checked: 1 },
    ];
    d.global.global_param.cookie.parameter = [
      { key: "session", value: "{{token}}", is_checked: 1 },
    ];
    return d;
  }
  return { root, wire, app, call, source };
}

test("owner native import → live/curl/MCP → frozen plan → backup/restart preserves graph isolation and runtime environment semantics", async (t) => {
  const { root, wire, app, call, source } = await fixture(t);
  const a = await app.store.create("A"),
    b = await app.store.create("B");
  const document = source("fictional-a"),
    before = structuredClone(document);
  let p = await call(`projects/${a.id}/import`, {
    document,
    inheritanceMode: "preserve",
  });
  let q = await call(`projects/${b.id}/import`, {
    document: source("fictional-b"),
    inheritanceMode: "preserve",
  });
  assert.deepEqual(document, before);
  assert.equal(wire.length, 0, "import never sends requests");
  assert.equal(
    p.settings.nativeInheritance.sourceProjectId,
    q.settings.nativeInheritance.sourceProjectId,
  );
  const route = (name) => `projects/${p.id}/${name}`;
  await call(route("execute"), { request: p.requests[0] });
  assert.equal(wire.at(-1).headers.authorization, "Bearer fictional-a");
  assert.equal(wire.at(-1).headers["x-shared"], "project");
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  assert.equal(wire.at(-1).headers.cookie, "session=fictional-a");
  const query = new URL(wire.at(-1).url, "http://loopback").searchParams;
  assert.equal(query.get("zero"), "0");
  assert.equal(query.get("false"), "false");
  assert.equal(query.get("empty"), "");
  const curl = await call(route("curl"), { request: p.requests[0] });
  assert.match(curl.curl, /fictional-a/);
  assert.match(curl.curl, /x-folder: folder/);
  const plan = await call(route("plans"), {
    name: "Frozen",
    environmentId: p.environments[0].id,
    steps: [{ request: p.requests[0] }],
  });
  assert.equal(plan.steps[0].request.nativeInheritance, undefined);
  assert.equal(
    plan.steps[0].request.auth.token,
    "{{token}}",
    "only layer config freezes, not variable values",
  );
  p = await app.store.get(p.id);
  p.settings.nativeInheritance.projectLayer.headers[0].value = "parent-edited";
  p.settings.nativeInheritance.folders[0].layer.headers[0].value =
    "folder-edited";
  p.environments[0].variables.token = "fictional-a-new";
  await app.store.save(p);
  await call(route("execute"), { request: p.requests[0] });
  assert.equal(wire.at(-1).headers["x-shared"], "parent-edited");
  assert.equal(wire.at(-1).headers["x-folder"], "folder-edited");
  assert.equal(wire.at(-1).headers.authorization, "Bearer fictional-a-new");
  const run = await call(route("run"), { planId: plan.id });
  assert.equal(run.status, "passed");
  assert.equal(wire.at(-1).headers["x-shared"], "project");
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  assert.equal(wire.at(-1).headers.authorization, "Bearer fictional-a-new");
  const mcp = createMCP({
    store: app.store,
    projects: [q.id],
    write: true,
    execute: true,
  });
  const invoke = (projectId) =>
    mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_execute_api",
        arguments: { projectId, apiId: q.requests[0].id },
      },
    });
  const mcpRun = await invoke(q.id);
  assert.equal(mcpRun.result.isError, undefined, JSON.stringify(mcpRun));
  assert.equal(wire.at(-1).headers.authorization, "Bearer fictional-b");
  assert.equal(wire.at(-1).headers["x-shared"], "project");
  const count = wire.length;
  const denied = await invoke(p.id);
  assert(denied.result.isError || denied.error);
  assert.equal(wire.length, count);
  const persisted = await app.store.get(p.id);
  assert(persisted.history.length >= 2);
  assert.equal(persisted.runs.length, 1);
  assert.throws(() => exportApipost(persisted), /plans|冻结/);
  const copy = restoreProject(persisted);
  await app.store.save(copy);
  const restarted = new Store(root);
  const restored = await restarted.get(copy.id);
  assert.deepEqual(
    restored.settings.nativeInheritance,
    persisted.settings.nativeInheritance,
  );
  assert.equal(restored.plans[0].steps[0].request.nativeInheritance, undefined);
  await call(`projects/${copy.id}/execute`, { request: restored.requests[0] });
  assert.equal(wire.at(-1).headers.authorization, "Bearer fictional-a-new");
  assert.equal(wire.at(-1).headers["x-shared"], "parent-edited");
  await call(`projects/${copy.id}/run`, { planId: restored.plans[0].id });
  assert.equal(wire.at(-1).headers["x-shared"], "project");
  assert.equal(
    (await restarted.get(q.id)).environments[0].variables.token,
    "fictional-b",
  );
});

test("invalid graph mutations and missing/forged bindings fail before storage or network; explicit noauth stays unauthenticated", async (t) => {
  const { wire, app, call, source } = await fixture(t);
  const initial = await app.store.create("A");
  const document = source("fictional");
  const original = structuredClone(document.apis[1]);
  document.apis.push({
    ...original,
    target_id: "no-auth",
    name: "No auth",
    request: { ...original.request, auth: { type: "noauth" } },
  });
  const p = await call(`projects/${initial.id}/import`, {
    document,
    inheritanceMode: "preserve",
  });
  const none = p.requests.find((r) => r.name === "No auth");
  await call(`projects/${p.id}/execute`, { request: none });
  assert.equal(wire.at(-1).headers.authorization, undefined);
  const count = wire.length;
  for (const change of [
    (x) => {
      delete x.settings.nativeInheritance;
      for (const r of x.requests) delete r.nativeInheritance;
    },
    (x) => {
      x.requests[0].folder = "Moved";
    },
    (x) => {
      x.requests.splice(0, 1);
      x.settings.nativeInheritance.bindings.splice(0, 1);
    },
    (x) => {
      x.settings.nativeInheritance.folders[0].parentId =
        x.settings.nativeInheritance.folders[0].sourceId;
    },
    (x) => {
      x.requests[0].nativeInheritance.sourceProjectId = "other";
    },
    (x) => {
      x.settings.globalAuth = { type: "bearer", token: "injected" };
    },
  ]) {
    const before = await app.store.get(p.id),
      draft = structuredClone(before);
    change(draft);
    await assert.rejects(app.store.save(draft), /继承图|绑定|目录/);
    assert.deepEqual(await app.store.get(p.id), before);
  }
  for (const change of [
    (r) => {
      delete r.nativeInheritance;
    },
    (r) => {
      r.authSnapshot =
        r.parametersSnapshot =
        r.serviceSnapshot =
        r.sharedScriptsSnapshot =
          true;
    },
    (r) => {
      r.nativeInheritance.sourceId = "other";
    },
  ]) {
    const request = structuredClone(p.requests[0]);
    change(request);
    await call(`projects/${p.id}/execute`, { request }, 400);
    await call(`projects/${p.id}/curl`, { request }, 400);
  }
  await assert.rejects(executeRequest(p.requests[0]), /继承图/);
  assert.throws(
    () => snapshotPlan({ steps: [{ request: p.requests[0] }] }),
    /绑定/,
  );
  assert.equal(wire.length, count);
  const broken = source("fictional");
  broken.apis[0].parent_id = "missing";
  const target = await app.store.create("Rejected");
  await call(
    `projects/${target.id}/import`,
    { document: broken, inheritanceMode: "preserve" },
    400,
  );
  assert.deepEqual(
    await app.store.get(target.id),
    await new Store(app.store.root).get(target.id),
  );
  assert.equal((await app.store.get(target.id)).requests.length, 0);
  assert.equal(wire.length, count);
});
