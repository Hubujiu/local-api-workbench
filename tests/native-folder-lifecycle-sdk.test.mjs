import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

// Acceptance definitions only: each run uses a real loopback HTTP peer and the
// official MCP SDK. No mock execution, vendor runtime, network/quota widening.
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
const graph = (p) => p.settings.nativeInheritance;
const api = (p, sourceId = "api") =>
  p.requests.find((r) => r.nativeInheritance.sourceId === sourceId);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "folder-lifecycle-sdk-"));
  const wire = [];
  const peer = http
    .createServer((req, res) => {
      wire.push({ url: req.url, headers: req.headers });
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    })
    .listen(0, "127.0.0.1");
  let app;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    if (app) await close(app.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  });
  await once(peer, "listening");
  app = await createApp({ root, port: 0 });
  const call = async (route, body, status = 200, method = "POST", token) => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": token ?? app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const source = nativeInheritanceFixture();
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + peer.address().port;
  source.global.envs[0].env_var_list.token = {
    value: "fixture-token",
    current_value: "fixture-token",
  };
  source.apis[0].name = "A";
  source.apis[0].parent_id = "ancestor";
  source.apis[1].parent_id = "child";
  for (const [id, parent, name] of [
    ["ancestor", "0", "Ancestor"],
    ["child", "folder", "Child"],
    ["sibling", "ancestor", "AB"],
    ["empty", "0", "Empty"],
  ]) {
    source.apis.push({
      target_id: id,
      target_type: "folder",
      parent_id: parent,
      name,
      request: { auth: { type: "inherit" } },
    });
  }
  source.apis.push({
    ...structuredClone(source.apis[1]),
    target_id: "sibling-api",
    parent_id: "sibling",
    name: "Sibling",
  });
  const sourceBefore = structuredClone(source);
  const initial = await app.store.create("Folder lifecycle");
  const foreign = await app.store.create("Foreign untouched");
  await call(`projects/${initial.id}/import`, {
    document: source,
    inheritanceMode: "preserve",
  });
  assert.deepEqual(source, sourceBefore);
  async function connect(token) {
    const client = new Client(
      { name: "folder-lifecycle-acceptance", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    return client;
  }
  async function grant(projectId, write = true) {
    const config = await call("mcp/config", {
      enabled: true,
      projects: [projectId],
      write,
      execute: write,
      remember: false,
    });
    return { client: await connect(config.token), token: config.token };
  }
  return {
    root,
    wire,
    call,
    grant,
    connect,
    id: initial.id,
    foreign,
    get app() {
      return app;
    },
    async restart() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
async function tool(client, name, args, error = false) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError === true, error, result.content?.[0]?.text);
  return result;
}

for (const entry of ["owner", "native"])
  test(`${entry} folder lifecycle: real HTTP live/frozen isolation, backup restart regrant and full-batch restore`, async (t) => {
    const f = await fixture(t),
      { call, wire, id } = f;
    const route = (suffix, projectId = id) => `projects/${projectId}/${suffix}`;
    let p = await f.app.store.get(id);
    const originals = structuredClone(p.requests);
    const graphBefore = structuredClone(graph(p));
    const foreignBefore = await f.app.store.get(f.foreign.id);
    const savedCase = (
      await call(route("cases"), {
        name: "Frozen before folder recycle",
        sourceRequestId: api(p).id,
        request: api(p),
      })
    ).item;
    const savedPlan = await call(route("plans"), {
      name: "Frozen plan",
      environmentId: p.environments[0].id,
      steps: [{ request: api(p) }],
    });
    await call(route("execute"), { request: api(p) });
    assert.equal(wire.at(-1).headers["x-folder"], "folder");
    p = await f.app.store.get(id);
    const snapshots = Object.fromEntries(
      ["cases", "plans", "history", "runs"].map((key) => [
        key,
        structuredClone(p[key]),
      ]),
    );
    const start = wire.length;
    const { client, token } = await f.grant(id);
    const remove = async () => {
      if (entry === "owner")
        return call(route("native-inheritance-edit"), {
          configRevision: p.configRevision,
          operation: { type: "recycle-folder", sourceId: "folder" },
        });
      await tool(client, "apipost_delete_apis", {
        project_id: id,
        target_ids: ["folder:Ancestor/A"],
        confirm: true,
      });
      return f.app.store.get(id);
    };
    // Real owner endpoint rejects stale revisions and unauthenticated structural writes.
    for (const revision of [p.configRevision - 1, null]) {
      await call(
        route("native-inheritance-edit"),
        {
          configRevision: revision,
          operation: { type: "recycle-folder", sourceId: "folder" },
        },
        400,
      );
      assert.deepEqual(await f.app.store.get(id), p);
    }
    await call(
      route("native-inheritance-edit"),
      {
        configRevision: p.configRevision,
        operation: { type: "recycle-folder", sourceId: "folder" },
      },
      403,
      "POST",
      "wrong-owner",
    );
    assert.deepEqual(await f.app.store.get(id), p);
    p = await remove();
    assert.equal(wire.length, start, "folder recycle performs no peer I/O");
    assert.equal(p.configRevision > 0, true);
    assert.equal(typeof api(p).deletedAt, "string");
    assert.equal(api(p, "sibling-api").deletedAt, undefined);
    assert.deepEqual(graph(p).folders, graphBefore.folders);
    assert.deepEqual(graph(p).bindings, graphBefore.bindings);
    assert.deepEqual([...p.folders].sort(), [
      "Ancestor",
      "Ancestor/AB",
      "Empty",
    ]);
    for (const key of Object.keys(snapshots))
      assert.deepEqual(p[key], snapshots[key]);
    const batchId = graph(p).folderLifecycle.records[0].batchId;
    const trash = structuredClone(p.apiResourceTrash);
    assert.deepEqual(trash.batches[0].selectedTargetIds, ["folder:Ancestor/A"]);
    assert.deepEqual(trash.batches[0].requestIds, [api(p).id]);
    assert.equal(trash.batches[0].deletedAt, api(p).deletedAt);
    for (const name of ["localapi_list_apis", "apipost_list_apis"]) {
      const result = await tool(
        client,
        name,
        name.startsWith("apipost") ? { project_id: id } : { projectId: id },
      );
      assert(!JSON.stringify(result).includes(api(p).id));
      assert(JSON.stringify(result).includes(api(p, "sibling-api").id));
    }
    for (const [name, args] of [
      ["localapi_get_api_detail", { projectId: id, apiId: api(p).id }],
      ["apipost_get_api_detail", { project_id: id, target_id: api(p).id }],
      ["localapi_execute_api", { projectId: id, apiId: api(p).id }],
      ["apipost_execute_api", { project_id: id, target_id: api(p).id }],
    ])
      await tool(client, name, args, true);
    for (const request of [originals[0], { ...api(p), deletedAt: undefined }]) {
      await call(route("execute"), { request }, 400);
      await call(route("curl"), { request }, 400);
    }
    await call(
      route("native-inheritance-edit"),
      {
        configRevision: p.configRevision,
        operation: { type: "restore-requests", requestIds: [api(p).id] },
      },
      400,
    );
    assert.deepEqual(await f.app.store.get(id), p);
    assert.equal(
      wire.length,
      start,
      "all live refusal paths stop before peer I/O",
    );
    await call(route("execute"), { request: api(p, "sibling-api") });
    assert.equal(
      wire.length,
      start + 1,
      "same-prefix sibling remains executable",
    );
    await call(route("execute"), { request: savedCase.request });
    assert.equal(wire.at(-1).headers["x-folder"], "folder");
    assert.equal(wire.at(-1).headers.authorization, "Bearer fixture-token");
    const frozenRun = await call(route("run"), { planId: savedPlan.id });
    assert.equal(frozenRun.status, "passed");
    assert.equal(wire.at(-1).headers["x-folder"], "folder");
    p = await f.app.store.get(id);
    graph(p)
      .folders.find((node) => node.sourceId === "ancestor")
      .layer.headers.push({
        key: "X-Current-Ancestor",
        value: "changed",
        enabled: true,
      });
    p = await call(`projects/${id}`, p, 200, "PUT");
    const beforeBackupWire = wire.length;
    const backup = await call(
      route("export") + "?format=backup",
      undefined,
      200,
      "GET",
    );
    const restoredCopy = await call("restore", { document: backup }, 201);
    assert.deepEqual(restoredCopy.apiResourceTrash, trash);
    assert.deepEqual(restoredCopy.cases, snapshots.cases);
    assert.deepEqual(restoredCopy.plans, snapshots.plans);
    await f.restart();
    assert.equal(wire.length, beforeBackupWire);
    await assert.rejects(
      f.connect(token),
      "ephemeral pre-restart grant cannot authorize the restored project",
    );
    let disk = await new Store(f.root).get(restoredCopy.id);
    assert.deepEqual(disk.apiResourceTrash, trash);
    assert.deepEqual(graph(disk), graph(restoredCopy));
    const granted = await f.grant(restoredCopy.id);
    await tool(
      granted.client,
      "localapi_execute_api",
      { projectId: restoredCopy.id, apiId: api(disk).id },
      true,
    );
    await tool(
      granted.client,
      "localapi_execute_api",
      { projectId: id, apiId: api(disk).id },
      true,
    );
    assert.equal(wire.length, beforeBackupWire);
    await tool(granted.client, "localapi_run_plan", {
      projectId: restoredCopy.id,
      planId: savedPlan.id,
    });
    assert.equal(wire.at(-1).headers["x-current-ancestor"], undefined);
    disk = await f.app.store.get(restoredCopy.id);
    const operation = { type: "restore-folder", batchId };
    await call(
      route("native-inheritance-edit", restoredCopy.id),
      { configRevision: disk.configRevision - 1, operation },
      400,
    );
    assert.deepEqual(await f.app.store.get(restoredCopy.id), disk);
    const beforeRestoreWire = wire.length;
    disk = await call(route("native-inheritance-edit", restoredCopy.id), {
      configRevision: disk.configRevision,
      operation,
    });
    assert.equal(wire.length, beforeRestoreWire);
    assert.equal(Object.hasOwn(api(disk), "deletedAt"), false);
    assert.deepEqual(disk.apiResourceTrash, trash);
    assert.equal(graph(disk).folderLifecycle.records[0].state, "restored");
    assert.deepEqual(disk.cases, snapshots.cases);
    assert.deepEqual(disk.plans, snapshots.plans);
    await tool(granted.client, "localapi_execute_api", {
      projectId: restoredCopy.id,
      apiId: api(disk).id,
    });
    assert.equal(wire.at(-1).headers["x-current-ancestor"], "changed");
    await tool(granted.client, "localapi_run_plan", {
      projectId: restoredCopy.id,
      planId: savedPlan.id,
    });
    assert.equal(wire.at(-1).headers["x-current-ancestor"], undefined);
    for (const format of ["apipost", "apipost-directory"])
      await call(
        route("export", restoredCopy.id) + "?format=" + format,
        undefined,
        400,
        "GET",
      );
    disk = await f.app.store.get(restoredCopy.id);
    disk = await call(route("native-inheritance-edit", restoredCopy.id), {
      configRevision: disk.configRevision,
      operation: { type: "recycle-folder", sourceId: "folder" },
    });
    assert.equal(disk.apiResourceTrash.batches.length, 2);
    assert.deepEqual(disk.apiResourceTrash.batches[0], trash.batches[0]);
    assert.deepEqual(
      graph(disk).folderLifecycle.records.map((r) => r.state),
      ["restored", "recycled"],
    );
    assert.equal(
      graph(await f.app.store.get(id)).folderLifecycle.records[0].state,
      "recycled",
      "backup copy never restores source",
    );
    assert.deepEqual(await f.app.store.get(f.foreign.id), foreignBefore);
  });

test("native SDK folder selection requires confirm/write/scope and empty folders retain history", async (t) => {
  const f = await fixture(t),
    { call, id, wire } = f;
  let p = await f.app.store.get(id);
  const foreignBefore = await f.app.store.get(f.foreign.id);
  const writer = await f.grant(id);
  for (const args of [
    { project_id: id, target_ids: ["folder:Ancestor/A"], confirm: false },
    { project_id: id, target_ids: ["folder:Ancestor/A"] },
    {
      project_id: id,
      target_ids: ["folder:Ancestor/A", api(p).id],
      confirm: true,
    },
    {
      project_id: id,
      target_ids: ["folder:Ancestor/A", "folder:Empty"],
      confirm: true,
    },
    {
      project_id: id,
      target_ids: ["folder:Ancestor/A", "folder:Ancestor/A"],
      confirm: true,
    },
    { project_id: id, target_ids: ["folder:missing"], confirm: true },
    {
      project_id: f.foreign.id,
      target_ids: ["folder:Ancestor/A"],
      confirm: true,
    },
  ]) {
    await tool(writer.client, "apipost_delete_apis", args, true);
    assert.deepEqual(await f.app.store.get(id), p);
    assert.deepEqual(await f.app.store.get(f.foreign.id), foreignBefore);
  }
  await writer.client.close();
  const reader = await f.grant(id, false);
  await tool(
    reader.client,
    "apipost_delete_apis",
    { project_id: id, target_ids: ["folder:Empty"], confirm: true },
    true,
  );
  assert.deepEqual(await f.app.store.get(id), p);
  await reader.client.close();
  const writable = await f.grant(id);
  await tool(writable.client, "apipost_delete_apis", {
    project_id: id,
    target_ids: ["folder:Empty"],
    confirm: true,
  });
  const next = await f.app.store.get(id);
  assert.deepEqual(next.requests, p.requests);
  assert(!next.folders.includes("Empty"));
  assert.deepEqual(next.apiResourceTrash.batches[0].requestIds, []);
  assert.deepEqual(next.apiResourceTrash.batches[0].folderPaths, ["Empty"]);
  for (const format of ["apipost", "apipost-directory"])
    await call(`projects/${id}/export?format=${format}`, undefined, 400, "GET");
  const batchId = graph(next).folderLifecycle.records[0].batchId;
  p = await call(`projects/${id}/native-inheritance-edit`, {
    configRevision: next.configRevision,
    operation: { type: "restore-folder", batchId },
  });
  assert(p.folders.includes("Empty"));
  assert.deepEqual(p.apiResourceTrash, next.apiResourceTrash);
  assert.equal(graph(p).folderLifecycle.records[0].state, "restored");
  for (const format of ["apipost", "apipost-directory"])
    await call(`projects/${id}/export?format=${format}`, undefined, 400, "GET");
  assert.equal(
    wire.length,
    0,
    "selection/empty lifecycle and export refusals never execute HTTP",
  );
  assert.deepEqual(await f.app.store.get(f.foreign.id), foreignBefore);
});

test("owner PUT preserves sparse inactive HTTP exactly and rejects raw changes before normalization", async (t) => {
  const f = await fixture(t),
    { call, id, wire } = f;
  let p = await f.app.store.get(id);
  // Store.save accepts these omitted ordinary defaults in an otherwise valid
  // bound HTTP definition. This represents persisted legacy sparse state, not
  // an invalid graph or a request constructed outside the native importer.
  for (const key of ["schema", "proxy", "timeout"]) delete api(p)[key];
  await f.app.store.save(p);
  p = await new Store(f.root).get(id);
  for (const key of ["schema", "proxy", "timeout"])
    assert.equal(Object.hasOwn(api(p), key), false);
  const sparse = structuredClone(api(p));
  p = await call(`projects/${id}/native-inheritance-edit`, {
    configRevision: p.configRevision,
    operation: { type: "recycle-folder", sourceId: "folder" },
  });
  assert.deepEqual(api(p), { ...sparse, deletedAt: api(p).deletedAt });
  const inactive = structuredClone(api(p));
  const ancestorEdit = structuredClone(p);
  graph(ancestorEdit)
    .folders.find((node) => node.sourceId === "ancestor")
    .layer.headers.push({
      key: "X-Active-Ancestor",
      value: "editable-during-recycle",
      enabled: true,
    });
  p = await call(`projects/${id}`, ancestorEdit, 200, "PUT");
  assert.deepEqual(
    api(p),
    inactive,
    "ordinary PUT must not inject defaults into an unchanged pending HTTP",
  );
  const disk = await new Store(f.root).get(id);
  assert.deepEqual(
    api(disk),
    inactive,
    "persisted inactive definition remains byte-shape equivalent",
  );
  assert(
    graph(disk)
      .folders.find((node) => node.sourceId === "ancestor")
      .layer.headers.some(
        (row) =>
          row.key === "X-Active-Ancestor" &&
          row.value === "editable-during-recycle",
      ),
  );
  for (const [label, mutate] of [
    [
      "unknown property normally dropped by normalization",
      (request) => {
        request.pendingUnknownField =
          "must-not-disappear-before-identity-check";
      },
    ],
    [
      "missing schema default added",
      (request) => {
        request.schema = {};
      },
    ],
    [
      "missing proxy default added",
      (request) => {
        request.proxy = "";
      },
    ],
    [
      "missing timeout default added",
      (request) => {
        request.timeout = 15000;
      },
    ],
    [
      "existing real URL changed",
      (request) => {
        request.url = "/tampered-pending";
      },
    ],
    [
      "existing own header changed",
      (request) => {
        request.headers[0].value = "tampered-pending";
      },
    ],
  ]) {
    const changed = structuredClone(disk);
    mutate(api(changed));
    await call(`projects/${id}`, changed, 400, "PUT");
    assert.deepEqual(
      await f.app.store.get(id),
      disk,
      label + ": cache unchanged",
    );
    assert.deepEqual(
      await new Store(f.root).get(id),
      disk,
      label + ": disk and revision unchanged",
    );
  }
  assert.equal(
    wire.length,
    0,
    "sparse lifecycle and PUT checks do not execute the peer",
  );
});
