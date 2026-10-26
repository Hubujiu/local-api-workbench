import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import {
  importIntoProject,
  importDocument,
  normalizeRequest,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
import {
  deleteAPIResources,
  validateAPIResourceTrash,
} from "../src/api-resource-lifecycle.mjs";
import { nativeAPIList, nativeAPIDetail } from "../src/native-mcp-tools.mjs";
import { exportDocumentation } from "../public/document-export.js";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

// Independently authored from the observed static field contract, not an original export.
const body =
  "# 原样正文\nUnicode 中🌏\n<script>not executed</script> {{notInterpolated}}";
function fixture(url = "http://127.0.0.1:1/wire") {
  return {
    project_id: "document-source",
    apis: [
      {
        target_id: "a",
        target_type: "folder",
        name: "A",
        parent_id: "0",
        request: {},
      },
      {
        target_id: "child",
        target_type: "folder",
        name: "Child",
        parent_id: "a",
        request: {},
      },
      {
        target_id: "ab",
        target_type: "folder",
        name: "AB",
        parent_id: "0",
        request: {},
      },
      {
        target_id: "inside",
        target_type: "api",
        name: "Inside",
        parent_id: "child",
        method: "GET",
        url,
        request: {},
      },
      {
        target_id: "outside",
        target_type: "api",
        name: "Outside",
        parent_id: "0",
        method: "GET",
        url,
        request: {},
      },
      {
        target_id: "sibling",
        target_type: "api",
        name: "Sibling",
        parent_id: "ab",
        method: "GET",
        url,
        request: {},
      },
      {
        target_id: "doc",
        project_id: "document-source",
        target_type: "doc",
        name: "Guide",
        parent_id: "child",
        description: body,
        version: 1,
        sort: 4,
      },
      {
        target_id: "root-doc",
        target_type: "doc",
        name: "Root guide",
        parent_id: "0",
        description: "root document",
      },
    ],
  };
}
const project = () => ({
  version: 1,
  id: "p",
  name: "P",
  requests: [],
  documents: [],
  folders: [],
  plans: [],
  runs: [],
  history: [],
  environments: [{ id: "env", name: "Env", variables: {} }],
  settings: {},
});
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

test("bounded legacy/modern documents preserve source/body and reject semantic loss atomically", () => {
  const input = fixture(),
    copy = structuredClone(input),
    p = project();
  assert.equal(importIntoProject(p, input).length, 3);
  assert.equal(p.documents.length, 2);
  assert.equal(p.documents[0].content, body);
  assert.equal(p.documents[0].folder, "A/Child");
  assert.equal(p.documents[0].apipostSource.projectId, "document-source");
  assert.deepEqual(input, copy);
  assert.throws(() => importDocument(input), /完整项目/);
  const originalDocs = structuredClone(p.documents);
  importIntoProject(p, input);
  assert.deepEqual(p.documents, originalDocs);
  for (const change of [
    (d) => d.apis.push({ ...d.apis.at(-1) }),
    (d) => {
      d.apis.at(-1).parent_id = "missing";
    },
    (d) => {
      d.apis.at(-1).parent_id = "inside";
    },
    (d) => {
      d.apis.at(-1).description = {};
    },
    (d) => {
      d.apis.at(-1).project_id = "foreign";
    },
    (d) => {
      d.apis.at(-1).request = {
        pre_tasks: [{ type: "customScript", data: "throw Error()" }],
      };
    },
    (d) => {
      d.apis.at(-1).attachments = ["/etc/private"];
    },
    (d) => {
      d.apis.at(-1).url = "http://example.invalid";
    },
    (d) => {
      d.apis.at(-1).description = "x".repeat(1024 * 1024 + 1);
    },
  ]) {
    const invalid = fixture(),
      target = project(),
      before = structuredClone(target);
    change(invalid);
    assert.throws(() => importIntoProject(target, invalid));
    assert.deepEqual(target, before);
  }
  const conflict = fixture();
  conflict.apis.at(-1).description = "changed";
  const before = structuredClone(p);
  assert.throws(() => importIntoProject(p, conflict), /冲突/);
  assert.deepEqual(p, before);
  const colliding = fixture();
  colliding.apis.push({
    target_id: "flat",
    target_type: "folder",
    name: "A/Child",
    parent_id: "0",
    request: {},
  });
  assert.throws(() => importIntoProject(project(), colliding), /同一路径/);
  const sameName = fixture();
  sameName.apis.push({
    target_id: "same",
    target_type: "folder",
    name: "Child",
    parent_id: "a",
    request: {},
  });
  assert.throws(() => importIntoProject(project(), sameName), /同一路径/);
  const modern = modernApipostFixture();
  modern.apis.push({
    target_id: "md",
    project_id: modern.project_id,
    target_type: "doc",
    name: "Modern",
    parent_id: "folder",
    description: body,
    mark_id: "1",
  });
  const m = project(),
    source = structuredClone(modern);
  importIntoProject(m, modern);
  assert.equal(m.documents[0].folder, "Group");
  assert.equal(m.documents[0].statusId, m.settings.statuses[0].id);
  assert.equal(m.documents[0].content, body);
  assert.deepEqual(modern, source);
  for (const change of [
    (d) => {
      d.apis.at(-1).mark_id = "missing";
    },
    (d) => {
      d.apis.at(-1).response = { example: [{ raw: "x" }] };
    },
    (d) => {
      d.apis.at(-1).attribute_info = { unknown: "value" };
    },
  ]) {
    const d = structuredClone(modern),
      target = project();
    change(d);
    const before = structuredClone(target);
    assert.throws(() => importIntoProject(target, d));
    assert.deepEqual(target, before);
  }
  const occupied = project();
  occupied.requests.push(
    normalizeRequest({
      id: originalDocs[0].id,
      deletedAt: new Date().toISOString(),
    }),
  );
  assert.throws(() => importIntoProject(occupied, input), /冲突/);
});

test("native subtree preflight rejects ambiguous/reserved/unknown IDs and unsupported scopes without mutations", () => {
  const p = project();
  importIntoProject(p, fixture());
  const original = structuredClone(p);
  for (const ids of [
    [],
    ["0"],
    ["folder:"],
    ["missing"],
    ["folder:A", "missing"],
    ["folder:A", "folder:A"],
  ]) {
    assert.throws(() => deleteAPIResources(p, ids));
    assert.deepEqual(p, original);
  }
  const implicit = project();
  implicit.folders = ["A/Child"];
  assert.deepEqual(
    nativeAPIList(implicit, {}).apis.map((item) => item.target_id),
    ["folder:A", "folder:A/Child"],
  );
  assert.equal(nativeAPIDetail(implicit, "folder:A").api.target_type, "folder");
  for (const change of [
    (d) => {
      d.documents[0].id = d.requests[0].id;
    },
    (d) => {
      d.documents[0].id = "folder:A";
    },
    (d) => {
      d.documents[0].id = "0";
    },
    (d) => {
      d.requests.push({ ...d.requests[0], deletedAt: "past" });
    },
    (d) => {
      d.protocols = [{ id: d.documents[0].id, folder: "AB" }];
    },
  ]) {
    const invalid = structuredClone(p);
    change(invalid);
    const before = structuredClone(invalid);
    assert.throws(
      () => nativeAPIDetail(invalid, invalid.documents[0].id),
      /冲突|命名空间/,
    );
    assert.throws(() => deleteAPIResources(invalid, ["folder:A"]));
    assert.deepEqual(invalid, before);
  }
  for (const change of [
    (d) => {
      d.protocols = [{ id: "ws", folder: "A/Child", type: "websocket" }];
    },
    (d) => {
      d.settings.grpcDefinitions = [{ id: "grpc" }];
    },
    (d) => {
      d.settings.folderUnknown = { A: { secret: "retained" } };
    },
  ]) {
    const invalid = structuredClone(p);
    change(invalid);
    const before = structuredClone(invalid);
    assert.throws(() => deleteAPIResources(invalid, ["folder:A"]), /协议|设置/);
    assert.deepEqual(invalid, before);
  }
  const onlyProtocol = project();
  onlyProtocol.protocols = [{ id: "ws", folder: "Protocol/Only" }];
  assert.throws(
    () => deleteAPIResources(onlyProtocol, ["folder:Protocol"]),
    /协议/,
  );
  const overlap = deleteAPIResources(p, ["folder:A", p.requests[0].id]);
  assert.equal(overlap.selectedTargetIds.length, 2);
  assert.equal(
    overlap.project.apiResourceTrash.batches[0].requestIds.length,
    1,
  );
  assert.deepEqual(p, original);
});

test("trash validation is bounded, descriptor-safe, retained by backup and rejects before a Store journal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-doc-trash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("Validation");
  importIntoProject(p, fixture());
  await store.save(p);
  const deleted = deleteAPIResources(p, ["folder:A"]).project;
  await store.save(deleted);
  const before = await readFile(
    path.join(store.directory(p.id), "project.json"),
    "utf8",
  );
  let getterCalls = 0;
  for (const tamper of [
    (d) => {
      d.apiResourceTrash.version = 2;
    },
    (d) => {
      d.apiResourceTrash.extra = true;
    },
    (d) => {
      d.apiResourceTrash.batches[0].folderSettings.folderScripts = {
        AB: { beforeScript: "evil" },
      };
    },
    (d) => {
      d.apiResourceTrash.batches[0].folderSettings.folderAuth = {
        A: { type: "unknown" },
      };
    },
    (d) => {
      d.apiResourceTrash.batches[0].documents[0].id = "folder:A";
    },
    (d) => {
      d.apiResourceTrash.batches[0].documents[0].content = "x".repeat(
        4 * 1024 * 1024,
      );
    },
    (d) => {
      d.apiResourceTrash.batches[0].folderSettings =
        JSON.parse('{"__proto__":{}}');
    },
    (d) => {
      Object.defineProperty(d.apiResourceTrash.batches[0], "documents", {
        get() {
          getterCalls++;
          return [];
        },
        enumerable: true,
      });
    },
    (d) => {
      Object.defineProperty(d, "apiResourceTrash", {
        get() {
          getterCalls++;
          return {};
        },
        enumerable: true,
      });
    },
    (d) => {
      const a = new Array(1);
      a.extra = "lost";
      d.apiResourceTrash.batches = a;
    },
    (d) => {
      d.apiResourceTrash.batches[0].documents.extra = "lost";
    },
    (d) => {
      Object.setPrototypeOf(d.apiResourceTrash.batches[0], Array.prototype);
    },
    (d) => {
      d.apiResourceTrash.batches = Array.from({ length: 101 }, (_, i) => ({
        ...d.apiResourceTrash.batches[0],
        id: String(i),
      }));
    },
    (d) => {
      const original = d.apiResourceTrash.batches[0].documents[0];
      d.apiResourceTrash.batches[0].documents = Array.from(
        { length: 6 },
        (_, i) => ({
          ...original,
          id: "large-" + i,
          content: "x".repeat(800000),
        }),
      );
    },
  ]) {
    const bad = structuredClone(deleted);
    tamper(bad);
    assert.throws(() => restoreProject(bad));
    await assert.rejects(store.save(bad));
    assert.equal(
      await readFile(path.join(store.directory(p.id), "project.json"), "utf8"),
      before,
    );
    await assert.rejects(
      access(path.join(store.directory(p.id), ".transaction.json")),
    );
  }
  assert.equal(getterCalls, 0);
  const full = structuredClone(deleted);
  const batch = full.apiResourceTrash.batches[0];
  full.apiResourceTrash.batches = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(batch),
    id: "batch-" + index,
    selectedTargetIds: [batch.requestIds[0]],
    folderPaths: [],
    explicitFolders: [],
    documents: [],
    folderSettings: {},
  }));
  validateAPIResourceTrash(full);
  const snapshot = structuredClone(full);
  assert.throws(
    () =>
      deleteAPIResources(full, [
        full.requests.find((item) => !item.deletedAt).id,
      ]),
    /容量/,
  );
  assert.deepEqual(full, snapshot);
  const restored = restoreProject(deleted);
  assert.deepEqual(restored.apiResourceTrash, deleted.apiResourceTrash);
  assert.notEqual(restored.id, deleted.id);
  assert.equal(restored.documents.length, 1);
  await store.save(restored);
  assert.deepEqual(
    (await new Store(root).get(restored.id)).apiResourceTrash,
    deleted.apiResourceTrash,
  );
});

test(
  "official SDK native document/tree deletion persists, keeps frozen HTTP evidence and old HTTP restore semantics",
  { timeout: 30000 },
  async (t) => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(path.join(os.tmpdir(), "native-doc-sdk-"));
    let app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const api = async (route, method = "GET", data) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      });
      assert(response.ok, await response.clone().text());
      return response.json();
    };
    const connect = async (projects, write = false) => {
      const config = await api("/api/mcp/config", "POST", {
        enabled: true,
        projects,
        write,
        execute: write,
        remember: false,
      });
      const client = new Client(
        { name: "native-document-lifecycle", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
      return client;
    };
    const p = await app.store.create("Native documents"),
      other = await app.store.create("Isolated");
    const source = fixture(
        "http://127.0.0.1:" + upstream.address().port + "/wire",
      ),
      sourceBefore = structuredClone(source);
    await api(`/api/projects/${p.id}/import`, "POST", { document: source });
    let loaded = await app.store.get(p.id);
    const inside = loaded.requests.find((item) => item.name === "Inside"),
      outside = loaded.requests.find((item) => item.name === "Outside"),
      guide = loaded.documents.find((item) => item.title === "Guide"),
      rootDoc = loaded.documents.find((item) => item.title === "Root guide");
    loaded.plans = [
      snapshotPlan({
        id: "frozen",
        name: "Frozen",
        steps: [{ id: "step", request: inside }],
      }),
    ];
    loaded.settings.folderScripts = {
      A: { beforeScript: 'throw Error("must remain inert")', enabled: true },
    };
    loaded.settings.folderAuth = {
      A: { type: "bearer", token: "fictional-folder-token" },
    };
    loaded.settings.folderParameters = {
      "A/Child": {
        headers: [{ key: "X-Folder", value: "retained", enabled: true }],
      },
    };
    loaded.settings.folderServices = { A: "historical-service" };
    await api(`/api/projects/${p.id}`, "PUT", loaded);
    const configured = await app.store.get(p.id),
      plans = structuredClone(configured.plans),
      settings = structuredClone(configured.settings);
    let client = await connect([p.id]);
    let call = (name, args = {}) =>
      client.callTool({ name: "apipost_" + name, arguments: args });
    assert(
      !(await client.listTools()).tools.some(
        (tool) => tool.name === "apipost_delete_apis",
      ),
    );
    assert.equal(
      (
        await call("delete_apis", {
          project_id: p.id,
          target_ids: [guide.id],
          confirm: true,
        })
      ).isError,
      true,
    );
    await client.close();
    client = await connect([p.id], true);
    assert.equal(
      decode(
        await call("get_api_detail", { project_id: p.id, target_id: guide.id }),
      ).api.description,
      body,
    );
    const folder = decode(
      await call("get_api_detail", { project_id: p.id, target_id: "folder:A" }),
    ).api;
    assert.equal(folder.target_type, "folder");
    assert.equal(folder.workbench_definition_format, 1);
    assert.deepEqual(
      folder.workbench_folder_settings.folderScripts,
      settings.folderScripts.A,
    );
    const direct = decode(
      await call("list_apis", { project_id: p.id, parent_id: "folder:A" }),
    ).apis;
    assert.deepEqual(
      direct.map((item) => item.target_id),
      ["folder:A/Child"],
    );
    assert.equal(
      decode(await call("list_apis", { project_id: p.id, keyword: "gUiDe" }))
        .apis.length,
      2,
    );
    for (const args of [
      { project_id: p.id, target_ids: [guide.id], confirm: false },
      { project_id: p.id, target_ids: [guide.id, "missing"], confirm: true },
      { project_id: p.id, target_ids: [guide.id, guide.id], confirm: true },
      { project_id: other.id, target_ids: [guide.id], confirm: true },
    ]) {
      assert.equal((await call("delete_apis", args)).isError, true);
      assert.deepEqual(await app.store.get(p.id), configured);
    }
    const selected = ["folder:A", rootDoc.id, outside.id];
    assert.deepEqual(
      decode(
        await call("delete_apis", {
          project_id: p.id,
          target_ids: selected,
          confirm: true,
        }),
      ),
      { project_id: p.id, deleted: 3, target_ids: selected },
    );
    const deleted = await app.store.get(p.id),
      batch = deleted.apiResourceTrash.batches[0];
    assert.equal(hits, 0);
    assert.equal(deleted.documents.length, 0);
    assert.equal(batch.documents.length, 2);
    assert.equal(
      batch.documents.find((item) => item.id === guide.id).content,
      body,
    );
    assert.deepEqual(batch.folderSettings, {
      folderParameters: settings.folderParameters,
      folderAuth: settings.folderAuth,
      folderScripts: settings.folderScripts,
      folderServices: settings.folderServices,
    });
    for (const key of Object.keys(batch.folderSettings))
      assert.deepEqual(deleted.settings[key], {});
    assert.deepEqual(deleted.plans, plans);
    assert.deepEqual(deleted.history, configured.history);
    assert.deepEqual(deleted.runs, configured.runs);
    assert.deepEqual(deleted.folders, ["AB"]);
    assert.deepEqual(
      decode(await call("list_apis", { project_id: p.id })).apis.map(
        (item) => item.name,
      ),
      ["AB", "Sibling"],
    );
    const canonical = decode(
      await client.callTool({
        name: "localapi_list_apis",
        arguments: { projectId: p.id },
      }),
    );
    assert(
      !canonical.some(
        (item) => item.type === "document" || item.folder?.startsWith("A/"),
      ),
    );
    for (const format of ["markdown", "html"])
      assert(!exportDocumentation(deleted, format).includes("原样正文"));
    assert.equal(
      (await call("get_api_detail", { project_id: p.id, target_id: guide.id }))
        .isError,
      true,
    );
    const run = decode(
      await client.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: "frozen" },
      }),
    );
    assert.equal(run.status, "passed");
    assert.equal(hits, 1);
    assert.deepEqual((await app.store.get(p.id)).plans, plans);
    // The pre-existing HTTP restore action is an ordinary project PUT. Historical
    // references must not turn that action into a broken restore button.
    const revived = await app.store.get(p.id);
    delete revived.requests.find((item) => item.id === inside.id).deletedAt;
    await api(`/api/projects/${p.id}`, "PUT", revived);
    assert.equal(
      decode(
        await call("get_api_detail", {
          project_id: p.id,
          target_id: inside.id,
        }),
      ).api.target_type,
      "api",
    );
    decode(
      await call("delete_apis", {
        project_id: p.id,
        target_ids: [inside.id],
        confirm: true,
      }),
    );
    const twice = await app.store.get(p.id);
    assert.equal(twice.apiResourceTrash.batches.length, 2);
    assert.deepEqual(twice.apiResourceTrash.batches[0], batch);
    assert.equal(twice.runs.length, 1);
    const restored = await api("/api/restore", "POST", { document: twice });
    assert.deepEqual(restored.apiResourceTrash, twice.apiResourceTrash);
    assert.equal(restored.documents.length, 0);
    assert.equal(
      (await call("list_apis", { project_id: restored.id })).isError,
      true,
    );
    const foreignBefore = await app.store.get(other.id);
    await client.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app = await createApp({ root, port: 0 });
    assert.deepEqual(
      (await new Store(root).get(p.id)).apiResourceTrash,
      twice.apiResourceTrash,
    );
    client = await connect([restored.id], true);
    assert.equal((await call("list_apis", { project_id: p.id })).isError, true);
    assert.deepEqual(
      decode(await call("list_apis", { project_id: restored.id })).apis.map(
        (item) => item.name,
      ),
      ["AB", "Sibling"],
    );
    assert.deepEqual(await app.store.get(other.id), foreignBefore);
    assert.deepEqual(source, sourceBefore);
  },
);
