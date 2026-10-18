import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
test("MCP persistence is explicit, retains endpoint on restart and rotation revokes the old key", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-persist-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Persist");
  const configure = async (data) =>
    await (
      await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      })
    ).json();
  const config = {
    enabled: true,
    remember: true,
    projects: [project.id],
    write: false,
    execute: false,
  };
  const first = await configure(config),
    address = app.url;
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  assert.equal(app.url, address);
  const restored = await (
    await fetch(app.url + "/api/mcp/config", {
      headers: { "x-local-token": app.token },
    })
  ).json();
  assert.equal(restored.token, first.token);
  assert.equal(restored.enabled, true);
  const rotated = await configure({ ...config, rotate: true });
  assert.notEqual(rotated.token, first.token);
  const old = await fetch(app.url + "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer " + first.token },
    body: "{}",
  });
  assert.equal(old.status, 403);
  await configure({ ...config, enabled: false });
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  assert.equal(
    (
      await (
        await fetch(app.url + "/api/mcp/config", {
          headers: { "x-local-token": app.token },
        })
      ).json()
    ).enabled,
    false,
  );
});

test("occupied remembered port fails closed for MCP but keeps the workbench usable", async (t) => {
  const http = await import("node:http");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-port-"));
  let app = await createApp({ root, port: 0 });
  const port = app.server.address().port;
  await fetch(app.url + "/api/mcp/config", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, remember: true, projects: [] }),
  });
  await new Promise((resolve) => app.server.close(resolve));
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(port, "127.0.0.1", resolve));
  app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => occupied.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  assert.notEqual(app.server.address().port, port);
  const config = await (
    await fetch(app.url + "/api/mcp/config", {
      headers: { "x-local-token": app.token },
    })
  ).json();
  assert.equal(config.enabled, false);
  assert.equal(config.token, "");
  assert.match(config.warning, /端口/);
});
