import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("run fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("protocol, debug HTTP and load run IDs cannot overwrite each other's cancellation controller", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "run-id-scope-")),
    app = await createApp({ root, port: 0 }),
    p = await app.store.create("one"),
    other = await app.store.create("two");
  let tcpCalls = 0,
    httpCalls = 0;
  const sockets = new Set(),
    tcp = net.createServer((s) => {
      tcpCalls++;
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("data", () => {});
    });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const httpServer = http.createServer((_req, res) => {
    httpCalls++;
    res.end("ok");
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => tcp.close(r));
    httpServer.closeAllConnections();
    await new Promise((r) => httpServer.close(r));
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = (endpoint, body, id = p.id) =>
    fetch(app.url + "/api/projects/" + id + "/" + endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const input = {
    type: "tcp",
    host: "127.0.0.1",
    port: tcp.address().port,
    message: "hold",
    duration: 30000,
    runId: "shared-active-id",
  };
  const pending = post("protocol", input);
  await until(() => tcpCalls === 1);
  const request = {
    method: "GET",
    url: `http://127.0.0.1:${httpServer.address().port}/`,
  };
  for (const [endpoint, body] of [
    ["protocol", input],
    ["execute", { request, runId: input.runId }],
    ["load", { request, runId: input.runId, count: 1, concurrency: 1 }],
  ]) {
    const denied = await post(endpoint, body, other.id);
    assert.equal(denied.ok, false);
    assert.match((await denied.json()).error, /正在使用/);
  }
  assert.equal(httpCalls, 0);
  assert.equal(tcpCalls, 1);
  const cancelled = await fetch(app.url + "/api/cancel", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: input.runId }),
  });
  assert.equal(cancelled.ok, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match((await result.json()).error, /取消/);
  const reused = await post("execute", { request, runId: input.runId });
  assert.equal(reused.ok, true);
  assert.equal(httpCalls, 1);
  for (const endpoint of ["protocol", "execute", "load"]) {
    const bad = await post(endpoint, {
      ...input,
      request,
      runId: { bad: true },
      count: 1,
      concurrency: 1,
    });
    assert.equal(bad.ok, false);
    assert.match((await bad.json()).error, /标识无效/);
  }
  for (const type of ["constructor", "toString", "__proto__"]) {
    const bad = await post("protocol", { ...input, type });
    assert.equal(bad.ok, false);
    assert.match((await bad.json()).error, /未知协议/);
  }
  assert.equal(tcpCalls, 1);
  assert.equal(httpCalls, 1);
});
