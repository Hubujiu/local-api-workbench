import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("wire plan fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const sockets = new Set();
  let tcpCalls = 0,
    httpCalls = 0,
    hold = false;
  const tcp = net.createServer((s) => {
    sockets.add(s);
    tcpCalls++;
    s.on("close", () => sockets.delete(s));
    s.on("data", (b) => {
      if (!hold) s.end(b);
    });
  });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const httpServer = http.createServer((req, res) => {
    httpCalls++;
    if (req.url === "/events") {
      if (req.headers.authorization !== "Bearer plan-fixture") {
        res.writeHead(403);
        res.end("denied");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: event-value\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url }));
    }
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== "Bearer plan-fixture") {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("message", (b, binary) => ws.send(b, { binary }));
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => tcp.close(r));
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    httpServer.closeAllConnections();
    await new Promise((r) => httpServer.close(r));
  });
  return {
    tcp: { type: "tcp", url: "127.0.0.1", port: tcp.address().port },
    sse: {
      type: "sse",
      url: `http://127.0.0.1:${httpServer.address().port}/events`,
    },
    ws: {
      type: "websocket",
      url: `ws://127.0.0.1:${httpServer.address().port}`,
    },
    http: `http://127.0.0.1:${httpServer.address().port}`,
    tcpCalls: () => tcpCalls,
    httpCalls: () => httpCalls,
    hold(v) {
      hold = v;
    },
  };
}
test("native protocol fixed plan retains real outcomes and extracts TCP bytes into a subsequent actual HTTP step", async (t) => {
  const f = await fixture(t),
    plan = snapshotPlan({
      steps: [
        {
          id: "wire",
          type: "protocol",
          protocol: { definition: f.tcp, message: "{{input}}" },
          assertions: [{ target: "$.body", op: "eq", value: "wire-value" }],
          extract: [{ name: "wireValue", path: "$.body" }],
        },
        {
          request: {
            method: "GET",
            url: f.http + "/{{wireValue}}",
            assertions: [{ target: "$.url", op: "eq", value: "/wire-value" }],
          },
        },
      ],
    });
  const run = await runPlan(plan, { input: "wire-value" }, executeRequest, {
    executeProtocol: executeWireFlow,
  });
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.results[0].response, undefined);
  assert.equal(run.results[0].protocolResult.status, "completed");
  assert.equal(run.variables.wireValue, "wire-value");
  assert.equal(f.tcpCalls(), 1);
  assert.equal(f.httpCalls(), 1);
  const denied = await runPlan(plan, { input: "wire-value" }, async () => ({
    status: 200,
    headers: {},
    body: "{}",
  }));
  assert.equal(denied.results[0].status, "failed");
  assert.match(denied.results[0].error, /未授权/);
  assert.equal(f.tcpCalls(), 1);
});
test("SSE/WebSocket scoped credentials are ephemeral and invalid maps fail before any earlier side effect", async (t) => {
  const f = await fixture(t),
    plan = snapshotPlan({
      steps: [
        {
          id: "sse",
          type: "protocol",
          protocol: { definition: f.sse },
          extract: [{ name: "event", path: "$.events[0].data" }],
        },
        {
          id: "ws",
          type: "protocol",
          protocol: { definition: f.ws, message: "{{event}}", maxMessages: 1 },
          expectedStatus: "partial",
          assertions: [
            { target: "$.messages[0].data", op: "eq", value: "event-value" },
          ],
        },
      ],
    });
  const credentials = {
    sse: { headers: { Authorization: "Bearer plan-fixture" } },
    ws: { headers: { Authorization: "Bearer plan-fixture" } },
  };
  const run = await runPlan(plan, {}, executeRequest, {
    executeProtocol: executeWireFlow,
    protocolCredentials: credentials,
  });
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.results[1].protocolResult.status, "partial");
  assert(!JSON.stringify(run).includes("Bearer plan-fixture"));
  const [authorized, rejected] = await Promise.all([
    runPlan(plan, {}, executeRequest, {
      executeProtocol: executeWireFlow,
      protocolCredentials: credentials,
    }),
    runPlan(plan, {}, executeRequest, {
      executeProtocol: executeWireFlow,
      protocolCredentials: {
        sse: { headers: { Authorization: "Bearer wrong" } },
        ws: { headers: { Authorization: "Bearer wrong" } },
      },
    }),
  ]);
  assert.equal(authorized.status, "passed");
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.variables.event, undefined);

  const missing = await runPlan(plan, {}, executeRequest, {
    executeProtocol: executeWireFlow,
  });
  assert.equal(missing.status, "failed");
  assert.equal(missing.variables.event, undefined);
  const before = f.httpCalls(),
    withFirst = snapshotPlan({
      steps: [
        { request: { method: "GET", url: f.http } },
        { id: "sse", type: "protocol", protocol: { definition: f.sse } },
      ],
    });
  await assert.rejects(
    runPlan(withFirst, {}, executeRequest, {
      executeProtocol: executeWireFlow,
      protocolCredentials: { sse: { url: "http://other.fixture" } },
    }),
    /覆盖端点/,
  );
  assert.equal(f.httpCalls(), before);
  assert.throws(
    () =>
      snapshotPlan({
        steps: [
          {
            type: "protocol",
            protocol: {
              definition: f.tcp,
              headers: { Authorization: "cannot-save" },
            },
          },
        ],
      }),
    /凭据/,
  );
});
test("native protocol plan cancellation stops remaining steps and outcome defaults do not treat timeout as success", async (t) => {
  const f = await fixture(t);
  f.hold(true);
  const plan = snapshotPlan({
    steps: [
      {
        type: "protocol",
        protocol: { definition: f.tcp, message: "hold", duration: 30000 },
      },
      { request: { method: "GET", url: f.http } },
    ],
  });
  const controller = new AbortController(),
    pending = runPlan(plan, {}, executeRequest, {
      executeProtocol: executeWireFlow,
      signal: controller.signal,
    });
  await until(() => f.tcpCalls() === 1);
  controller.abort();
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.equal(run.results.length, 1);
  assert.equal(f.httpCalls(), 0);
  const timeout = snapshotPlan({
    steps: [
      {
        type: "protocol",
        protocol: { definition: f.tcp, message: "hold", duration: 100 },
      },
    ],
  });
  const failed = await runPlan(timeout, {}, executeRequest, {
    executeProtocol: executeWireFlow,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.results[0].protocolResult.status, "failed");
});
test("HTTP, execution-authorized MCP and CLI reuse frozen project protocol plans with durable evidence", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "wire-plan-entry-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("plans");
  p.protocols = [{ ...f.tcp, id: "tcp-definition", message: "frozen" }];
  await app.store.save(p);
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = async (action, body) => {
    const r = await fetch(app.url + "/api/projects/" + p.id + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  };
  const plan = await post("plans", {
    steps: [
      {
        id: "wire",
        type: "protocol",
        protocol: { definitionId: "tcp-definition" },
        extract: [{ name: "fromWire", path: "$.body" }],
      },
      { request: { method: "GET", url: f.http + "/{{fromWire}}" } },
    ],
  });
  const modified = await app.store.get(p.id);
  modified.protocols[0].message = "changed";
  modified.protocols[0].port = 1;
  await app.store.save(modified);
  const first = await post("run", { planId: plan.id });
  assert.equal(first.status, "passed");
  assert.equal(first.variables.fromWire, "frozen");
  assert.equal(first.recordSaved, true);
  const call = (name, args) => ({
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const readonly = createMCP({ store: app.store, projects: [p.id] });
  assert.equal(
    (
      await readonly(
        call("localapi_run_plan", { projectId: p.id, planId: plan.id }),
      )
    ).result.isError,
    true,
  );
  const mcp = createMCP({
    store: app.store,
    projects: [p.id],
    write: true,
    execute: true,
  });
  const result = await mcp(
    call("localapi_run_plan", { projectId: p.id, planId: plan.id }),
  );
  assert.equal(result.result.isError, undefined, result.result.content[0].text);
  assert.equal(JSON.parse(result.result.content[0].text).status, "passed");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["scripts/run-plan.mjs", "--project", p.id, "--plan", plan.id],
    {
      env: { ...process.env, LOCAL_API_DATA: root },
      timeout: 10000,
      maxBuffer: 3 * 1024 * 1024,
    },
  );
  assert.equal(JSON.parse(stdout).status, "passed");
  const reloaded = await new Store(root).get(p.id);
  assert.equal(reloaded.runs.length, 3);
  assert(
    reloaded.runs.every(
      (run) => run.results[0].protocolResult.status === "completed",
    ),
  );
});

test("protocol plan static payload validation and shared HTTP execution limit fail closed", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      snapshotPlan({
        steps: [
          {
            type: "protocol",
            protocol: {
              definition: f.tcp,
              message: { encoding: "hex", data: "bad" },
            },
          },
        ],
      }),
    /十六进制/,
  );
  const root = await mkdtemp(path.join(tmpdir(), "wire-plan-limit-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("limit");
  const headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    },
    post = (action, body) =>
      fetch(app.url + "/api/projects/" + p.id + "/" + action, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
  const planned = await post("plans", {
      steps: [
        {
          type: "protocol",
          protocol: { definition: f.tcp, message: "hold", duration: 30000 },
        },
      ],
    }),
    plan = await planned.json();
  assert.equal(planned.status, 200);
  f.hold(true);
  const pending = Array.from({ length: 5 }, (_, i) =>
    post("run", { planId: plan.id, runId: "wire-slot-" + i }),
  );
  try {
    await until(() => f.tcpCalls() === 5);
    const denied = await post("protocol", {
      type: "tcp",
      host: f.tcp.url,
      port: f.tcp.port,
      message: "must not send",
    });
    assert.equal(denied.ok, false);
    assert.match((await denied.json()).error, /最多同时执行5/);
    assert.equal(f.tcpCalls(), 5);
  } finally {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(app.url + "/api/cancel", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "wire-slot-" + i }),
        }),
      ),
    );
    const stopped = await Promise.all(pending);
    for (const response of stopped)
      assert.equal((await response.json()).status, "cancelled");
  }
  f.hold(false);
  const next = await post("run", { planId: plan.id });
  assert.equal((await next.json()).status, "passed");
  assert.equal(f.tcpCalls(), 6);
});
