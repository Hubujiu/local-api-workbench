import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-restore-owner-"));
  let app = await createApp({ root, port: 0 });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await closeServer(app.server);
    await rm(root, { recursive: true, force: true });
  });
  const raw = (route, method = "GET", body, token = app.token) =>
    fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-local-token": token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const api = async (...args) => {
    const response = await raw(...args);
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  const connect = async (ids) => {
    const config = await api("/api/mcp/config", "POST", {
      enabled: true,
      projects: ids,
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "resource-restore-owner", version: "1" },
      { capabilities: {} },
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    return {
      client,
      token: config.token,
      call: (name, args) =>
        client.callTool({ name: "apipost_" + name, arguments: args }),
    };
  };
  return {
    root,
    api,
    raw,
    connect,
    get app() {
      return app;
    },
    async restart() {
      for (const client of clients) await client.close();
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
async function seed(h, url = "http://127.0.0.1:1/wire") {
  const p = await h.app.store.create("Resource restore");
  p.folders = [
    "Ancestor",
    "Ancestor/Tree",
    "Ancestor/Tree/Child",
    "Ancestor/Tree/Empty",
    "Ancestor/Sibling",
  ];
  p.requests = [
    normalizeRequest({
      id: "inside",
      name: "Inside",
      method: "GET",
      url,
      folder: "Ancestor/Tree/Child",
    }),
    normalizeRequest({
      id: "sibling",
      name: "Sibling",
      method: "GET",
      url,
      folder: "Ancestor/Sibling",
    }),
  ];
  p.documents = [
    {
      id: "guide",
      title: "Guide",
      content: "# 原样🌏\n<script>inert</script> {{unexpanded}}",
      folder: "Ancestor/Tree/Child",
      statusId: "draft",
      attributes: {},
      importNotes: ["authored fixture"],
    },
  ];
  p.settings.recursiveFolderScopes = true;
  p.settings.folderParameters = {
    Ancestor: {
      headers: [{ key: "X-Ancestor", value: "kept", enabled: true }],
    },
    "Ancestor/Tree/Child": {
      headers: [{ key: "X-Folder", value: "restored", enabled: true }],
    },
  };
  p.settings.folderAuth = {
    "Ancestor/Tree/Child": { type: "bearer", token: "fixture-restored-token" },
  };
  p.settings.folderScripts = {
    "Ancestor/Tree/Child": {
      enabled: true,
      beforeScript: 'apt.setRequestHeader("X-Script","restored");',
    },
  };
  p.settings.folderServices = { "Ancestor/Tree/Child": "historical-binding" };
  p.plans = [
    snapshotPlan({
      id: "frozen-plan",
      name: "Frozen",
      steps: [{ id: "frozen-step", request: p.requests[0] }],
    }),
  ];
  p.cases = [
    snapshotCase({
      id: "frozen-case",
      name: "Frozen case",
      sourceRequestId: "inside",
      request: p.requests[0],
    }),
  ];
  await h.api(`/api/projects/${p.id}`, "PUT", p);
  return h.app.store.get(p.id);
}
const restoreBody = (p, batch = p.apiResourceTrash.batches.at(-1)) => ({
  configRevision: p.configRevision,
  batchId: batch.id,
});
const restorePath = (p) => `/api/projects/${p.id}/api-resource-restore`;
async function recycle(h, mcp, id, targets = ["folder:Ancestor/Tree"]) {
  decode(
    await mcp.call("delete_apis", {
      project_id: id,
      target_ids: targets,
      confirm: true,
    }),
  );
  return h.app.store.get(id);
}
async function disk(h, id) {
  const dir = h.app.store.directory(id);
  const walk = async (base) => {
    const result = {};
    for (const name of (await readdir(base)).sort()) {
      const filename = path.join(base, name);
      const entry = (await readdir(base, { withFileTypes: true })).find(
        (item) => item.name === name,
      );
      result[name] = entry.isDirectory()
        ? await walk(filename)
        : (await readFile(filename)).toString("base64");
    }
    return result;
  };
  return walk(dir);
}
async function rejectedWithoutWrite(h, p, body, suffix = "", token) {
  const before = await disk(h, p.id);
  const response = await h.raw(restorePath(p) + suffix, "POST", body, token);
  assert(
    response.status >= 400 && response.status < 500,
    await response.text(),
  );
  assert.deepEqual(await disk(h, p.id), before);
  return response.status;
}

test(
  "owner whole-batch restore closes native deletion, real scoped HTTP, history and backup/restart isolation",
  { timeout: 30000 },
  async (t) => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => closeServer(upstream));
    const h = await harness(t);
    const configured = await seed(
      h,
      `http://127.0.0.1:${upstream.address().port}/wire`,
    );
    const foreign = await h.app.store.create("Untouched foreign");
    const foreignBefore = await disk(h, foreign.id);
    let mcp = await h.connect([configured.id]);
    assert(
      !(await mcp.client.listTools()).tools.some((tool) =>
        /restore.*resource|resource.*restore/.test(tool.name),
      ),
    );
    const deleted = await recycle(h, mcp, configured.id);
    const batch = structuredClone(deleted.apiResourceTrash.batches[0]);
    assert.equal(deleted.documents.length, 0);
    for (const id of ["guide", "inside", "folder:Ancestor/Tree/Empty"])
      assert.equal(
        (
          await mcp.call("get_api_detail", {
            project_id: configured.id,
            target_id: id,
          })
        ).isError,
        true,
      );
    assert(
      !decode(
        await mcp.call("list_apis", { project_id: configured.id }),
      ).apis.some(
        (item) => item.target_id === "guide" || item.target_id === "inside",
      ),
    );
    const restored = await h.api(
      restorePath(deleted),
      "POST",
      restoreBody(deleted),
    );
    assert.equal(restored.id, configured.id);
    assert.equal(restored.configRevision, deleted.configRevision + 1);
    assert.equal(restored.revision, deleted.revision + 1);
    assert.deepEqual(restored.documents, configured.documents);
    assert.deepEqual(restored.settings, configured.settings);
    assert.deepEqual(
      [...restored.folders].sort(),
      [...configured.folders].sort(),
    );
    assert.deepEqual(restored.plans, configured.plans);
    assert.deepEqual(restored.cases, configured.cases);
    assert.deepEqual(restored.requests, configured.requests);
    const historical = restored.apiResourceTrash.batches[0];
    assert.equal(
      new Date(historical.restoredAt).toISOString(),
      historical.restoredAt,
    );
    const { restoredAt, ...originalBatch } = historical;
    assert.deepEqual(originalBatch, batch);
    const detail = decode(
      await mcp.call("get_api_detail", {
        project_id: restored.id,
        target_id: "guide",
      }),
    ).api;
    assert.equal(detail.description, configured.documents[0].content);
    assert.equal(detail.statusId, "draft");
    const execution = decode(
      await mcp.client.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: restored.id, apiId: "inside" },
      }),
    );
    assert.equal(execution.status, "passed");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]["x-ancestor"], "kept");
    assert.equal(seen[0]["x-folder"], "restored");
    assert.equal(seen[0]["x-script"], "restored");
    assert.equal(seen[0].authorization, "Bearer fixture-restored-token");
    let edited = await h.app.store.get(restored.id);
    assert.deepEqual(edited.plans, configured.plans);
    assert.deepEqual(edited.cases, configured.cases);
    edited.documents[0].content = "# 第二代正文";
    edited.documents[0].statusId = "edited";
    await h.api(`/api/projects/${edited.id}`, "PUT", edited);
    const secondDeleted = await recycle(h, mcp, edited.id, ["guide"]);
    assert.equal(secondDeleted.apiResourceTrash.batches.length, 2);
    const secondRestored = await h.api(
      restorePath(secondDeleted),
      "POST",
      restoreBody(secondDeleted),
    );
    assert.deepEqual(secondRestored.apiResourceTrash.batches[0], historical);
    assert.equal(
      secondRestored.apiResourceTrash.batches[0].documents[0].content,
      configured.documents[0].content,
    );
    assert.equal(
      secondRestored.apiResourceTrash.batches[1].documents[0].content,
      "# 第二代正文",
    );
    assert.equal(secondRestored.documents[0].content, "# 第二代正文");
    await rejectedWithoutWrite(h, secondRestored, restoreBody(secondRestored));
    const reordered = structuredClone(secondRestored);
    reordered.apiResourceTrash.batches.reverse();
    const orderBefore = await disk(h, reordered.id);
    const orderResponse = await h.raw(
      `/api/projects/${reordered.id}`,
      "PUT",
      reordered,
    );
    assert(orderResponse.status >= 400 && orderResponse.status < 500);
    assert.deepEqual(await disk(h, reordered.id), orderBefore);
    const backup = await h.api(
      `/api/projects/${restored.id}/export?format=backup`,
    );
    const copied = await h.api("/api/restore", "POST", { document: backup });
    assert.notEqual(copied.id, restored.id);
    assert.deepEqual(copied.apiResourceTrash, secondRestored.apiResourceTrash);
    assert.equal(
      (await mcp.call("list_apis", { project_id: copied.id })).isError,
      true,
    );
    const originalBefore = await disk(h, restored.id);
    const oldToken = mcp.token;
    await h.restart();
    assert.deepEqual(
      (await new Store(h.root).get(copied.id)).documents,
      secondRestored.documents,
    );
    const denied = await fetch(h.app.url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + oldToken,
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert([401, 403].includes(denied.status));
    mcp = await h.connect([copied.id]);
    assert.equal(
      (await mcp.call("list_apis", { project_id: restored.id })).isError,
      true,
    );
    assert.equal(
      decode(
        await mcp.call("get_api_detail", {
          project_id: copied.id,
          target_id: "guide",
        }),
      ).api.description,
      "# 第二代正文",
    );
    const copiedDeleted = await recycle(h, mcp, copied.id, ["guide"]);
    await h.api(restorePath(copiedDeleted), "POST", restoreBody(copiedDeleted));
    assert.deepEqual(await disk(h, restored.id), originalBefore);
    assert.deepEqual(await disk(h, foreign.id), foreignBefore);
  },
);

test(
  "owner restore rejects malformed/stale/foreign/partial and occupied scopes without writes",
  { timeout: 30000 },
  async (t) => {
    const h = await harness(t);
    const p = await seed(h);
    const foreign = await seed(h);
    const mcp = await h.connect([p.id, foreign.id]);
    let deleted = await recycle(h, mcp, p.id);
    const foreignDeleted = await recycle(h, mcp, foreign.id);
    const valid = restoreBody(deleted);
    for (const body of [
      null,
      {},
      { batchId: valid.batchId },
      { ...valid, configRevision: valid.configRevision - 1 },
      { ...valid, batchId: "unknown" },
      { ...valid, batchId: foreignDeleted.apiResourceTrash.batches[0].id },
      { ...valid, restoredAt: new Date().toISOString() },
      { ...valid, extra: true },
      { ...valid, configRevision: String(valid.configRevision) },
    ])
      await rejectedWithoutWrite(h, deleted, body);
    for (const suffix of ["?extra=1", "/extra"])
      await rejectedWithoutWrite(h, deleted, valid, suffix);
    assert.equal(await rejectedWithoutWrite(h, deleted, valid, "", ""), 403);
    assert.equal(
      await rejectedWithoutWrite(h, deleted, valid, "", "wrong-owner-token"),
      403,
    );
    for (const change of [
      (draft) => {
        draft.apiResourceTrash.batches = [];
      },
      (draft) => {
        draft.apiResourceTrash.batches[0].documents[0].content = "forged";
      },
      (draft) => {
        draft.apiResourceTrash.batches[0].restoredAt = new Date().toISOString();
      },
    ]) {
      const draft = structuredClone(deleted);
      change(draft);
      const before = await disk(h, p.id);
      const response = await h.raw(`/api/projects/${p.id}`, "PUT", draft);
      assert(response.status >= 400 && response.status < 500);
      assert.deepEqual(await disk(h, p.id), before);
    }
    const partial = structuredClone(deleted);
    delete partial.requests.find((item) => item.id === "inside").deletedAt;
    await h.api(`/api/projects/${p.id}`, "PUT", partial);
    deleted = await h.app.store.get(p.id);
    await rejectedWithoutWrite(h, deleted, restoreBody(deleted));
    // Occupied empty directory cannot be silently merged into the old subtree.
    const occupied = await seed(h);
    const occupiedMCP = await h.connect([occupied.id]);
    const occupiedDeleted = await recycle(h, occupiedMCP, occupied.id);
    occupiedDeleted.folders.push("Ancestor/Tree/Empty");
    await h.api(`/api/projects/${occupied.id}`, "PUT", occupiedDeleted);
    const current = await h.app.store.get(occupied.id);
    await rejectedWithoutWrite(h, current, restoreBody(current));
    // A valid empty native graph reaches the restore guard even when the
    // integrated Store also validates native inheritance on ordinary PUT.
    const native = await h.app.store.create("Native restore exclusion");
    native.documents = [
      {
        id: "native-guide",
        title: "Native guide",
        content: "Native document",
        folder: "",
      },
    ];
    await h.api(`/api/projects/${native.id}`, "PUT", native);
    const nativeMCP = await h.connect([native.id]);
    const nativeDeleted = await recycle(h, nativeMCP, native.id, [
      "native-guide",
    ]);
    nativeDeleted.folders = [];
    nativeDeleted.requests = [];
    nativeDeleted.settings.nativeInheritance = {
      version: 1,
      sourceProjectId: "native-source",
      projectLayer: {
        auth: { mode: "absent" },
        headers: [],
        query: [],
        cookies: [],
      },
      folders: [],
      bindings: [],
    };
    await h.api(`/api/projects/${native.id}`, "PUT", nativeDeleted);
    const nativeNow = await h.app.store.get(native.id);
    await rejectedWithoutWrite(h, nativeNow, restoreBody(nativeNow));
    const archived = await seed(h);
    const archivedMCP = await h.connect([archived.id]);
    const archivedDeleted = await recycle(h, archivedMCP, archived.id);
    archivedDeleted.archived = true;
    await h.api(`/api/projects/${archived.id}`, "PUT", archivedDeleted);
    const archivedNow = await h.app.store.get(archived.id);
    await rejectedWithoutWrite(h, archivedNow, restoreBody(archivedNow));
  },
);

test(
  "independent Stores serialize whole-batch restore; malformed trash fails only its project after restart",
  { timeout: 30000 },
  async (t) => {
    const h = await harness(t);
    const p = await seed(h);
    const healthy = await h.app.store.create("Healthy");
    const mcp = await h.connect([p.id]);
    const deleted = await recycle(h, mcp, p.id);
    const input = restoreBody(deleted);
    const stores = [new Store(h.root), new Store(h.root)];
    const outcomes = await Promise.allSettled(
      stores.map((store) => store.restoreAPIResources(p.id, input)),
    );
    assert.equal(
      outcomes.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((item) => item.status === "rejected").length,
      1,
    );
    const restored = await h.app.store.get(p.id);
    assert.equal(restored.configRevision, deleted.configRevision + 1);
    assert.equal(restored.revision, deleted.revision + 1);
    assert.equal(
      restored.documents.filter((item) => item.id === "guide").length,
      1,
    );
    const before = await disk(h, p.id);
    await assert.rejects(stores[1].restoreAPIResources(p.id, input));
    await assert.rejects(
      stores[0].restoreAPIResources(p.id, restoreBody(restored)),
    );
    assert.deepEqual(await disk(h, p.id), before);
    const filename = path.join(h.app.store.directory(p.id), "project.json");
    const invalid = JSON.parse(await readFile(filename, "utf8"));
    invalid.apiResourceTrash.batches[0].restoredAt = "not-an-ISO-time";
    await writeFile(filename, JSON.stringify(invalid));
    await h.restart();
    const restarted = new Store(h.root);
    await assert.rejects(restarted.get(p.id));
    assert.equal((await restarted.get(healthy.id)).name, "Healthy");
  },
);
