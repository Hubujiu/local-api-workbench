import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
test(
  "SDK managed project, atomic OpenAPI sync and confirmed soft delete survive restart without inherited grants",
  { timeout: 20000 },
  async (t) => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end('{"value":"synced"}');
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "native-project-sync-"));
    let app = await createApp({ root, port: 0 });
    const client = new Client(
      { name: "native-project-sync", version: "1" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const config = await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects: [],
          write: true,
          execute: true,
          remember: false,
        }),
      })
    ).json();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const call = (name, args = {}) =>
      client.callTool({ name: "apipost_" + name, arguments: args });
    assert.equal(
      (
        await call("create_project", {
          name: "Bad",
          storage_path: "/tmp/unmanaged",
        })
      ).isError,
      true,
    );
    assert.equal((await app.store.list()).length, 0);
    const created = decode(
      await call("create_project", {
        name: "  Managed ",
        description: " Description ",
      }),
    );
    assert.equal(created.name, "Managed");
    assert.equal(created.description, "Description");
    assert.equal(created.authorized, true);
    assert.equal(created.storage_path, path.join(root, created.project_id));
    const project_id = created.project_id;
    assert.equal(
      decode(await call("list_projects")).projects[0].project_id,
      project_id,
    );
    const document = {
      openapi: "3.1.0",
      info: { title: "Fixture", version: "1" },
      servers: [{ url: "https://must-not-join.invalid/base" }],
      paths: {
        "/echo": {
          get: { summary: "First", responses: { 200: { description: "OK" } } },
        },
      },
    };
    decode(
      await call("update_environment", {
        project_id,
        environment_id: "1",
        base_url: `http://127.0.0.1:${upstream.address().port}`,
      }),
    );
    const input = {
      project_id,
      openapi: document,
      api_scripts: [
        {
          method: "GET",
          url: "/echo",
          post_script:
            'apt.environment.set("after", apt.response.json().value);',
        },
      ],
    };
    const first = decode(await call("sync_openapi", input));
    assert.equal(first.created, 1);
    assert.equal(first.updated, 0);
    assert.equal(first.sync_items[0].url, "/echo");
    const id = first.sync_items[0].target_id;
    let p = await app.store.get(project_id);
    assert.equal(p.requests[0].scriptDialect, "apipost8");
    assert.equal(p.requests[0].url, "/echo");
    const update = decode(
      await call("sync_openapi", {
        ...input,
        openapi: JSON.stringify(document),
      }),
    );
    assert.equal(update.updated, 1);
    assert.equal(update.sync_items[0].target_id, id);
    const ignored = decode(
      await call("sync_openapi", { ...input, api_cover_mode: "ignore" }),
    );
    assert.equal(ignored.skipped, 1);
    assert.equal(ignored.sync_items.length, 0);
    const executed = decode(
      await call("execute_api", { project_id, target_id: id }),
    );
    assert.equal(executed.status, "passed");
    assert.equal(hits, 1);
    assert.equal(
      (await app.store.get(project_id)).environments[0].variables.after,
      "synced",
    );
    const before = JSON.stringify(await app.store.get(project_id));
    for (const bad of [
      { api_cover_mode: "clear" },
      { folder_id: "folder:missing" },
      { folder_id: "folder:" },
      { base_path: true },
      { api_scripts: [{ method: "GET", url: "/missing" }] },
      {
        openapi: {
          ...document,
          paths: { "/bad": { $ref: "https://external.invalid/schema" } },
        },
      },
    ]) {
      assert.equal(
        (await call("sync_openapi", { ...input, ...bad })).isError,
        true,
      );
      assert.equal(JSON.stringify(await app.store.get(project_id)), before);
    }
    for (const args of [
      { target_ids: [id] },
      { target_ids: [id, "missing"], confirm: true },
      { target_ids: [id, id], confirm: true },
      { target_ids: [], confirm: true },
    ]) {
      assert.equal(
        (await call("delete_apis", { project_id, ...args })).isError,
        true,
      );
      assert.equal(JSON.stringify(await app.store.get(project_id)), before);
    }
    const deleted = decode(
      await call("delete_apis", {
        project_id,
        target_ids: [id],
        confirm: true,
      }),
    );
    assert.equal(deleted.deleted, 1);
    assert.equal(
      decode(await call("list_apis", { project_id })).apis.length,
      0,
    );
    p = await app.store.get(project_id);
    assert.ok(p.requests[0].deletedAt);
    assert.equal(p.requests[0].id, id);
    await client.close();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    const restored = await app.store.get(project_id);
    assert.equal(restored.description, "Description");
    assert.ok(restored.requests[0].deletedAt);
    const state = await (
      await fetch(app.url + "/api/mcp/config", {
        headers: { "x-local-token": app.token },
      })
    ).json();
    assert.equal(state.enabled, false);
  },
);

test(
  "remembered MCP configuration cannot persist native session grants through a later canonical create",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "native-grant-boundary-"),
    );
    let app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const config = await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects: [],
          write: true,
          execute: false,
          remember: true,
        }),
      })
    ).json();
    const connect = async () => {
      const c = new Client(
        { name: "native-session-grants", version: "1" },
        { capabilities: {} },
      );
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
      return c;
    };
    let client = await connect();
    const native = decode(
      await client.callTool({
        name: "apipost_create_project",
        arguments: { name: "Native session" },
      }),
    );
    const canonical = decode(
      await client.callTool({
        name: "localapi_create_project",
        arguments: { name: "Remembered canonical" },
      }),
    );
    const listed = decode(
      await client.callTool({ name: "apipost_list_projects", arguments: {} }),
    );
    assert.deepEqual(
      new Set(listed.projects.map((p) => p.project_id)),
      new Set([native.project_id, canonical.id]),
    );
    await client.close();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    client = await connect();
    const restored = decode(
      await client.callTool({ name: "apipost_list_projects", arguments: {} }),
    );
    assert.deepEqual(
      restored.projects.map((p) => p.project_id),
      [canonical.id],
    );
    assert.equal(
      (
        await client.callTool({
          name: "apipost_list_apis",
          arguments: { project_id: native.project_id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (await app.store.get(native.project_id)).name,
      "Native session",
    );
  },
);
