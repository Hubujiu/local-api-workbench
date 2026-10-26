import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
test(
  "SDK native API preserves own scripts/auth/body and completed evidence when storage fails, without replay",
  { timeout: 20000 },
  async (t) => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen.push({
        body,
        authorization: req.headers.authorization,
        url: req.url,
      });
      res.statusCode = req.url.includes("created") ? 201 : 200;
      res.setHeader("content-type", "application/json");
      res.end('{"value":"received"}');
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(os.tmpdir(), "native-api-")),
      app = await createApp({ root, port: 0 });
    const client = new Client(
      { name: "native-api-fixture", version: "1" },
      { capabilities: {} },
    );
    t.after(async () => {
      await client.close();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("API"),
      other = await app.store.create("Other");
    p.requests = [
      normalizeRequest({
        id: "api",
        name: "Echo",
        method: "POST",
        url: `http://127.0.0.1:${server.address().port}/echo`,
        bodyType: "json",
        body: '{"old":1}',
        auth: { type: "bearer", token: "old" },
        scriptDialect: "apipost8",
        beforeScript:
          'apt.request.headers.upsert({key:"X-Fixture",value:"script"});',
        afterScript: 'apt.environment.set("persisted", "after");',
        assertions: [{ target: "status", op: "eq", value: 201 }],
      }),
    ];
    await app.store.save(p);
    const cfg = await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        projects: [p.id],
        write: true,
        execute: true,
        remember: false,
      }),
    });
    assert.equal(cfg.status, 200);
    const config = await cfg.json();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const call = (args) =>
      client.callTool({ name: "apipost_execute_api", arguments: args });
    const args = {
      project_id: p.id,
      target_id: "api",
      input: {
        body: { replacement: true },
        auth: { type: "bearer", bearer: { key: "override" } },
      },
    };
    assert.equal((await call({ ...args, project_id: other.id })).isError, true);
    assert.equal((await call({ ...args, environment_id: " " })).isError, true);
    assert.equal(seen.length, 0);
    const run = decode(await call(args));
    assert.equal(run.scope, "api");
    assert.equal(run.status, "failed");
    assert.equal(run.record_saved, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, "Bearer override");
    assert.deepEqual(JSON.parse(seen[0].body), { replacement: true });
    let saved = await app.store.get(p.id);
    assert.equal(saved.history[0].id, run.run_id);
    assert.equal(saved.history[0].environmentId, p.environments[0].id);
    assert.equal(saved.environments[0].variables.persisted, "after");
    assert.equal(saved.requests[0].auth.token, "old");
    assert.equal(saved.requests[0].body, '{"old":1}');
    saved.requests[0].assertions = [];
    saved.requests[0].url += "/created";
    await app.store.save(saved);
    const created = decode(await call(args));
    assert.equal(created.status, "failed");
    assert.equal(created.failed[0].status_code, 201);
    const canonical = decode(
      await client.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: p.id, apiId: "api" },
      }),
    );
    assert.equal(canonical.status, "passed");
    const append = app.store.append.bind(app.store);
    app.store.append = async (id, key, value) => {
      if (key === "history") throw Error("private/path/secret");
      return append(id, key, value);
    };
    const unsaved = decode(await call(args));
    assert.equal(unsaved.record_saved, false);
    assert.equal(unsaved.scope, "api");
    assert.ok(unsaved.run_id);
    assert.equal(seen.length, 4);
    assert.doesNotMatch(JSON.stringify(unsaved), /private\/path\/secret/);
    saved = await app.store.get(p.id);
    assert.equal(saved.history.length, 3);
  },
);

test(
  "API freezes selected environment across a concurrent switch and script scope commit",
  { timeout: 20000 },
  async (t) => {
    const { Store } = await import("../src/runtime.mjs");
    const { createMCP } = await import("../src/mcp.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "native-api-isolation-"));
    const store = new Store(root),
      p = await store.create("Isolation"),
      cache = new Map();
    const a = p.environments[0].id;
    p.environments[0].variables = { marker: "A" };
    p.environments.push({ id: "B", name: "B", variables: { marker: "B" } });
    p.currentEnvironmentId = a;
    let entered, release;
    const reached = new Promise((r) => (entered = r)),
      gate = new Promise((r) => (release = r));
    const server = http.createServer(async (req, res) => {
      entered();
      await gate;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      release();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    p.requests = [
      normalizeRequest({
        id: "api",
        name: "Isolation",
        url: `http://127.0.0.1:${server.address().port}/`,
        scriptDialect: "apipost8",
        afterScript: 'apt.environment.set("written", "A-only");',
      }),
    ];
    await store.save(p);
    const dispatch = createMCP({
      store,
      projects: [p.id],
      write: true,
      execute: true,
      debugEnvironments: cache,
    });
    const pending = dispatch({
      id: 1,
      method: "tools/call",
      params: {
        name: "apipost_execute_api",
        arguments: { project_id: p.id, target_id: "api" },
      },
    });
    await reached;
    const changed = await store.get(p.id);
    changed.currentEnvironmentId = "B";
    await store.save(changed);
    release();
    const output = decode((await pending).result);
    assert.equal(output.status, "passed");
    const saved = await store.get(p.id);
    assert.equal(saved.currentEnvironmentId, "B");
    assert.equal(saved.environments[0].variables.written, "A-only");
    assert.equal(saved.environments[1].variables.written, undefined);
    assert.equal(cache.has(p.id + ":B"), false);
    assert.equal(cache.get(p.id + ":" + a).variables.marker, "A");
    assert.equal(saved.history[0].environmentId, a);
  },
);
