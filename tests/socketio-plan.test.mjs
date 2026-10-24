import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "socket.io";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { createMCP } from "../src/mcp.mjs";
async function fixture(t, requireAuth = true) {
  const server = http.createServer((req, res) =>
    res.end(JSON.stringify({ url: req.url })),
  );
  const io = new Server(server);
  const seen = [];
  let connections = 0;
  io.use((s, next) =>
    !requireAuth || s.handshake.auth.token === "fixture-token"
      ? next()
      : next(Error("denied")),
  );
  io.on("connection", (s) => {
    connections++;
    s.emit("welcome", { ready: true });
    s.on("echo", (v, ack) => {
      seen.push(v);
      s.emit("answer", v);
      ack?.(v);
    });
    s.on("no-ack", () => seen.push("once"));
    s.on("big", (ack) => {
      seen.push("big");
      ack("x".repeat(700000));
    });
    s.on("ask", () =>
      s.emit("question", { value: 7 }, (answer) => seen.push(answer)),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => io.close(r)));
  return {
    seen,
    get connections() {
      return connections;
    },
    url: `http://127.0.0.1:${server.address().port}`,
    definition: {
      id: "socket",
      name: "Socket.IO",
      url: `http://127.0.0.1:${server.address().port}`,
    },
  };
}
const command = (definition) => ({
  id: "socket-step",
  type: "socketio",
  socketio: {
    definition,
    timeoutMs: 2000,
    commands: [
      { type: "wait", event: "welcome", timeoutMs: 1000 },
      {
        type: "emit",
        event: "echo",
        args: [{ text: "{{input}}" }],
        ackTimeoutMs: 1000,
      },
      { type: "wait", event: "answer", timeoutMs: 1000 },
    ],
  },
  extract: [{ name: "reply", path: "$[1].args[0].text" }],
});
test("Socket.IO frozen plan waits/emits/acks, extracts into real HTTP and closes its session", async (t) => {
  const f = await fixture(t);
  const spec = command(f.definition);
  spec.socketio.commands.push(
    {
      type: "emit",
      event: "echo",
      args: [{ text: "second" }],
      ackTimeoutMs: 1000,
    },
    { type: "wait", event: "answer", timeoutMs: 1000 },
  );
  const plan = snapshotPlan({
    steps: [spec, { request: { url: f.url + "/{{reply}}", method: "GET" } }],
  });
  const result = await runPlan(plan, { input: "flow" }, executeRequest, {
    executeSocketIO: executeSocketIOFlow,
    socketioCredentials: {
      "socket-step": { auth: { token: "fixture-token" } },
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.results[0].socketioResult.state, "closed");
  assert.equal(result.results[0].socketioResult.status, "passed");
  assert.equal(JSON.parse(result.results[1].response.body).url, "/flow");
  assert.equal(f.seen.length, 2);
  assert.equal(
    result.results[0].socketioResult.results[4].args[0].text,
    "second",
  );
  assert.equal(result.results[0].socketioResult.results[4].commandIndex, 4);
  assert(!JSON.stringify(result).includes("fixture-token"));
});
test("Socket.IO fixed flow timeout is unknown outcome without replay; cancellation closes transport", async (t) => {
  const f = await fixture(t);
  const flow = {
    definition: f.definition,
    commands: [{ type: "emit", event: "no-ack", args: [], ackTimeoutMs: 50 }],
    timeoutMs: 1000,
    auth: { token: "fixture-token" },
  };
  const timeout = await executeSocketIOFlow(flow);
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.results[0].remoteOutcome, "unknown");
  assert.deepEqual(f.seen, ["once"]);
  const controller = new AbortController();
  const pending = executeSocketIOFlow(
    { ...flow, commands: [{ type: "wait", event: "never", timeoutMs: 1000 }] },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.state, "closed");
});
test("Socket.IO plan MCP saves a project-local reference, enforces execution grant and retains evidence without credentials", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "socketio-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("socket");
  p.settings.socketioDefinitions = [f.definition];
  p.environments[0].variables.input = "mcp";
  await store.save(p);
  const writer = createMCP({ store, projects: [p.id], write: true });
  const call = (name, args) => ({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_" + name,
      arguments: { projectId: p.id, ...args },
    },
  });
  const decode = (r) => {
    assert.notEqual(r.result.isError, true, JSON.stringify(r));
    return JSON.parse(r.result.content[0].text);
  };
  const step = command(f.definition);
  delete step.socketio.definition;
  step.socketio.definitionId = "socket";
  const saved = decode(
    await writer(call("save_plan", { plan: { steps: [step] } })),
  );
  assert.equal(
    (await writer(call("execute_flow", { planId: saved.id }))).result.isError,
    true,
  );
  const runner = createMCP({
    store,
    projects: [p.id],
    write: true,
    execute: true,
  });
  const result = decode(
    await runner(
      call("execute_flow", {
        planId: saved.id,
        socketioCredentials: {
          "socket-step": { auth: { token: "fixture-token" } },
        },
      }),
    ),
  );
  assert.equal(result.status, "passed");
  const reloaded = await new Store(root).get(p.id);
  assert.equal(reloaded.runs[0].results[0].socketioResult.status, "passed");
  assert(!JSON.stringify(reloaded).includes("fixture-token"));
  assert.equal(f.seen.length, 1);
});

test("Socket.IO plan explicitly acknowledges a server event once and enforces one overall deadline", async (t) => {
  const f = await fixture(t);
  const flow = await executeSocketIOFlow({
    definition: f.definition,
    auth: { token: "fixture-token" },
    timeoutMs: 2000,
    commands: [
      { type: "emit", event: "ask", args: [] },
      { type: "wait", event: "question", timeoutMs: 1000 },
      { type: "ack", args: [{ answer: 8 }] },
    ],
  });
  assert.equal(flow.status, "passed");
  assert.equal(flow.results[2].status, "ack-sent");
  for (let i = 0; i < 100 && !f.seen.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.seen, [{ answer: 8 }]);
  const timeout = await executeSocketIOFlow({
    definition: f.definition,
    auth: { token: "fixture-token" },
    timeoutMs: 100,
    commands: [{ type: "wait", event: "never", timeoutMs: 30000 }],
  });
  assert.equal(timeout.status, "failed");
  assert.match(timeout.error, /超时|关闭/);
  assert.equal(timeout.state, "closed");
  const duplicate = await executeSocketIOFlow({
    definition: f.definition,
    auth: { token: "fixture-token" },
    commands: [{ type: "ack", args: [] }],
  });
  assert.equal(duplicate.status, "failed");
  assert.match(duplicate.error, /没有可确认/);
});
test("Socket.IO plan validation and missing capability fail without network effects", async (t) => {
  const f = await fixture(t),
    base = command(f.definition);
  for (const extra of [
    { beforeScript: "invalid" },
    { socketio: { ...base.socketio, auth: { token: "do-not-save" } } },
    {
      socketio: {
        ...base.socketio,
        commands: [{ type: "emit", event: "disconnect", args: [] }],
      },
    },
    { extract: [{ name: "x", path: "$[*]" }] },
  ])
    assert.throws(() => snapshotPlan({ steps: [{ ...base, ...extra }] }));
  const plan = snapshotPlan({ steps: [base] });
  const denied = await runPlan(plan, { input: "x" }, executeRequest);
  assert.equal(denied.status, "failed");
  assert.match(denied.results[0].error, /未授权/);
  await assert.rejects(
    runPlan(plan, { input: "x" }, executeRequest, {
      executeSocketIO: executeSocketIOFlow,
      socketioCredentials: { unknown: { auth: { token: "fixture-token" } } },
    }),
  );
  assert.equal(f.seen.length, 0);
  const filtered = { ...f.definition, events: ["answer"] };
  assert.throws(() => snapshotPlan({ steps: [command(filtered)] }), /过滤器/);
});
test("Socket.IO CLI executes a saved anonymous flow and persists native result evidence", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const f = await fixture(t, false),
    root = await mkdtemp(path.join(tmpdir(), "socketio-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("cli");
  p.environments[0].variables.input = "command";
  p.plans = [snapshotPlan({ steps: [command(f.definition)] })];
  await store.save(p);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
      "--project",
      p.id,
      "--plan",
      p.plans[0].id,
    ],
    {
      env: { ...process.env, LOCAL_API_DATA: root },
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
  const run = JSON.parse(stdout);
  assert.equal(run.status, "passed");
  assert.equal(
    run.results[0].socketioResult.results[1].args[0].text,
    "command",
  );
  assert.equal((await new Store(root).get(p.id)).runs[0].source, "cli");
  assert.equal(f.seen.length, 1);
});

test("HTTP and MCP Socket.IO plans share live limits, cancel, restore new copies and retain results after disk failure", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { restoreProject } = await import("../src/core.mjs");
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "socketio-plan-api-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("API");
  p.settings.socketioDefinitions = [f.definition];
  p.environments[0].variables.input = "api";
  await app.store.save(p);
  const base = app.url + "/api/projects/" + p.id,
    headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
  const post = async (action, data) => {
    const r = await fetch(base + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
    const x = await r.json();
    assert.equal(r.status, 200, JSON.stringify(x));
    return x;
  };
  const step = command(f.definition);
  delete step.socketio.definition;
  step.socketio.definitionId = "socket";
  const plan = await post("plans", { steps: [step] });
  const enabled = await (
    await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        enabled: true,
        projects: [p.id],
        write: true,
        execute: true,
      }),
    })
  ).json();
  const creds = { "socket-step": { auth: { token: "fixture-token" } } };
  const mcp = async (name = "localapi_execute_flow") => {
    const r = await (
      await fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + enabled.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: {
              projectId: p.id,
              planId: plan.id,
              socketioCredentials: creds,
            },
          },
        }),
      })
    ).json();
    assert.notEqual(r.result.isError, true, JSON.stringify(r));
    return JSON.parse(r.result.content[0].text);
  };
  const ids = [];
  for (let i = 0; i < 5; i++)
    ids.push(
      (
        await post("socketio-sessions", {
          definitionId: "socket",
          auth: { token: "fixture-token" },
        })
      ).id,
    );
  const limited = await mcp();
  assert.equal(limited.status, "failed");
  assert.match(limited.results[0].socketioResult.error, /5个/);
  const blocked = await post("run", {
    planId: plan.id,
    socketioCredentials: creds,
  });
  assert.equal(blocked.status, "failed");
  assert.equal(f.seen.length, 0);
  await post("socketio-sessions/" + ids[0] + "/stop", {});
  for (const name of ["localapi_execute_flow", "localapi_run_plan"])
    assert.equal((await mcp(name)).status, "passed");
  const success = await post("run", {
    planId: plan.id,
    socketioCredentials: creds,
  });
  assert.equal(success.status, "passed");
  assert.equal(f.seen.length, 3);
  const unauthorized = await post("run", { planId: plan.id });
  assert.equal(unauthorized.status, "failed");
  assert.equal(f.seen.length, 3);
  const stalled = await post("plans", {
    steps: [
      {
        id: "waiting",
        type: "socketio",
        socketio: {
          definition: f.definition,
          timeoutMs: 3000,
          commands: [{ type: "wait", event: "never", timeoutMs: 3000 }],
        },
      },
    ],
  });
  const before = f.connections;
  const pending = post("run", {
    planId: stalled.id,
    runId: "socketio-cancel",
    socketioCredentials: { waiting: { auth: { token: "fixture-token" } } },
  });
  for (let i = 0; i < 200 && f.connections === before; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert(f.connections > before);
  await fetch(app.url + "/api/cancel", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "socketio-cancel" }),
  });
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.results[0].socketioResult.state, "closed");
  const append = app.store.append.bind(app.store);
  app.store.append = async (...args) => {
    if (args[1] === "runs") throw Error("fixture disk failure");
    return append(...args);
  };
  const count = f.seen.length;
  const unsaved = await post("run", {
    planId: plan.id,
    socketioCredentials: creds,
  });
  assert.equal(unsaved.status, "passed");
  assert.equal(unsaved.recordSaved, false);
  assert.match(unsaved.persistenceError, /fixture disk failure/);
  assert.equal(f.seen.length, count + 1);
  app.store.append = append;
  const reloaded = await new Store(root).get(p.id);
  const restored = restoreProject({ ...reloaded, version: 1 });
  await app.store.save(restored);
  const copy = await new Store(root).get(restored.id);
  assert.notEqual(copy.id, p.id);
  assert(
    copy.runs.some((r) => r.results[0]?.socketioResult?.status === "passed"),
  );
  assert(copy.plans.some((plan) => plan.steps[0].type === "socketio"));
  assert(!JSON.stringify(copy).includes("fixture-token"));
});

test("Socket.IO flow marks truncated command evidence explicitly instead of claiming a complete result", async (t) => {
  const f = await fixture(t);
  const result = await executeSocketIOFlow({
    definition: f.definition,
    auth: { token: "fixture-token" },
    timeoutMs: 3000,
    commands: Array.from({ length: 3 }, () => ({
      type: "emit",
      event: "big",
      args: [],
      ackTimeoutMs: 1000,
    })),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.resultTruncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.results.length, 2);
  assert.match(result.error, /结果超过2MiB/);
  assert.deepEqual(f.seen, ["big", "big", "big"]);
  assert.equal(result.state, "closed");
});
