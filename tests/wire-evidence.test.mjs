import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";
import { validateWireRecord } from "../src/wire-evidence.mjs";
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("history fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "wire-history-")),
    app = await createApp({ root, port: 0 });
  let tcpCalls = 0,
    hold = false;
  const sockets = new Set(),
    tcp = net.createServer((s) => {
      tcpCalls++;
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("data", (data) => {
        if (!hold) s.end(data);
      });
    });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-ephemeral");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("id: one\ndata: saved-event\n\n");
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on("connection", (ws, req) => {
    assert.equal(req.headers.authorization, "Bearer fixture-ephemeral");
    ws.on("error", () => {});
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => tcp.close(r));
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("protocol history"),
    other = await app.store.create("other");
  p.protocols = [
    {
      id: "tcp",
      type: "tcp",
      url: "127.0.0.1",
      port: tcp.address().port,
      message: { encoding: "hex", data: "00ff" },
    },
    {
      id: "ws",
      type: "websocket",
      url: `ws://127.0.0.1:${server.address().port}`,
      message: { encoding: "hex", data: "00ff" },
    },
    {
      id: "sse",
      type: "sse",
      url: `http://127.0.0.1:${server.address().port}`,
    },
  ];
  await app.store.save(p);
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = (body, id = p.id) =>
    fetch(app.url + "/api/projects/" + id + "/protocol", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return {
    app,
    root,
    p,
    other,
    headers,
    post,
    calls: () => tcpCalls,
    setHold(value) {
      hold = value;
    },
    socketCount: () => sockets.size,
  };
}
const call = (name, args) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});
test("TCP/WebSocket/SSE execution records persist, restore and remain project-scoped through read-only MCP", async (t) => {
  const f = await fixture(t);
  const records = [];
  for (const [definitionId, extra] of [
    ["tcp", {}],
    [
      "ws",
      {
        headers: { Authorization: "Bearer fixture-ephemeral" },
        maxMessages: 1,
      },
    ],
    ["sse", { headers: { Authorization: "Bearer fixture-ephemeral" } }],
  ]) {
    const response = await f.post({ definitionId, ...extra }),
      result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.recordSaved, true, JSON.stringify(result));
    records.push(result.recordId);
  }
  const saved = await new Store(f.root).get(f.p.id);
  assert.equal(saved.protocolRuns.length, 3);
  assert(!JSON.stringify(saved).includes("fixture-ephemeral"));
  for (const record of saved.protocolRuns) validateWireRecord(record);
  const ws = saved.protocolRuns.find((r) => r.type === "websocket");
  assert.deepEqual(ws.options.headerNames, ["authorization"]);
  assert.deepEqual(ws.options.requestedProtocols, []);
  assert.equal(ws.options.tlsMode, "default");
  const tcp = saved.protocolRuns.find((r) => r.type === "tcp");
  assert.equal(tcp.status, "completed");
  assert.equal(tcp.result.base64, "AP8=");
  assert.equal(tcp.result.body, undefined);
  assert.equal(
    saved.protocolRuns.find((r) => r.type === "websocket").status,
    "partial",
  );
  assert.equal(
    saved.protocolRuns.find((r) => r.type === "sse").status,
    "completed",
  );
  const httpResult = await fetch(
    f.app.url + "/api/projects/" + f.p.id + "/protocol-runs?type=tcp",
    { headers: f.headers },
  );
  assert.equal((await httpResult.json()).length, 1);
  const d = createMCP({ store: f.app.store, projects: [f.p.id] });
  const list = await d(
    call("localapi_list_protocol_runs", { projectId: f.p.id }),
  );
  const summaries = JSON.parse(list.result.content[0].text);
  assert.equal(summaries.length, 3);
  assert(!JSON.stringify(summaries).includes("saved-event"));
  const detail = await d(
    call("localapi_get_protocol_run", {
      projectId: f.p.id,
      recordId: records[0],
    }),
  );
  assert.equal(JSON.parse(detail.result.content[0].text).id, records[0]);
  assert.equal(
    (
      await d(
        call("localapi_get_protocol_run", {
          projectId: f.other.id,
          recordId: records[0],
        }),
      )
    ).result.isError,
    true,
  );
  const tools = await d({ id: 2, method: "tools/list" });
  assert(!tools.result.tools.some((x) => x.name === "localapi_run_plan"));
  assert.equal(f.calls(), 1);
  const restoredResponse = await fetch(f.app.url + "/api/restore", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ document: saved }),
  });
  assert.equal(restoredResponse.status, 201);
  const restored = await restoredResponse.json();
  assert.notEqual(restored.id, f.p.id);
  assert.deepEqual(restored.protocolRuns, saved.protocolRuns);
  const reordered = JSON.parse(
    JSON.stringify(tcp, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .reverse()
              .map((key) => [key, v[key]]),
          )
        : v,
    ),
  );
  assert.doesNotThrow(() => validateWireRecord(reordered));
  for (const mutate of [
    (r) => (r.definition.url = "changed"),
    (r) => (r.result.base64 = "AAAA"),
    (r) => (r.resultHash = "0".repeat(64)),
    (r) => (r.headers = { Authorization: "must-not-persist" }),
  ]) {
    const bad = structuredClone(tcp);
    mutate(bad);
    assert.throws(() => validateWireRecord(bad));
  }
  const before = f.calls();
  const malformed = await f.post({ definitionId: "tcp", message: null });
  assert.equal(malformed.ok, false);
  assert.equal(f.calls(), before);
  const override = await f.post({ definitionId: "tcp", host: "other.fixture" });
  assert.equal(override.ok, false);
  assert.equal(f.calls(), before);
  const foreign = await f.post({ definitionId: "tcp" }, f.other.id);
  assert.equal(foreign.ok, false);
  assert.equal(f.calls(), before);
});
test("protocol failure/cancellation persists honestly and disk failure never replays network traffic", async (t) => {
  const f = await fixture(t);
  const closed = net.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const failed = await f.post({
      type: "tcp",
      host: "127.0.0.1",
      port,
      message: "x",
    }),
    failure = await failed.json();
  assert.equal(failed.ok, false);
  assert.equal(failure.recordSaved, true, JSON.stringify(failure));
  const failedRecord = (await f.app.store.get(f.p.id)).protocolRuns.find(
    (r) => r.id === failure.recordId,
  );
  assert.equal(failedRecord.status, "failed");
  assert.equal(failedRecord.result, null);
  f.setHold(true);
  const pending = f.post({
    definitionId: "tcp",
    runId: "cancel-recorded-tcp",
    duration: 30000,
  });
  await until(() => f.calls() === 1);
  await fetch(f.app.url + "/api/cancel", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ id: "cancel-recorded-tcp" }),
  });
  const stopped = await pending,
    cancelled = await stopped.json();
  assert.equal(stopped.ok, false);
  assert.equal(cancelled.recordSaved, true, JSON.stringify(cancelled));
  assert.equal(
    (await f.app.store.get(f.p.id)).protocolRuns.find(
      (r) => r.id === cancelled.recordId,
    ).status,
    "cancelled",
  );
  await until(() => f.socketCount() === 0);
  f.setHold(false);
  const append = f.app.store.append.bind(f.app.store),
    before = (await f.app.store.get(f.p.id)).protocolRuns.length;
  f.app.store.append = async (...args) => {
    if (args[1] === "protocolRuns") throw Error("fixture disk unavailable");
    return append(...args);
  };
  const response = await f.post({ definitionId: "tcp" }),
    result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.base64, "AP8=");
  assert.equal(result.recordSaved, false);
  assert.equal(result.recordId, null);
  assert.equal(result.persistenceOutcome.code, "RECORD_SAVE_FAILED");
  assert.doesNotMatch(result.persistenceError, /disk unavailable/);
  assert.equal(f.calls(), 2);
  assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, before);
});

test("protocol history retains only the latest fifty actual executions and rejects corrupt restore atomically", async (t) => {
  const f = await fixture(t),
    ids = [];
  for (let i = 0; i < 51; i++) {
    const response = await f.post({
        definitionId: "tcp",
        message: {
          format: "delimited",
          delimiter: "|",
          fields: [String(i), "record"],
        },
      }),
      result = await response.json();
    assert.equal(result.recordSaved, true, JSON.stringify(result));
    ids.push(result.recordId);
  }
  const saved = await new Store(f.root).get(f.p.id);
  assert.equal(f.calls(), 51);
  assert.equal(saved.protocolRuns.length, 50);
  assert.equal(saved.protocolRuns[0].id, ids[50]);
  assert(!saved.protocolRuns.some((r) => r.id === ids[0]));
  assert.deepEqual(saved.protocols[0].message, {
    encoding: "hex",
    data: "00ff",
  });
  const count = (await f.app.store.list()).length,
    bad = structuredClone(saved);
  bad.protocolRuns[0].resultHash = "0".repeat(64);
  const response = await fetch(f.app.url + "/api/restore", {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ document: bad }),
  });
  assert.equal(response.ok, false);
  assert.equal((await f.app.store.list()).length, count);
  assert.deepEqual(
    (await f.app.store.get(f.p.id)).protocolRuns,
    saved.protocolRuns,
  );
});
test("oversized serialized SSE evidence is reported unsaved without replay or fabricated truncation", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const stream = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + "\0".repeat(600000) + "\n\n");
  });
  stream.listen(0, "127.0.0.1");
  await once(stream, "listening");
  t.after(async () => {
    stream.closeAllConnections();
    await new Promise((r) => stream.close(r));
  });
  const response = await f.post({
      type: "sse",
      url: `http://127.0.0.1:${stream.address().port}`,
    }),
    result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.events[0].data.length, 600000);
  assert.equal(result.recordSaved, false);
  assert.equal(result.persistenceOutcome.code, "RECORD_SAVE_FAILED");
  assert.doesNotMatch(result.persistenceError, /3MiB/);
  assert.equal(requests, 1);
  assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 0);
});
