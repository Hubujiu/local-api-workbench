import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "debug-publication-"));
  const gates = new Map(),
    counts = new Map(),
    clients = [];
  const wire = http.createServer(async (req, res) => {
    const key = req.url.slice(1);
    counts.set(key, (counts.get(key) || 0) + 1);
    const gate = gates.get(key);
    if (gate) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: key }));
  });
  await new Promise((r) => wire.listen(0, "127.0.0.1", r));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    for (const gate of gates.values()) gate.release.resolve();
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    app.server.closeAllConnections();
    wire.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => wire.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Publication"),
    other = await app.store.create("Other");
  p.environments.push({
    ...structuredClone(p.environments[0]),
    id: "sibling",
    name: "Sibling",
  });
  const request = (key) => ({
    id: key,
    name: key,
    method: "GET",
    url: `http://127.0.0.1:${wire.address().port}/${key}`,
    extract: [{ name: "token", path: "$.token" }],
  });
  p.requests = ["old", "fast", "stdio", "scoped"].map(request);
  p.requests
    .find((r) => r.id === "scoped")
    .extract.push({ name: "saved", path: "$.token", scope: "environment" });
  await app.store.save(p);
  const call = async (id, action, method = "GET", data) => {
    const r = await fetch(`${app.url}/api/projects/${id}/${action}`, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const read = (id = p.id, environmentId = p.environments[0].id) =>
    call(id, `debug-variables?environmentId=${environmentId}`);
  const edit = async (
    variables,
    id = p.id,
    environmentId = p.environments[0].id,
  ) => {
    const value = await read(id, environmentId);
    await call(id, "debug-variables", "PUT", { ...value, variables });
  };
  const hold = (key) => {
    const gate = {
      arrived: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
    gates.set(key, gate);
    return gate;
  };
  const execute = (key, environmentId = p.environments[0].id, extra = {}) =>
    call(p.id, "execute", "POST", {
      request: request(key),
      environmentId,
      ...extra,
    });
  const connect = async (transport) => {
    const c = new Client(
      { name: "debug-publication", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(c);
    await c.connect(transport);
    return c;
  };
  return {
    app,
    root,
    p,
    other,
    counts,
    call,
    read,
    edit,
    hold,
    execute,
    connect,
  };
}
test(
  "owner delayed responses cannot overwrite edits or revive clear; own evidence survives",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    for (const mode of ["absent-clear", "edit", "same-value", "clear"]) {
      await f.call(f.p.id, "clear-session", "POST", {});
      if (mode !== "absent-clear") await f.edit({ token: "before" });
      const gate = f.hold(mode),
        running = f.execute(mode);
      await gate.arrived.promise;
      if (mode.endsWith("clear"))
        await f.call(f.p.id, "clear-session", "POST", {});
      else await f.edit({ token: mode === "edit" ? "edited" : "before" });
      gate.release.resolve();
      const result = await running;
      assert.equal(result.status, 200);
      assert.equal(result.extracted.token, mode);
      assert.equal(
        (await f.read()).variables.token,
        mode.endsWith("clear")
          ? undefined
          : mode === "edit"
            ? "edited"
            : "before",
      );
      assert.equal(f.counts.get(mode), 1);
    }
    const gate = f.hold("slow"),
      slow = f.execute("slow");
    await gate.arrived.promise;
    await f.execute("fast");
    gate.release.resolve();
    await slow;
    assert.equal((await f.read()).variables.token, "fast");
    await f.edit(
      { isolated: "other" },
      f.other.id,
      (await f.app.store.get(f.other.id)).environments[0].id,
    );
    const sibling = f.hold("sibling-result"),
      siblingRun = f.execute("sibling-result", "sibling");
    await sibling.arrived.promise;
    await f.edit({ token: "default-edit" });
    sibling.release.resolve();
    await siblingRun;
    assert.equal(
      (await f.read(f.p.id, "sibling")).variables.token,
      "sibling-result",
    );
    assert.equal(
      (
        await f.read(
          f.other.id,
          (await f.app.store.get(f.other.id)).environments[0].id,
        )
      ).variables.isolated,
      "other",
    );
    const exported = await f.call(f.p.id, "export");
    assert.equal(exported.environments[0].variables.token, undefined);
    assert.equal(exported.environments[1].variables.token, undefined);
    assert(exported.history.some((h) => h.response?.status === 200));
    // Execution history intentionally retains its own extracted/response evidence.
    f.app.server.closeAllConnections();
    await new Promise((r) => f.app.server.close(r));
    const restart = await createApp({ root: f.root, port: 0 });
    try {
      const r = await fetch(
        `${restart.url}/api/projects/${f.p.id}/debug-variables`,
        { headers: { "x-local-token": restart.token } },
      );
      assert.equal(r.status, 200);
      assert.equal((await r.json()).variables.token, undefined);
      const restoredResponse = await fetch(restart.url + "/api/restore", {
        method: "POST",
        headers: {
          "x-local-token": restart.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ document: exported }),
      });
      assert.equal(restoredResponse.status, 201);
      const restored = await restoredResponse.json();
      assert.notEqual(restored.id, f.p.id);
      const restoredRuntime = await fetch(
        `${restart.url}/api/projects/${restored.id}/debug-variables`,
        { headers: { "x-local-token": restart.token } },
      );
      assert.equal(restoredRuntime.status, 200);
      assert.equal((await restoredRuntime.json()).variables.token, undefined);
    } finally {
      restart.server.closeAllConnections();
      await new Promise((r) => restart.server.close(r));
    }
  },
);
test(
  "official HTTP SDK publication respects owner edits and first accepted concurrent result",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const r = await fetch(f.app.url + "/api/mcp/config", {
      method: "POST",
      headers: {
        "x-local-token": f.app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        projects: [f.p.id],
        write: true,
        execute: true,
        remember: false,
      }),
    });
    assert.equal(r.status, 200);
    const config = await r.json();
    const c = await f.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const run = (id) =>
      c
        .callTool({
          name: "localapi_execute_api",
          arguments: { projectId: f.p.id, apiId: id },
        })
        .then(decode);
    for (const clear of [false, true]) {
      const gate = f.hold("old"),
        pending = run("old");
      await gate.arrived.promise;
      if (clear) await f.call(f.p.id, "clear-session", "POST", {});
      else await f.edit({ token: "manual" });
      gate.release.resolve();
      const result = await pending;
      assert.equal(result.results[0].response.status, 200);
      assert.equal(result.variables.token, "old");
      assert.equal(
        (await f.read()).variables.token,
        clear ? undefined : "manual",
      );
    }
    const gate = f.hold("old"),
      pending = run("old");
    await gate.arrived.promise;
    assert.equal((await run("fast")).variables.token, "fast");
    gate.release.resolve();
    await pending;
    assert.equal((await f.read()).variables.token, "fast");
    assert.equal((await run("scoped")).variables.token, "scoped");
    const scoped = await f.read();
    assert.equal(scoped.variables.token, "scoped");
    assert.equal(scoped.variables.saved, "scoped");
    assert.equal(
      (await f.app.store.get(f.p.id)).environments[0].variables.saved,
      "scoped",
    );
    assert.equal(f.counts.get("old"), 3);
    assert.equal(f.counts.get("fast"), 1);
    assert.equal(
      (await f.app.store.get(f.p.id)).history.filter((h) => h.source === "mcp")
        .length,
      5,
    );
  },
);
test(
  "official stdio SDK keeps supported sequential runtime cache private and resets on restart",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const start = () =>
      f.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            f.p.id,
            "--execute",
            "--write",
          ],
          env: { LOCAL_API_DATA: f.root },
          stderr: "pipe",
        }),
      );
    const c = await start();
    const output = decode(
      await c.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: f.p.id, apiId: "stdio" },
      }),
    );
    assert.equal(output.variables.token, "stdio");
    const read = (client) =>
      client
        .callTool({
          name: "localapi_get_environment_variables",
          arguments: { projectId: f.p.id },
        })
        .then(decode);
    assert.equal((await read(c)).runtimeVariables.token, "stdio");
    assert.equal((await f.read()).variables.token, undefined);
    await c.close();
    const next = await start();
    assert.equal((await read(next)).runtimeVariables.token, undefined);
    assert.equal(f.counts.get("stdio"), 1);
    assert.equal(
      (await f.app.store.get(f.p.id)).environments[0].variables.token,
      undefined,
    );
  },
);

test(
  "owner cancellation and preflight failure retain later manual cache",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const gate = f.hold("cancelled"),
      pending = f.execute("cancelled", undefined, {
        runId: "cancel-publication",
      });
    await gate.arrived.promise;
    await f.edit({ token: "manual-after-start" });
    const r = await fetch(f.app.url + "/api/cancel", {
      method: "POST",
      headers: {
        "x-local-token": f.app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "cancel-publication" }),
    });
    assert.equal(r.status, 200);
    const result = await pending;
    gate.release.resolve();
    assert.equal(result.outcome, "failed");
    assert.equal((await f.read()).variables.token, "manual-after-start");
    const failure = await f.execute("unused", undefined, {
      request: { method: "GET", url: "http://127.0.0.1/{{missing}}" },
    });
    assert.match(failure.error, /missing/);
    assert.equal((await f.read()).variables.token, "manual-after-start");
    assert.equal(f.counts.get("cancelled"), 1);
    assert.equal(f.counts.has("unused"), false);
  },
);
