import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan, runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
test("native WS TCP and POST SSE import persist restore execute and freeze plans", async (t) => {
  const seen = [],
    sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    seen.push({ type: "sse", url: req.url, method: req.method, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("id: 1\ndata: one\n\nid: 2\ndata: two\n\n");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (s, req) => {
    s.on("error", () => {});
    s.on("message", (b) => {
      seen.push({ type: "websocket", url: req.url, body: b.toString() });
      s.send(b.toString());
      s.close();
    });
  });
  const tcp = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("data", (b) => {
      seen.push({ type: "tcp", body: b.toString() });
      s.write(b);
    });
  });
  server.listen(0, "127.0.0.1");
  tcp.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(tcp, "listening")]);
  const root = await mkdtemp(path.join(tmpdir(), "native-wire-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    for (const s of sockets) s.destroy();
    for (const s of wss.clients) s.terminate();
    wss.close();
    server.closeAllConnections();
    app.server.closeAllConnections();
    await Promise.all([
      new Promise((r) => server.close(r)),
      new Promise((r) => tcp.close(r)),
      new Promise((r) => app.server.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const source = nativeProtocolFixture({
    ws: `ws://127.0.0.1:${server.address().port}/echo?x=one`,
    sse: `http://127.0.0.1:${server.address().port}/events?x=one`,
    tcp: `127.0.0.1:${tcp.address().port}`,
  });
  const original = JSON.stringify(source),
    p = await app.store.create("native protocol");
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const imported = await fetch(app.url + "/api/projects/" + p.id + "/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: source }),
  });
  const importedData = await imported.json();
  assert.equal(imported.status, 200, JSON.stringify(importedData));
  Object.assign(p, importedData);
  const saved = await new Store(root).get(p.id);
  assert.deepEqual(saved.protocols, p.protocols);
  const invalid = structuredClone(source);
  invalid.apis[3].method = "DELETE";
  const rejected = await fetch(app.url + "/api/projects/" + p.id + "/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: invalid }),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual((await app.store.get(p.id)).protocols, saved.protocols);
  const restore = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(restore.status, 201);
  const restored = await restore.json();
  assert.deepEqual(restored.protocols, saved.protocols);
  for (const current of [saved, restored])
    for (const definition of current.protocols) {
      const response = await fetch(
        app.url + "/api/projects/" + current.id + "/protocol",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ definitionId: definition.id }),
        },
      );
      assert.equal(response.status, 200, await response.text());
    }
  assert.equal(seen.length, 6);
  for (const wire of seen) {
    if (wire.type !== "tcp") assert.match(wire.url, /\?x=one$/);
    if (wire.type === "sse") {
      assert.equal(wire.method, "POST");
      assert.equal(wire.body, "fixture=synthetic");
    } else assert.equal(wire.body, "wire-payload");
  }
  for (const current of [saved, restored]) {
    const stored = await app.store.get(current.id);
    assert.equal(stored.protocolRuns.length, 3);
  }
  const plan = snapshotPlan({
    steps: saved.protocols.map((definition) => ({
      type: "protocol",
      protocol: { definition },
    })),
  });
  const run = await runPlan(
    plan,
    {},
    () => {
      throw Error("not HTTP API");
    },
    { executeProtocol: executeWireFlow },
  );
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(seen.length, 9);
  assert.equal(JSON.stringify(source), original);
});
