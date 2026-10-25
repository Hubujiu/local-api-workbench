import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureSSE, exchangeTCP } from "../src/protocols.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
import {
  prepareWireExecution,
  validateWireRecord,
} from "../src/wire-evidence.mjs";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
async function until(fn) {
  const end = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > end) throw Error("fixture deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const requests = [],
    sockets = new Set();
  let tcpCalls = 0;
  const tcp = net.createServer((s) => {
    sockets.add(s);
    tcpCalls++;
    s.on("close", () => sockets.delete(s));
    s.on("data", (data) => {
      if (data.toString() !== "silent") s.write(data);
    }); // deliberately no EOF
  });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const b of req) chunks.push(b);
    requests.push({
      method: req.method,
      body: Buffer.concat(chunks).toString(),
      url: req.url,
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "id: 1\nevent: fixture\ndata: first\n\nid: 2\nevent: fixture\ndata: second\n\n",
    );
  });
  tcp.listen(0, "127.0.0.1");
  server.listen(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(server, "listening")]);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => tcp.close(r)),
      new Promise((r) => server.close(r)),
    ]);
  });
  return {
    requests,
    tcpCalls: () => tcpCalls,
    sockets,
    tcp: {
      id: "tcp",
      type: "tcp",
      url: "127.0.0.1",
      port: tcp.address().port,
      message: { encoding: "hex", data: "00ff" },
      completion: "first-data",
    },
    sse: {
      id: "sse",
      type: "sse",
      url: `http://127.0.0.1:${server.address().port}/events?fixture=independent`,
      method: "POST",
      body: "fictional=雪&value=1",
    },
  };
}
test("saved POST SSE and first-data TCP execute, preserve evidence, restore and isolate projects", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "wire-semantics-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("protocol semantics"),
    other = await app.store.create("isolated");
  p.protocols = [f.sse, f.tcp].map(normalizeProtocol);
  await app.store.save(p);
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = (id, body) =>
    fetch(app.url + "/api/projects/" + id + "/protocol", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  for (const definitionId of ["sse", "tcp"]) {
    const r = await post(p.id, { definitionId, duration: 1000 });
    const result = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
  }
  assert.deepEqual(f.requests, [
    { method: "POST", body: f.sse.body, url: "/events?fixture=independent" },
  ]);
  const saved = await new Store(root).get(p.id);
  assert.equal(saved.protocolRuns.length, 2);
  for (const record of saved.protocolRuns) validateWireRecord(record);
  const tcp = saved.protocolRuns.find((r) => r.type === "tcp");
  assert.equal(tcp.result.base64, "AP8=");
  assert.equal(tcp.result.timedOut, false);
  assert.equal(
    saved.protocolRuns.find((r) => r.type === "sse").definition.body,
    f.sse.body,
  );
  assert.equal((await post(other.id, { definitionId: "sse" })).status, 400);
  for (const replacement of [
    { method: "GET" },
    { body: "replacement" },
    { completion: "end" },
  ])
    assert.equal(
      (await post(p.id, { definitionId: "sse", ...replacement })).status,
      400,
    );
  assert.equal(f.requests.length, 1);
  const response = await fetch(app.url + "/api/restore", {
    method: "POST",
    headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(response.status, 201);
  const restored = await response.json();
  assert.deepEqual(restored.protocols, saved.protocols);
  assert.deepEqual(restored.protocolRuns, saved.protocolRuns);
});
test("frozen plan carries POST body and TCP completion without definition drift", async (t) => {
  const f = await fixture(t),
    plan = snapshotPlan({
      steps: [
        { type: "protocol", protocol: { definition: f.sse } },
        { type: "protocol", protocol: { definition: f.tcp } },
      ],
    });
  f.sse.body = "changed";
  f.tcp.completion = "end";
  const run = await runPlan(
    plan,
    {},
    async () => {
      throw Error("HTTP executor should not run");
    },
    { executeProtocol: executeWireFlow },
  );
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(f.requests[0].body, "fictional=雪&value=1");
  assert.equal(run.results[1].protocolResult.result.timedOut, false);
});
test("SSE session sends identical POST input and existing GET remains GET", async (t) => {
  const f = await fixture(t),
    sessions = new ProtocolSessions();
  t.after(() => sessions.close());
  const session = sessions.start({ ...f.sse, duration: 1000 });
  await until(() => sessions.snapshot(session.id).state === "closed");
  const result = sessions.snapshot(session.id);
  assert.equal(result.totalEvents, 2);
  assert.equal(result.events[1].data, "event: fixture\nid: 2\ndata: second");
  const get = await captureSSE({ url: f.sse.url });
  assert.equal(get.events.length, 2);
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["POST", "GET"],
  );
  assert.equal(f.requests[0].body, f.sse.body);
});
test("invalid options fail before transport; TCP first-data retains timeout and cancellation guards", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { method: "PUT" },
    { method: "GET", body: "" },
    { method: "POST", body: "x".repeat(65537) },
    { method: "POST", body: "\ud800" },
  ]) {
    assert.throws(() => normalizeProtocol({ ...f.sse, ...extra }));
    await assert.rejects(captureSSE({ url: f.sse.url, ...extra }));
  }
  assert.equal(f.requests.length, 0);
  assert.throws(() => normalizeProtocol({ ...f.tcp, completion: "anything" }));
  assert.throws(() => normalizeProtocol({ ...f.tcp, method: "POST" }));
  const input = {
    host: f.tcp.url,
    port: f.tcp.port,
    message: "silent",
    completion: "first-data",
    duration: 100,
  };
  await assert.rejects(exchangeTCP(input), /超时/);
  const controller = new AbortController(),
    pending = exchangeTCP({ ...input, duration: 1000 }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /取消/);
  const end = await exchangeTCP({
    ...input,
    message: "partial",
    completion: "end",
  });
  assert.equal(end.timedOut, true);
  assert.equal(end.partial, true);
  assert.throws(() =>
    prepareWireExecution(
      {},
      { type: "sse", url: f.sse.url, completion: "first-data" },
    ),
  );
});
