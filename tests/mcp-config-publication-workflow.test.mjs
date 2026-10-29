import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { MCPConfigPublication } from "../src/mcp-config-publication.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-policy-workflow-"));
  const f = { root, app: await createApp({ root, port: 0 }), clients: [] };
  f.close = async () => {
    await Promise.all(
      f.clients.map((client) => client.close().catch(() => {})),
    );
    f.clients = [];
    f.app.server.closeAllConnections();
    await new Promise((done) => f.app.server.close(done));
  };
  f.restart = async () => {
    await f.close();
    f.app = await createApp({ root, port: 0 });
  };
  t.after(async () => {
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  f.owner = async (url, method = "GET", body, status = 200) => {
    const response = await fetch(f.app.url + url, {
      method,
      headers: {
        "x-local-token": f.app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, "owner response status");
    return response.json();
  };
  f.connect = async (token) => {
    const client = new Client(
      { name: "synthetic-policy-fixture", version: "1" },
      { capabilities: {} },
    );
    f.clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    return client;
  };
  f.policy = () => f.owner("/api/mcp/config");
  f.configure = (value, status = 200) =>
    f.owner("/api/mcp/config", "POST", value, status);
  f.disk = async () =>
    JSON.parse(await readFile(path.join(root, ".mcp-config.json"), "utf8"));
  f.allowed = await f.owner("/api/projects", "POST", { name: "Retained" }, 201);
  f.denied = await f.owner(
    "/api/projects",
    "POST",
    { name: "Never granted" },
    201,
  );
  return f;
}
function decode(value) {
  assert.notEqual(value.isError, true, "MCP operation must succeed");
  return JSON.parse(value.content[0].text);
}
const grant = (ids, extra = {}) => ({
  enabled: true,
  remember: true,
  projects: ids,
  write: true,
  execute: false,
  ...extra,
});
async function rejectedBearer(f, token) {
  const response = await fetch(f.app.url + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 403);
}

// These whole application/SDK/restart workflows are CI-only in this task.
for (const mode of ["disable", "rotate", "forget"]) {
  test(
    `owner ${mode} cannot be overwritten by an older canonical create completion`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const before = await f.configure(grant([f.allowed.id]));
      const client = await f.connect(before.token);
      assert(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "localapi_create_project",
        ),
      );
      const enteredCreate = deferred(),
        releaseCreate = deferred();
      const originalCreate = f.app.store.create.bind(f.app.store);
      const createMock = t.mock.method(
        f.app.store,
        "create",
        async (...args) => {
          const result = await originalCreate(...args);
          enteredCreate.resolve();
          await releaseCreate.promise;
          return result;
        },
      );
      const create = client.callTool({
        name: "localapi_create_project",
        arguments: { name: "Delayed create" },
      });
      await enteredCreate.promise;
      const enteredOwner = deferred(),
        releaseOwner = deferred(),
        enteredAuxiliary = deferred();
      const originalList = f.app.store.list.bind(f.app.store);
      const listMock = t.mock.method(f.app.store, "list", async () => {
        const result = await originalList();
        enteredOwner.resolve();
        await releaseOwner.promise;
        return result;
      });
      const originalPersist = MCPConfigPublication.prototype.persist;
      const persistMock = t.mock.method(
        MCPConfigPublication.prototype,
        "persist",
        function (identity) {
          const task = originalPersist.call(this, identity);
          enteredAuxiliary.resolve(); // real method has admitted the operation
          return task;
        },
      );
      t.after(() => {
        releaseCreate.resolve();
        releaseOwner.resolve();
      });
      const extra =
        mode === "disable"
          ? { enabled: false }
          : mode === "rotate"
            ? { rotate: true }
            : { remember: false };
      const owner = f.configure(grant([f.allowed.id], extra));
      await enteredOwner.promise;
      releaseCreate.resolve();
      await enteredAuxiliary.promise;
      releaseOwner.resolve();
      const after = await owner;
      // The canonical project creation happened exactly once even if root's later
      // authorization-generation response intentionally hides its stale result.
      await create;
      createMock.mock.restore();
      listMock.mock.restore();
      persistMock.mock.restore();
      const all = await originalList();
      assert.equal(all.filter((p) => p.name === "Delayed create").length, 1);
      assert.deepEqual((await f.policy()).projects, [f.allowed.id]);
      const disk = await f.disk();
      assert.equal(disk.remember, mode !== "forget");
      assert.equal(disk.enabled, mode === "rotate");
      assert.equal(
        disk.token === before.token,
        false,
        "disk must not retain obsolete bearer",
      );
      if (mode !== "forget") assert.deepEqual(disk.projects, [f.allowed.id]);
      if (mode !== "forget") {
        await rejectedBearer(f, before.token);
        await assert.rejects(client.listTools());
      } else {
        // Forgetting does not revoke the current session; it removes durable grants.
        assert((await client.listTools()).tools.length > 0);
      }
      await f.restart();
      await rejectedBearer(f, before.token);
      const restored = await f.policy();
      assert.equal(restored.enabled, mode === "rotate");
      if (mode === "rotate") {
        assert.equal(restored.token === after.token, true);
        const current = await f.connect(restored.token);
        assert.deepEqual(
          decode(
            await current.callTool({
              name: "localapi_list_projects",
              arguments: {},
            }),
          ).map((p) => p.id),
          [f.allowed.id],
        );
        assert.equal(
          (
            await current.callTool({
              name: "localapi_list_apis",
              arguments: { projectId: f.denied.id },
            })
          ).isError,
          true,
        );
        assert(
          !(await current.listTools()).tools.some(
            (tool) => tool.name === "localapi_execute_api",
          ),
        );
      }
    },
  );
}

test(
  "queued archive rejects stale owner grants, preserves unrelated create and survives restart",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const archive = await f.owner(
      "/api/projects",
      "POST",
      { name: "Archive target" },
      201,
    );
    const config = await f.configure(grant([f.allowed.id, archive.id]));
    const client = await f.connect(config.token);
    const enteredCreate = deferred(),
      releaseCreate = deferred();
    const originalCreate = f.app.store.create.bind(f.app.store);
    const createMock = t.mock.method(f.app.store, "create", async (...args) => {
      const result = await originalCreate(...args);
      enteredCreate.resolve();
      await releaseCreate.promise;
      return result;
    });
    const create = client.callTool({
      name: "localapi_create_project",
      arguments: { name: "Preserved concurrent create" },
    });
    await enteredCreate.promise;
    const enteredArchive = deferred(),
      releaseArchive = deferred(),
      enteredOwner = deferred();
    const originalSave = f.app.store.save.bind(f.app.store);
    const saveMock = t.mock.method(
      f.app.store,
      "save",
      async (project, ...args) => {
        if (project.id === archive.id && project.archived) {
          enteredArchive.resolve();
          await releaseArchive.promise;
        }
        return originalSave(project, ...args);
      },
    );
    // Observe real FIFO admission without replacing queue behavior.
    const originalRun = MCPConfigPublication.prototype.run;
    let admitted = 0;
    const runMock = t.mock.method(
      MCPConfigPublication.prototype,
      "run",
      function (operation) {
        const task = originalRun.call(this, operation);
        if (++admitted === 2) enteredOwner.resolve();
        return task;
      },
    );
    t.after(() => {
      releaseCreate.resolve();
      releaseArchive.resolve();
    });
    const archivedResponse = f.owner(`/api/projects/${archive.id}`, "PUT", {
      ...archive,
      archived: true,
    });
    await enteredArchive.promise;
    const staleOwner = f.configure(grant([f.allowed.id, archive.id]), 400);
    await enteredOwner.promise;
    releaseArchive.resolve();
    const archived = await archivedResponse;
    await staleOwner;
    releaseCreate.resolve();
    const created = decode(await create);
    createMock.mock.restore();
    saveMock.mock.restore();
    runMock.mock.restore();
    const second = decode(
      await client.callTool({
        name: "localapi_create_project",
        arguments: { name: "Second retained create" },
      }),
    );
    const expected = [f.allowed.id, created.id, second.id].sort();
    assert.deepEqual((await f.policy()).projects.sort(), expected);
    assert.deepEqual((await f.disk()).projects.sort(), expected);
    assert.equal(
      (
        await client.callTool({
          name: "localapi_list_apis",
          arguments: { projectId: archive.id },
        })
      ).isError,
      true,
    );
    await f.owner(`/api/projects/${archive.id}`, "PUT", {
      ...archived,
      archived: false,
    });
    assert.equal((await f.policy()).projects.includes(archive.id), false);
    await f.restart();
    const current = await f.connect((await f.policy()).token);
    assert.deepEqual(
      decode(
        await current.callTool({
          name: "localapi_list_projects",
          arguments: {},
        }),
      )
        .map((p) => p.id)
        .sort(),
      expected,
    );
    assert.equal(
      (
        await current.callTool({
          name: "localapi_list_apis",
          arguments: { projectId: archive.id },
        })
      ).isError,
      true,
    );
  },
);

test(
  "real failed policy rename does not publish and later owner update recovers",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.configure(grant([f.allowed.id]));
    const client = await f.connect(before.token);
    const file = path.join(f.root, ".mcp-config.json");
    const ignore = path.join(f.root, ".gitignore");
    const beforeBytes = await readFile(file);
    await rm(ignore);
    await mkdir(ignore);
    await f.configure(grant([f.allowed.id], { enabled: false }), 400);
    assert.equal((await readFile(file)).equals(beforeBytes), true);
    assert.equal((await f.policy()).token === before.token, true);
    await rm(ignore, { recursive: true });
    await rm(file);
    await mkdir(file);
    await f.configure(grant([f.allowed.id], { enabled: false }), 400);
    const unchanged = await f.policy();
    assert.equal(unchanged.enabled, true);
    assert.equal(unchanged.token === before.token, true);
    assert((await client.listTools()).tools.length > 0);
    assert.equal(
      (await readdir(f.root)).some((entry) => entry.endsWith(".tmp")),
      false,
    );
    await rm(file, { recursive: true });
    await f.configure(grant([f.allowed.id], { enabled: false }));
    await rejectedBearer(f, before.token);
    await f.restart();
    assert.equal((await f.policy()).enabled, false);
    await rejectedBearer(f, before.token);
  },
);
