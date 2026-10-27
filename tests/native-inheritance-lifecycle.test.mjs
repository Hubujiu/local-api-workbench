import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

test("owner atomically renames a preserved folder without changing its source identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-graph-edit-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => {
      app.server.close(r);
      app.server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("graph");
  importIntoProject(p, nativeInheritanceFixture(), {
    inheritanceMode: "preserve",
  });
  await app.store.save(p);
  const before = await app.store.get(p.id),
    f = before.settings.nativeInheritance.folders[0];
  const res = await fetch(
    app.url + "/api/projects/" + p.id + "/native-inheritance-edit",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify({
        configRevision: before.configRevision,
        operation: {
          type: "move-folder",
          sourceId: f.sourceId,
          parentId: "0",
          name: "Renamed",
        },
      }),
    },
  );
  const result = await res.json();
  assert.equal(res.status, 200, JSON.stringify(result));
  assert.equal(
    result.settings.nativeInheritance.folders[0].sourceId,
    f.sourceId,
  );
  assert.equal(result.settings.nativeInheritance.folders[0].path, "Renamed");
  assert.equal(result.requests[0].folder, "Renamed");
});

import http from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/runtime.mjs";
import { moveFolderTree } from "../public/folder-tree.js";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { exportApipost } from "../src/apipost-export.mjs";

const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
async function graphFixture(t, two = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-lifecycle-")),
    wire = [];
  const peer = http
    .createServer((req, res) => {
      wire.push({ url: req.url, headers: req.headers });
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    })
    .listen(0, "127.0.0.1");
  await once(peer, "listening");
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await close(app.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, data, status = 200, method = "POST", token) => {
    const r = await fetch(app.url + "/api/" + route, {
      method,
      headers: {
        "x-local-token": token ?? app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const b = await r.json();
    assert.equal(r.status, status, JSON.stringify(b));
    return b;
  };
  const source = nativeInheritanceFixture();
  source.global.envs[0].server_list[0].uri =
    "http://127.0.0.1:" + peer.address().port;
  source.global.envs[0].env_var_list.token = {
    value: "fixture-token",
    current_value: "fixture-token",
  };
  const folder = source.apis[0];
  folder.name = "A";
  source.apis.push({
    ...structuredClone(folder),
    target_id: "child",
    parent_id: "folder",
    name: "Child",
    request: { auth: { type: "inherit" } },
  });
  source.apis.push({
    ...structuredClone(folder),
    target_id: "other",
    name: "B",
    request: {
      auth: { type: "noauth" },
      header: {
        parameter: [{ key: "X-Folder", value: "other", is_checked: 1 }],
      },
    },
  });
  source.apis[1].parent_id = "child";
  if (two)
    source.apis.push({
      ...structuredClone(source.apis[1]),
      target_id: "second-api",
      name: "Second",
    });
  const a = await app.store.create("Graph"),
    b = await app.store.create("Other");
  await call(`projects/${a.id}/import`, {
    document: source,
    inheritanceMode: "preserve",
  });
  return {
    root,
    wire,
    call,
    source,
    id: a.id,
    other: b,
    get app() {
      return app;
    },
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}

test("owner graph subtree/API moves preserve frozen cases, plans and history; live parent changes, two-format two-generation export and real restart remain isolated", async (t) => {
  const f = await graphFixture(t),
    { call, id, wire } = f,
    route = (x) => `projects/${id}/${x}`;
  let p = await f.app.store.get(id);
  const apiId = p.requests[0].id;
  await call(route("execute"), { request: p.requests[0] });
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  assert.equal(wire.at(-1).headers.authorization, "Bearer fixture-token");
  const plan = await call(route("plans"), {
    name: "Frozen before moves",
    steps: [{ request: p.requests[0] }],
    environmentId: p.environments[0].id,
  });
  const savedCase = await call(route("cases"), {
    name: "Frozen case",
    sourceRequestId: apiId,
    request: p.requests[0],
  });
  p = await f.app.store.get(id);
  const frozen = {
    cases: structuredClone(p.cases),
    plans: structuredClone(p.plans),
    history: structuredClone(p.history),
  };
  const sourceId = p.settings.nativeInheritance.sourceProjectId;
  const bindings = p.requests.map((r) => structuredClone(r.nativeInheritance));
  for (const operation of [
    { type: "move-folder", sourceId: "folder", parentId: "0", name: "Renamed" },
    {
      type: "move-folder",
      sourceId: "child",
      parentId: "other",
      name: "Nested",
    },
    { type: "move-request", requestId: apiId, parentId: "folder" },
    { type: "move-request", requestId: apiId, parentId: "other" },
  ]) {
    p = await call(route("native-inheritance-edit"), {
      configRevision: p.configRevision,
      operation,
    });
    for (const key of Object.keys(frozen))
      assert.deepEqual(p[key], frozen[key]);
    assert.equal(p.settings.nativeInheritance.sourceProjectId, sourceId);
    assert.deepEqual(
      p.requests.map((r) => r.nativeInheritance),
      bindings,
    );
  }
  assert.equal(p.requests[0].folder, "B");
  assert.deepEqual(p.folders, ["Renamed", "B/Nested", "B"]);
  await call(route("execute"), { request: p.requests[0] });
  assert.equal(wire.at(-1).headers["x-folder"], "other");
  assert.equal(wire.at(-1).headers.authorization, undefined);
  await call(route("execute"), { request: savedCase.item.request });
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  assert.equal(wire.at(-1).headers.authorization, "Bearer fixture-token");
  await call(route("run"), { planId: plan.id });
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  p = await f.app.store.get(id);
  // Cases have no native representation here. Refuse the full project rather
  // than silently dropping them; definition-only sibling is an explicit copy.
  for (const format of ["apipost", "apipost-directory"])
    await call(route("export") + "?format=" + format, undefined, 400, "GET");
  const planOnly = structuredClone(p);
  planOnly.cases = [];
  assert.equal(planOnly.plans[0].steps[0].request.folder, "A/Child");
  assert.throws(() => exportApipostDirectory(planOnly), /目录|folder/);
  assert.deepEqual(planOnly.plans, p.plans);
  const definitions = structuredClone(p);
  definitions.cases = [];
  definitions.plans = [];
  definitions.history = [];
  definitions.runs = [];
  // Explicit definition-only backup copy; the source with snapshots stays intact.
  const definitionRestore = await call(
    "restore",
    {
      document: { ...definitions, version: 1 },
    },
    201,
  );
  for (const format of ["apipost", "apipost-directory"]) {
    let generation = definitionRestore;
    const networkBefore = wire.length;
    for (let i = 0; i < 2; i++) {
      const encoded = await call(
        `projects/${generation.id}/export?format=${format}`,
        undefined,
        200,
        "GET",
      );
      const target = await f.app.store.create("Generation");
      generation = await call(`projects/${target.id}/import`, {
        document: encoded,
        inheritanceMode: "preserve",
      });
      assert.deepEqual([...generation.folders].sort(), [...p.folders].sort());
      assert.equal(generation.requests[0].folder, "B");
    }
    assert.equal(wire.length, networkBefore);
    await call(`projects/${generation.id}/execute`, {
      request: generation.requests[0],
    });
    assert.equal(wire.at(-1).headers["x-folder"], "other");
  }
  const backup = await call(
    route("export") + "?format=backup",
    undefined,
    200,
    "GET",
  );
  const restored = await call("restore", { document: backup }, 201);
  const count = wire.length;
  await f.restart();
  assert.equal(wire.length, count);
  await call(`projects/${restored.id}/execute`, {
    request: restored.requests[0],
  });
  assert.equal(wire.at(-1).headers["x-folder"], "other");
  await call(`projects/${restored.id}/run`, { planId: plan.id });
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  const disk = await new Store(f.root).get(restored.id);
  assert.deepEqual(disk.plans, frozen.plans);
  assert.deepEqual(disk.cases, frozen.cases);
  assert.deepEqual((await f.app.store.get(f.other.id)).requests, []);
});

test("graph edits reject stale/ambiguous/cyclic/cross-project and inherited-form changes atomically; ordinary saves cannot bypass identity", async (t) => {
  const f = await graphFixture(t),
    { call, id } = f,
    route = `projects/${id}/native-inheritance-edit`;
  const p = await f.app.store.get(id),
    apiId = p.requests[0].id;
  const invalid = [
    {},
    { operation: { type: "move-request", requestId: apiId, parentId: "0" } },
    {
      configRevision: p.configRevision - 1,
      operation: { type: "move-request", requestId: apiId, parentId: "0" },
    },
    {
      configRevision: null,
      operation: { type: "move-request", requestId: apiId, parentId: "0" },
    },
    {
      configRevision: p.configRevision,
      operation: {
        type: "move-folder",
        sourceId: "folder",
        parentId: "child",
        name: "Cycle",
      },
    },
    {
      configRevision: p.configRevision,
      operation: {
        type: "move-folder",
        sourceId: "folder",
        parentId: "0",
        name: "B",
      },
    },
    {
      configRevision: p.configRevision,
      operation: {
        type: "move-folder",
        sourceId: "folder",
        parentId: "missing",
        name: "A",
      },
    },
    {
      configRevision: p.configRevision,
      operation: {
        type: "move-folder",
        sourceId: "folder",
        parentId: "0",
        name: "bad/name",
      },
    },
    {
      configRevision: p.configRevision,
      operation: {
        type: "move-request",
        requestId: apiId,
        parentId: "missing",
      },
    },
    {
      configRevision: p.configRevision,
      operation: { type: "move-request", requestId: f.other.id, parentId: "0" },
    },
    {
      configRevision: p.configRevision,
      operation: { type: "delete", requestId: apiId, parentId: "0" },
    },
    {
      configRevision: p.configRevision,
      operation: {
        type: "move-request",
        requestId: apiId,
        parentId: "0",
        skip: true,
      },
    },
    {
      configRevision: p.configRevision,
      operation: { type: "move-request", requestId: apiId, parentId: "0" },
      nativeInheritanceEdit: true,
    },
  ];
  for (const input of invalid) {
    await call(route, input, 400);
    assert.deepEqual(await f.app.store.get(id), p);
  }
  await call(route + "?skip=true", invalid[0], 400);
  await call(
    route,
    {
      configRevision: p.configRevision,
      operation: { type: "move-request", requestId: apiId, parentId: "0" },
    },
    403,
    "POST",
    "wrong-owner",
  );
  const generic = moveFolderTree(p, "A", "Untrusted");
  await call(`projects/${id}`, generic, 400, "PUT");
  for (const edit of [
    (q) => {
      q.requests[0].folder = "B";
    },
    (q) => {
      q.requests[0].deletedAt = new Date().toISOString();
    },
    (q) => {
      delete q.requests[0].nativeInheritance;
    },
    (q) => {
      delete q.settings.nativeInheritance;
    },
  ]) {
    const q = structuredClone(p);
    edit(q);
    await assert.rejects(f.app.store.save(q));
  }
  assert.deepEqual(await f.app.store.get(id), p);
  assert.equal(f.wire.length, 0);
  // Same revision races: exactly one allowed structure write; no stale replay.
  const op = {
    configRevision: p.configRevision,
    operation: { type: "move-request", requestId: apiId, parentId: "other" },
  };
  const settled = await Promise.allSettled([
    f.app.store.editNativeInheritance(id, op),
    f.app.store.editNativeInheritance(id, op),
  ]);
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(settled.filter((r) => r.status === "rejected").length, 1);
  let current = await f.app.store.get(id);
  // Populate an otherwise unused parent with a supported POST-only form. A GET
  // cannot be moved under it; validation checks the resulting effective layers.
  current.settings.nativeInheritance.folders.find(
    (x) => x.sourceId === "child",
  ).layer.form = [{ key: "form", value: "x", enabled: true }];
  await f.app.store.save(current);
  current = await f.app.store.get(id);
  await call(
    route,
    {
      configRevision: current.configRevision,
      operation: { type: "move-request", requestId: apiId, parentId: "child" },
    },
    400,
  );
  assert.deepEqual(await f.app.store.get(id), current);
  assert.equal(f.wire.length, 0);
  assert.deepEqual((await f.app.store.get(f.other.id)).requests, []);
});

test("official SDK respects moved live graph and unchanged saved plan without gaining structural or cross-project authority", async (t) => {
  const f = await graphFixture(t),
    { call, id, wire } = f;
  let p = await f.app.store.get(id);
  const plan = await call(`projects/${id}/plans`, {
    name: "SDK frozen",
    steps: [{ request: p.requests[0] }],
    environmentId: p.environments[0].id,
  });
  p = await f.app.store.get(id);
  p = await call(`projects/${id}/native-inheritance-edit`, {
    configRevision: p.configRevision,
    operation: {
      type: "move-request",
      requestId: p.requests[0].id,
      parentId: "other",
    },
  });
  // API-only reparent leaves the old folder available: the independent
  // directory flow can still encode its old frozen context without recreating it.
  const countBeforeExport = wire.length;
  const encoded = exportApipostDirectory(p);
  const migratedTarget = await f.app.store.create("Moved API flow migration");
  const migrated = await call(`projects/${migratedTarget.id}/import`, {
    document: encoded,
    inheritanceMode: "preserve",
  });
  assert.equal(wire.length, countBeforeExport);
  assert.equal(migrated.requests[0].folder, "B");
  assert.equal(migrated.plans[0].steps[0].request.folder, "A/Child");
  await call(`projects/${migrated.id}/run`, { planId: migrated.plans[0].id });
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  const conf = await call("mcp/config", {
    enabled: true,
    projects: [id],
    write: true,
    execute: true,
    remember: false,
  });
  const client = new Client(
    { name: "graph-move-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(() => client.close().catch(() => {}));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + conf.token } },
    }),
  );
  const execute = await client.callTool({
    name: "localapi_execute_api",
    arguments: { projectId: id, apiId: p.requests[0].id },
  });
  assert.notEqual(execute.isError, true, execute.content?.[0]?.text);
  assert.equal(wire.at(-1).headers["x-folder"], "other");
  assert.equal(wire.at(-1).headers.authorization, undefined);
  const run = await client.callTool({
    name: "localapi_run_plan",
    arguments: { projectId: id, planId: plan.id },
  });
  assert.notEqual(run.isError, true, run.content?.[0]?.text);
  assert.equal(wire.at(-1).headers["x-folder"], "folder");
  const count = wire.length;
  for (const [name, args] of [
    [
      "localapi_execute_api",
      { projectId: f.other.id, apiId: p.requests[0].id },
    ],
    [
      "localapi_execute_api",
      {
        projectId: id,
        apiId: p.requests[0].id,
        input: {
          nativeInheritanceEdit: { type: "move-request", parentId: "0" },
        },
      },
    ],
  ]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true);
  }
  const tools = await client.listTools();
  assert(!tools.tools.some((tool) => /inheritance.*edit/.test(tool.name)));
  assert.equal(wire.length, count);
  assert.equal((await f.app.store.get(id)).requests[0].folder, "B");
  const readConfig = await call("mcp/config", {
    enabled: true,
    projects: [id],
    write: false,
    execute: false,
    remember: false,
  });
  await client.close();
  const reader = new Client(
    { name: "graph-reader", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(() => reader.close().catch(() => {}));
  await reader.connect(
    new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + readConfig.token } },
    }),
  );
  const denied = await reader.callTool({
    name: "localapi_execute_api",
    arguments: { projectId: id, apiId: p.requests[0].id },
  });
  const noWrite = await reader.callTool({
    name: "localapi_save_plan",
    arguments: {
      projectId: id,
      plan: { name: "Denied", steps: [{ request: p.requests[0] }] },
    },
  });
  assert.equal(noWrite.isError, true);
  assert.equal(denied.isError, true);
  assert.equal(wire.length, count);
});

test("owner recycles and restores a bound API without deleting graph identity or frozen evidence", async (t) => {
  const f = await graphFixture(t),
    p = await f.app.store.get(f.id),
    api = p.requests[0];
  const next = await f.call(`projects/${p.id}/native-inheritance-edit`, {
    configRevision: p.configRevision,
    operation: { type: "recycle-requests", requestIds: [api.id] },
  });
  assert.equal(typeof next.requests[0].deletedAt, "string");
  assert.deepEqual(
    next.settings.nativeInheritance,
    p.settings.nativeInheritance,
  );
  const restored = await f.call(`projects/${p.id}/native-inheritance-edit`, {
    configRevision: next.configRevision,
    operation: { type: "restore-requests", requestIds: [api.id] },
  });
  assert.equal(Object.hasOwn(restored.requests[0], "deletedAt"), false);
});

for (const entry of ["owner", "canonical", "native"])
  test(`${entry} bound HTTP recycle batch → live refusal / frozen execution → backup restart → restore current parent, retaining native trash history`, async (t) => {
    const f = await graphFixture(t, true),
      { call, id, wire } = f,
      route = (x) => `projects/${id}/${x}`;
    let p = await f.app.store.get(id);
    const originals = structuredClone(p.requests),
      ids = originals.map((r) => r.id);
    const plan = await call(route("plans"), {
      name: "Before recycle",
      environmentId: p.environments[0].id,
      steps: [{ request: originals[0] }],
    });
    const item = (
      await call(route("cases"), {
        name: "Before recycle",
        sourceRequestId: ids[0],
        request: originals[0],
      })
    ).item;
    await call(route("execute"), { request: originals[0] });
    p = await f.app.store.get(id);
    const frozen = {
      plans: structuredClone(p.plans),
      cases: structuredClone(p.cases),
      history: structuredClone(p.history),
    };
    const conf = await call("mcp/config", {
      enabled: true,
      projects: [id],
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "graph-trash-" + entry, version: "1.0.0" },
      { capabilities: {} },
    );
    t.after(() => client.close().catch(() => {}));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + conf.token } },
      }),
    );
    const remove = async (selected, ok = true, confirm = true) => {
      const before = await f.app.store.get(id);
      if (entry === "owner")
        return call(
          route("native-inheritance-edit"),
          {
            configRevision: before.configRevision,
            operation: { type: "recycle-requests", requestIds: selected },
          },
          ok ? 200 : 400,
        );
      const r = await client.callTool({
        name:
          entry === "native" ? "apipost_delete_apis" : "localapi_delete_apis",
        arguments:
          entry === "native"
            ? { project_id: id, target_ids: selected, confirm }
            : { projectId: id, apiIds: selected, confirm },
      });
      assert.equal(r.isError === true, !ok, r.content?.[0]?.text);
      return f.app.store.get(id);
    };
    const startCount = wire.length;
    for (const selected of [
      [ids[0], "missing"],
      [ids[0], "folder:A"],
      [ids[0], ids[0]],
      [f.other.id],
      [],
    ]) {
      const before = await f.app.store.get(id);
      await remove(selected, false);
      assert.deepEqual(await f.app.store.get(id), before);
    }
    if (entry !== "owner") {
      await remove(ids, false, false);
      assert.deepEqual(await f.app.store.get(id), p);
    }
    p = await remove(ids);
    assert.equal(wire.length, startCount);
    assert(p.requests.every((r) => typeof r.deletedAt === "string"));
    assert.equal(new Set(p.requests.map((r) => r.deletedAt)).size, 1);
    assert.deepEqual(
      p.settings.nativeInheritance,
      (await f.app.store.get(id)).settings.nativeInheritance,
    );
    for (const key of Object.keys(frozen))
      assert.deepEqual(p[key], frozen[key]);
    const trash = structuredClone(p.apiResourceTrash);
    if (entry === "native") {
      assert.equal(trash.batches.length, 1);
      assert.deepEqual(trash.batches[0].requestIds, ids);
      assert.deepEqual(trash.batches[0].folderPaths, []);
      assert.deepEqual(trash.batches[0].documents, []);
      assert.equal(trash.batches[0].deletedAt, p.requests[0].deletedAt);
    } else assert.equal(trash, undefined);
    await remove(ids, false);
    for (const name of ["localapi_list_apis", "apipost_list_apis"]) {
      const native = name.startsWith("apipost");
      const result = await client.callTool({
        name,
        arguments: native ? { project_id: id } : { projectId: id },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      for (const apiId of ids) assert(!JSON.stringify(result).includes(apiId));
    }
    for (const [name, args] of [
      ["localapi_get_api_detail", { projectId: id, apiId: ids[0] }],
      ["apipost_get_api_detail", { project_id: id, target_id: ids[0] }],
      ["localapi_execute_api", { projectId: id, apiId: ids[0] }],
      ["apipost_execute_api", { project_id: id, target_id: ids[0] }],
    ]) {
      const r = await client.callTool({ name, arguments: args });
      assert.equal(r.isError, true);
    }
    for (const request of [
      originals[0],
      { ...p.requests[0], deletedAt: undefined },
    ]) {
      await call(route("execute"), { request }, 400);
      await call(route("curl"), { request }, 400);
    }
    const forged = structuredClone(originals[0]);
    delete forged.nativeInheritance;
    for (const key of [
      "authSnapshot",
      "parametersSnapshot",
      "serviceSnapshot",
      "sharedScriptsSnapshot",
    ])
      forged[key] = true;
    await call(route("execute"), { request: forged }, 400);
    assert.equal(wire.length, startCount);
    for (const format of ["apipost", "apipost-directory"]) {
      const r = await call(
        route("export") + "?format=" + format,
        undefined,
        400,
        "GET",
      );
      assert.match(r.error, /回收/);
    }
    // Both plain PUT state flips and malformed backups are rejected, not silently
    // treated as new active resources. Reordering alone remains ordinary editing.
    const beforeInvalid = await f.app.store.get(id);
    for (const date of [undefined, "", false, "not-a-date", "2026-10-27"]) {
      const changed = structuredClone(beforeInvalid);
      if (date === undefined) delete changed.requests[0].deletedAt;
      else changed.requests[0].deletedAt = date;
      await call(`projects/${id}`, changed, 400, "PUT");
      if (date !== undefined)
        await call("restore", { document: { ...changed, version: 1 } }, 400);
      assert.deepEqual(await f.app.store.get(id), beforeInvalid);
    }
    const reverse = structuredClone(beforeInvalid);
    reverse.requests.reverse();
    await f.app.store.save(reverse);
    p = await f.app.store.get(id);
    assert.deepEqual(
      p.requests.map((r) => r.id),
      [...ids].reverse(),
    );
    await call(
      route("native-inheritance-edit"),
      {
        configRevision: p.configRevision,
        operation: {
          type: "move-request",
          requestId: ids[0],
          parentId: "other",
        },
      },
      400,
    );
    p = await call(route("native-inheritance-edit"), {
      configRevision: p.configRevision,
      operation: {
        type: "move-folder",
        sourceId: "folder",
        parentId: "0",
        name: "RecycledParent",
      },
    });
    assert(
      p.requests.every(
        (r) => r.folder === "RecycledParent/Child" && r.deletedAt,
      ),
    );
    p.settings.nativeInheritance.folders.find(
      (x) => x.sourceId === "folder",
    ).layer.headers[0].value = "changed-while-recycled";
    p.settings.nativeInheritance.folders.find(
      (x) => x.sourceId === "folder",
    ).layer.auth = { mode: "none" };
    await f.app.store.save(p);
    p = await f.app.store.get(id);
    await call(route("execute"), { request: item.request });
    assert.equal(wire.at(-1).headers["x-folder"], "folder");
    assert.equal(wire.at(-1).headers.authorization, "Bearer fixture-token");
    const savedRun = await call(route("run"), { planId: plan.id });
    assert.equal(savedRun.status, "passed");
    assert.equal(wire.at(-1).headers["x-folder"], "folder");
    const backup = await call(
      route("export") + "?format=backup",
      undefined,
      200,
      "GET",
    );
    const restored = await call("restore", { document: backup }, 201);
    assert.deepEqual(restored.apiResourceTrash, trash);
    assert.deepEqual(restored.plans, frozen.plans);
    assert.deepEqual(restored.cases, frozen.cases);
    assert(restored.requests.every((r) => r.deletedAt));
    await client.close();
    const networkBeforeRestart = wire.length;
    await f.restart();
    assert.equal(wire.length, networkBeforeRestart);
    let disk = await new Store(f.root).get(restored.id);
    assert.deepEqual(
      disk.settings.nativeInheritance,
      p.settings.nativeInheritance,
    );
    assert.deepEqual(disk.apiResourceTrash, trash);
    await call(
      `projects/${restored.id}/execute`,
      { request: originals[0] },
      400,
    );
    assert.equal(wire.length, networkBeforeRestart);
    const restoreOperation = { type: "restore-requests", requestIds: ids };
    await call(
      `projects/${restored.id}/native-inheritance-edit`,
      { configRevision: disk.configRevision - 1, operation: restoreOperation },
      400,
    );
    await call(
      `projects/${restored.id}/native-inheritance-edit`,
      {
        configRevision: disk.configRevision,
        operation: { ...restoreOperation, deletedAt: "forged" },
      },
      400,
    );
    disk = await call(`projects/${restored.id}/native-inheritance-edit`, {
      configRevision: disk.configRevision,
      operation: restoreOperation,
    });
    assert(disk.requests.every((r) => !Object.hasOwn(r, "deletedAt")));
    assert.deepEqual(disk.apiResourceTrash, trash);
    assert.deepEqual(disk.plans, frozen.plans);
    assert.deepEqual(disk.cases, frozen.cases);
    const definitionOnly = {
      ...disk,
      cases: [],
      plans: [],
      runs: [],
      history: [],
    };
    for (const encode of [exportApipost, exportApipostDirectory]) {
      if (entry === "native")
        assert.throws(() => encode(definitionOnly), /apiResourceTrash/);
      else {
        const target = await f.app.store.create("Restored definition");
        const roundtrip = await call(`projects/${target.id}/import`, {
          document: encode(definitionOnly),
          inheritanceMode: "preserve",
        });
        assert(roundtrip.requests.every((r) => !r.deletedAt));
        assert.deepEqual(
          [...roundtrip.folders].sort(),
          [...disk.folders].sort(),
        );
      }
    }

    await call(
      `projects/${restored.id}/native-inheritance-edit`,
      { configRevision: disk.configRevision, operation: restoreOperation },
      400,
    );
    await call(`projects/${restored.id}/execute`, {
      request: disk.requests.find((r) => r.id === ids[0]),
    });
    assert.equal(wire.at(-1).headers["x-folder"], "changed-while-recycled");
    assert.equal(wire.at(-1).headers.authorization, undefined);
    await call(`projects/${restored.id}/run`, { planId: plan.id });
    assert.equal(wire.at(-1).headers["x-folder"], "folder");
    assert.equal(wire.at(-1).headers.authorization, "Bearer fixture-token");
    assert.deepEqual((await f.app.store.get(f.other.id)).requests, []);
    assert(
      (await f.app.store.get(id)).requests.every((r) => r.deletedAt),
      "restored copy never activates source",
    );
  });
