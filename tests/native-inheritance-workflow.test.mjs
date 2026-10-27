import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  let app = await createApp({ root, port: 0 });
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
  return {
    root,
    wire,
    app,
    call,
    source,
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
      return app;
    },
  };
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
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  for (const encode of [exportApipost, exportApipostDirectory]) {
    let generation = p;
    for (let i = 0; i < 2; i++) {
      const target = await app.store.create("Generation " + i);
      generation = await call(`projects/${target.id}/import`, {
        document: encode(generation),
        inheritanceMode: "preserve",
      });
      await call(`projects/${generation.id}/execute`, {
        request: generation.requests[0],
      });
      assert.equal(wire.at(-1).headers.authorization, "Bearer fictional-a");
      assert.equal(wire.at(-1).headers["x-shared"], "project");
      assert.equal(wire.at(-1).headers["x-folder"], "folder");
      assert.equal(
        new URL(wire.at(-1).url, "http://loopback").searchParams.get("false"),
        "false",
      );
    }
  }
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
  const unchangedTarget = await app.store.get(target.id);
  await call(
    `projects/${target.id}/import`,
    { document: broken, inheritanceMode: "preserve" },
    400,
  );
  assert.deepEqual(await app.store.get(target.id), unchangedTarget);
  assert.equal((await app.store.get(target.id)).requests.length, 0);
  assert.equal(wire.length, count);
});

test("absolute URL graph executes through official SDK HTTP and CLI frozen plans after owner server restart without reopening inheritance", async (t) => {
  const { root, wire, app, call, source, restart } = await fixture(t);
  const initial = await app.store.create("Absolute");
  const d = source("initial-token");
  d.apis[1].url = d.global.envs[0].server_list[0].uri + "/absolute";
  d.global.servers = [];
  d.global.envs[0].server_list = [];
  let p = await call(`projects/${initial.id}/import`, {
    document: d,
    inheritanceMode: "preserve",
  });
  assert.equal(p.requests[0].serviceId, "");
  const route = (name) => `projects/${p.id}/${name}`;
  await call(route("execute"), { request: p.requests[0] });
  assert.equal(wire.at(-1).url.startsWith("/absolute?"), true);
  const curl = await call(route("curl"), { request: p.requests[0] });
  assert.match(curl.curl, /Bearer initial-token/);
  const plan = await call(route("plans"), {
    name: "Frozen",
    environmentId: p.environments[0].id,
    steps: [{ request: p.requests[0] }],
  });
  const item = (
    await call(route("cases"), {
      name: "Case",
      sourceRequestId: p.requests[0].id,
      request: p.requests[0],
    })
  ).item;
  const editedCase = (
    await call(route("cases"), { ...item, name: "Edited case" })
  ).item;
  assert.equal(editedCase.request.nativeInheritance, undefined);
  p = await app.store.get(p.id);
  p.settings.nativeInheritance.projectLayer.headers[0].value = "live-parent";
  p.environments.push({
    ...structuredClone(p.environments[0]),
    id: "selected",
    name: "Other",
    variables: { ...p.environments[0].variables, token: "selected-token" },
  });
  p.currentEnvironmentId = "selected";
  await app.store.save(p);
  const flatTarget = await app.store.create("Default flatten control");
  const flat = await call(`projects/${flatTarget.id}/import`, { document: d });
  const conf = await call("mcp/config", {
    enabled: true,
    projects: [p.id, flat.id],
    write: true,
    execute: true,
    remember: false,
  });
  const client = new Client(
    { name: "inheritance-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(() => client.close().catch(() => {}));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + conf.token } },
    }),
  );
  const tool = (input) =>
    client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: p.id, apiId: p.requests[0].id, input },
    });
  const temporary = await tool({
    headers: { "X-Folder": "temporary-header" },
    auth: { token: "temporary-token" },
  });
  assert.notEqual(temporary.isError, true, temporary.content?.[0]?.text);
  assert.equal(wire.at(-1).headers.authorization, "Bearer temporary-token");
  assert.equal(wire.at(-1).headers["x-folder"], "temporary-header");
  const before = await app.store.get(p.id),
    count = wire.length;
  for (const input of [
    { nativeInheritance: p.requests[0].nativeInheritance },
    { inheritAuth: true },
    { authSnapshot: true },
    { headers: { "x-SHARED": "ambiguous-override" } },
  ]) {
    const denied = await tool(input);
    assert.equal(denied.isError, true);
    if (input.headers) assert.match(denied.content[0].text, /同名多行/);
  }
  assert.equal(wire.length, count);
  assert.deepEqual((await app.store.get(p.id)).requests, before.requests);
  assert.deepEqual(
    (await app.store.get(p.id)).settings.nativeInheritance,
    before.settings.nativeInheritance,
  );
  const forged = structuredClone(p.requests[0]);
  delete forged.nativeInheritance;
  for (const key of [
    "authSnapshot",
    "parametersSnapshot",
    "sharedScriptsSnapshot",
    "serviceSnapshot",
  ])
    forged[key] = true;
  const forgedPlan = await client.callTool({
    name: "localapi_save_plan",
    arguments: {
      projectId: p.id,
      plan: { name: "Forged", steps: [{ request: forged }] },
    },
  });
  assert.equal(forgedPlan.isError, true);
  assert.match(forgedPlan.content[0].text, /丢失绑定/);
  const nativeCall = (name, args) =>
    client.callTool({
      name: "apipost_" + name,
      arguments: { project_id: p.id, ...args },
    });
  const created = await nativeCall("create_execution_flow", {
    name: "Native frozen",
    steps: [
      {
        target_id: p.requests[0].id,
        input: { headers: { "X-Folder": "frozen-unique" } },
      },
    ],
  });
  assert.notEqual(created.isError, true, created.content?.[0]?.text);
  const nativeFlow = JSON.parse(created.content[0].text);
  const plansBefore = (await app.store.get(p.id)).plans;
  const rejectedCreate = await nativeCall("create_execution_flow", {
    name: "Rejected",
    steps: [
      {
        target_id: p.requests[0].id,
        input: { headers: { "x-shared": "ambiguous" } },
      },
    ],
  });
  assert.equal(rejectedCreate.isError, true);
  assert.match(rejectedCreate.content[0].text, /同名多行/);
  const rejectedUpdate = await nativeCall("update_execution_flow", {
    flow_id: nativeFlow.flow_id,
    steps: [
      {
        target_id: p.requests[0].id,
        step_id: plansBefore.find((plan) => plan.id === nativeFlow.flow_id)
          .steps[0].id,
        input: { headers: { "X-SHARED": "ambiguous" } },
      },
    ],
  });
  assert.equal(rejectedUpdate.isError, true);
  assert.match(rejectedUpdate.content[0].text, /同名多行/);
  assert.deepEqual((await app.store.get(p.id)).plans, plansBefore);
  assert.equal(wire.length, count);
  const oldContract = await client.callTool({
    name: "localapi_execute_api",
    arguments: {
      projectId: flat.id,
      apiId: flat.requests[0].id,
      environmentId: flat.environments.find((e) => e.name === "Imported").id,
      input: { headers: { "X-Shared": "legacy-override" } },
    },
  });
  assert.notEqual(oldContract.isError, true, oldContract.content?.[0]?.text);
  assert.equal(JSON.parse(oldContract.content[0].text).status, "passed");
  assert.equal(
    wire.at(-1).headers["x-shared"],
    "legacy-override, legacy-override",
  );
  assert.equal(
    (await app.store.get(flat.id)).settings.nativeInheritance,
    undefined,
  );
  await client.close();
  const restarted = await restart();
  const loaded = await restarted.store.get(p.id);
  await call(route("execute"), { request: loaded.requests[0] });
  assert.equal(wire.at(-1).headers.authorization, "Bearer selected-token");
  assert.equal(wire.at(-1).headers["x-shared"], "live-parent");
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        p.id,
        "--plan",
        plan.id,
        "--environment",
        "selected",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error("CLI fixture timeout"));
    }, 10000);
    child.once("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(output.code, 0, output.stderr);
  const run = JSON.parse(output.stdout);
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(wire.at(-1).headers.authorization, "Bearer selected-token");
  assert.equal(wire.at(-1).headers["x-shared"], "project");
  const after = await new Store(root).get(p.id);
  assert(after.runs.some((r) => r.id === run.id && r.source === "cli"));
  assert.equal(
    after.settings.nativeInheritance.projectLayer.headers[0].value,
    "live-parent",
  );
});
