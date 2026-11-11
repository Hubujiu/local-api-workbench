import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { EventEmitter, once } from "node:events";
import { WebSocketServer } from "ws";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { createMCP } from "../src/mcp.mjs";
import { serveMCPStdio } from "../src/mcp-stdio.mjs";
import { createMCPStdioSessions } from "../src/mcp-stdio-sessions.mjs";
const protoFile = new URL("./fixtures/grpc.proto", import.meta.url),
  proto = await readFile(protoFile, "utf8");
const frame = (message) => JSON.stringify(message) + "\n";
const decode = (answer) => {
  assert.notEqual(answer.result?.isError, true, JSON.stringify(answer));
  return JSON.parse(answer.result.content[0].text);
};
async function until(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw Error("stdio gRPC lifecycle observation timeout");
}
async function fixture(t, options = {}) {
  const peer = new grpc.Server(),
    calls = [],
    slow = [];
  peer.addService(
    grpc.loadPackageDefinition(
      loader.loadSync(fileURLToPath(protoFile), {
        keepCase: true,
        longs: String,
        bytes: String,
        enums: String,
        defaults: true,
      }),
    ).fixture.Echo.service,
    {
      Chat(call) {
        const entry = { cancelled: false, messages: [] };
        calls.push(entry);
        call.on("error", () => {});
        call.on("cancelled", () => (entry.cancelled = true));
        call.on("data", (v) => entry.messages.push(v));
        call.write({ text: "challenge" });
      },
      Slow(call, callback) {
        const entry = { call, callback, cancelled: false };
        slow.push(entry);
        call.on("cancelled", () => (entry.cancelled = true));
      },
    },
  );
  const port = await new Promise((resolve, reject) =>
    peer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  const definition = {
    id: "chat",
    name: "chat",
    target: `grpc://127.0.0.1:${port}`,
    proto,
    service: "fixture.Echo",
    method: "Chat",
    timeoutMs: 30000,
  };
  const project = {
    id: "project",
    settings: { grpcDefinitions: [definition] },
    protocolRuns: [],
  };
  const projects = [project.id],
    store = {
      get: async () => project,
      append: async (_id, _field, r) => project.protocolRuns.push(r),
    };
  const runtime = createMCPStdioSessions({ store, projects }),
    input = new PassThrough(),
    replies = new Map(),
    releases = [];
  let outputMode = "ok",
    owner,
    wsOwner,
    nextId = 0,
    settled = false,
    final;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (outputMode === "stall") return;
      if (outputMode === "fail") return cb(Error("controlled write failure"));
      for (const line of chunk.toString().trim().split("\n")) {
        const reply = JSON.parse(line);
        replies.set(reply.id, reply);
      }
      cb();
    },
  });
  const dispatch = createMCP({
    store,
    projects: ["project", "imported"],
    write: true,
    execute: true,
    grpcSessions: runtime.grpcSessions,
    grpcExecutor: runtime.grpcExecutor,
  });
  const serving = serveMCPStdio({
    input,
    output,
    registry: runtime.registry,
    closeResources: () => runtime.close(),
    ...options,
    writerOptions: { timeoutMs: 40, ...options.writerOptions },
    dispatch: (m, o) => {
      if (o.grpcOwner) {
        owner = o.grpcOwner;
        wsOwner = o.websocketOwner;
      }
      return dispatch(m, o);
    },
  });
  serving.then(
    () => {
      settled = true;
    },
    (e) => {
      settled = true;
      final = e;
    },
  );
  const send = (method, params = {}) => {
    const id = ++nextId;
    input.write(frame({ jsonrpc: "2.0", id, method, params }));
    return id;
  };
  const request = async (method, params = {}) => {
    const id = send(method, params);
    return until(() => replies.get(id));
  };
  const call = (action, args = {}) =>
    request("tools/call", {
      name:
        action === "operation"
          ? "localapi_get_grpc_operation"
          : `localapi_${action}_grpc_session`,
      arguments: { projectId: "project", ...args },
    });
  const initialize = () =>
    request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-grpc-lifecycle", version: "1" },
    });
  const start = async (operationId = "start") => {
    const op = decode(
      await call("start", { definitionId: "chat", operationId }),
    );
    assert.equal(op.state, "started");
    await until(
      () =>
        runtime.grpcManager.get("project", op.sessionId).view.messages.length >
        0,
    );
    return op.sessionId;
  };
  t.after(async () => {
    for (const release of releases) release();
    input.end();
    await serving.catch(() => {});
    await runtime.close();
    peer.forceShutdown();
  });
  return {
    runtime,
    input,
    output,
    store,
    project,
    projects,
    definition,
    calls,
    slow,
    releases,
    send,
    request,
    call,
    initialize,
    start,
    serving,
    get owner() {
      return owner;
    },
    get wsOwner() {
      return wsOwner;
    },
    get settled() {
      return settled;
    },
    get final() {
      return final;
    },
    outputMode(v) {
      outputMode = v;
    },
  };
}

test("stdio gRPC initialize gates trusted owner and startup project allowlist stays frozen", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call("start", { definitionId: "chat", operationId: "before" }))
      .result.isError,
    true,
  );
  assert.equal(f.calls.length, 0);
  await f.initialize();
  const id = await f.start(),
    owner = f.owner;
  assert.equal(owner, f.wsOwner);
  f.projects.push("imported");
  assert.equal(
    (
      await f.call("start", {
        projectId: "imported",
        definitionId: "chat",
        operationId: "new",
      })
    ).result.isError,
    true,
  );
  assert.throws(
    () =>
      f.runtime.grpcSessions.call(
        "get",
        { ...owner },
        { projectId: "project", sessionId: id },
      ),
    /owner|session/i,
  );
  assert.equal(
    (await f.call("get", { sessionId: id, grpcOwner: owner })).result.isError,
    true,
  );
  await f.initialize();
  assert.equal(
    decode(
      await f.call("start", { definitionId: "chat", operationId: "start" }),
    ).sessionId,
    id,
  );
  assert.equal(f.owner, owner);
  assert.equal(f.calls.length, 1);
});

for (const mode of [
  "eof",
  "incomplete-eof",
  "stdin-error",
  "stdin-close",
  "stdout-error",
  "stdout-close",
  "stdout-write",
  "stdout-timeout",
  "input-budget",
  "handler-budget",
  "output-budget",
]) {
  test(`stdio gRPC ${mode} cancels real call and waits for held evidence`, async (t) => {
    const f = await fixture(
      t,
      mode === "input-budget"
        ? { maxInputBytes: 1024 }
        : mode === "handler-budget"
          ? { maxHandlers: 2 }
          : mode === "output-budget"
            ? {
                maxHandlers: 64,
                writerOptions: { maxQueuedBytes: 512, timeoutMs: 1000 },
              }
            : {},
    );
    await f.initialize();
    const id = await f.start();
    await delay(5);
    let releaseSave,
      saveStarted = false;
    const saved = new Promise((resolve) => {
      releaseSave = resolve;
    });
    f.releases.push(() => releaseSave());
    f.store.append = async (_id, _field, record) => {
      saveStarted = true;
      await saved;
      f.project.protocolRuns.push(record);
    };
    const lookups = [];
    f.releases.push(() => {
      for (const release of lookups) release(f.project);
    });
    if (mode === "eof") f.input.end();
    if (mode === "incomplete-eof") f.input.end('{"jsonrpc":');
    if (mode === "stdin-error")
      f.input.emit("error", Error("controlled input failure"));
    if (mode === "stdin-close") f.input.emit("close");
    if (mode === "stdout-error")
      f.output.emit("error", Error("controlled output failure"));
    if (mode === "stdout-close") f.output.emit("close");
    if (mode === "stdout-write" || mode === "stdout-timeout") {
      f.outputMode(mode === "stdout-write" ? "fail" : "stall");
      f.send("ping");
    }
    if (mode === "input-budget") f.input.write("x".repeat(1025));
    if (mode === "handler-budget") {
      f.store.get = () => new Promise((resolve) => lookups.push(resolve));
      for (let i = 0; i < 2; i++)
        f.send("tools/call", {
          name: "localapi_start_grpc_session",
          arguments: {
            projectId: "project",
            definitionId: "chat",
            operationId: "pending" + i,
          },
        });
      await until(() => lookups.length === 2);
      f.send("ping");
      await until(() => !f.runtime.registry.owns(f.owner));
      f.store.get = async () => f.project;
      for (const release of lookups) release(f.project);
    }
    if (mode === "output-budget") {
      f.outputMode("stall");
      for (let i = 0; i < 20; i++) f.send("ping");
    }
    await until(() => saveStarted);
    assert.equal(f.runtime.registry.owns(f.owner), false);
    await until(() => f.calls[0].cancelled);
    assert.throws(
      () =>
        f.runtime.grpcSessions.call("get", f.owner, {
          projectId: "project",
          sessionId: id,
        }),
      /owner|session/i,
    );
    await delay(10);
    assert.equal(f.settled, false);
    releaseSave();
    await f.serving.catch(() => {});
    assert.equal(Boolean(f.final), mode !== "eof");
    assert.equal(f.project.protocolRuns.length, 1);
    assert.equal(f.calls.length, 1);
  });
}

test("stdio gRPC pending store start cannot construct transport after EOF", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  let release;
  f.store.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.releases.push(() => release?.(f.project));
  f.send("tools/call", {
    name: "localapi_start_grpc_session",
    arguments: {
      projectId: "project",
      definitionId: "chat",
      operationId: "pending",
    },
  });
  await until(() => release);
  f.input.end();
  await delay(10);
  assert.equal(f.settled, false);
  release(f.project);
  await f.serving;
  assert.equal(f.calls.length, 0);
});

test("stdio gRPC reads cannot renew fixed deadline or admit a late send", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const id = await f.start(),
    s = f.runtime.grpcManager.get("project", id),
    deadline = s.view.deadlineAt;
  for (let i = 0; i < 3; i++)
    assert.equal(
      decode(await f.call("get", { sessionId: id })).deadlineAt,
      deadline,
    );
  s.started -= 30001;
  const denied = await f.call("send", {
    sessionId: id,
    operationId: "late",
    message: { text: "never" },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(
    JSON.parse(denied.result.content[0].text).state,
    "failed-before-submit",
  );
  const page = decode(await f.call("get", { sessionId: id }));
  assert.equal(page.lifecycle, "terminal");
  assert.equal(page.terminationReason, "deadline");
  assert.equal(f.calls[0].messages.length, 0);
});

test("stdio finite and bidi share five gRPC slots in both directions; close aborts finite and denies new work", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const input = { ...f.definition, method: "Slow", messages: [{}] };
  delete input.id;
  delete input.name;
  const finite = Array.from({ length: 5 }, () => f.runtime.grpcExecutor(input));
  for (const task of finite) task.catch(() => {});
  await until(() => f.slow.length === 5);
  assert.equal(
    (await f.call("start", { definitionId: "chat", operationId: "full" }))
      .result.isError,
    true,
  );
  assert.equal(f.calls.length, 0);
  f.slow[0].callback(null, { text: "released" });
  await finite[0];
  const id = await f.start();
  await assert.rejects(f.runtime.grpcExecutor(input), /5个gRPC/);
  f.input.end();
  await f.serving;
  await Promise.allSettled(finite);
  await until(() => f.slow.slice(1).every((x) => x.cancelled));
  assert.equal(
    f.runtime.grpcManager.get("project", id).view.lifecycle,
    "terminal",
  );
  await assert.rejects(f.runtime.grpcExecutor(input), /closed/);
});

function controlled(f) {
  const calls = [];
  f.runtime.grpcManager.createClient = () => {
    const call = new EventEmitter();
    Object.assign(call, {
      writes: [],
      callbacks: [],
      cancelled: false,
      write(message, callback) {
        this.writes.push(message);
        this.callbacks.push(callback);
        callback();
        return true;
      },
      end(callback) {
        this.endCallback = callback;
      },
      cancel() {
        this.cancelled = true;
      },
    });
    calls.push(call);
    queueMicrotask(() => call.emit("data", { text: "challenge" }));
    return { makeBidiStreamRequest: () => call, close() {} };
  };
  return calls;
}

test("stdio gRPC shutdown freezes unknown send and late callbacks cannot rewrite evidence", async (t) => {
  const f = await fixture(t),
    calls = controlled(f);
  await f.initialize();
  const id = await f.start(),
    s = f.runtime.grpcManager.get("project", id);
  let callback;
  calls[0].write = (_message, done) => {
    callback = done;
    return false;
  };
  assert.equal(
    decode(
      await f.call("send", {
        sessionId: id,
        operationId: "send",
        message: { text: "pending" },
      }),
    ).state,
    "pending",
  );
  assert.equal(
    (await f.call("half_close", { sessionId: id, operationId: "concurrent" }))
      .result.isError,
    true,
  );
  f.input.end();
  await f.serving;
  const frozen = structuredClone(s.finalSnapshot);
  assert.equal(frozen.requestMessages[0].sendState, "unknown");
  callback();
  calls[0].emit("drain");
  assert.deepEqual(s.finalSnapshot, frozen);
  assert.equal(calls[0].cancelled, true);
});

test("stdio gRPC ledger is bounded at 200 and keeps duplicates queryable and cancellation available", async (t) => {
  const f = await fixture(t);
  controlled(f);
  await f.initialize();
  const id = await f.start();
  for (let i = 0; i < 199; i++)
    await f.runtime.grpcSessions.call("send", f.owner, {
      projectId: "project",
      sessionId: "missing",
      operationId: "failed" + i,
      message: {},
    });
  assert.throws(
    () =>
      f.runtime.grpcSessions.call("send", f.owner, {
        projectId: "project",
        sessionId: id,
        operationId: "overflow",
        message: {},
      }),
    /ledger/,
  );
  assert.equal(
    decode(
      await f.call("start", { definitionId: "chat", operationId: "start" }),
    ).sessionId,
    id,
  );
  decode(await f.call("operation", { operationId: "failed0" }));
  decode(await f.call("cancel", { sessionId: id }));
});

test("stdio gRPC request admission respects 100-message and exact one-MiB JSON limits", async (t) => {
  const f = await fixture(t),
    calls = controlled(f);
  await f.initialize();
  const id = await f.start();
  for (let i = 0; i < 100; i++)
    assert.equal(
      (
        await f.runtime.grpcSessions.call("send", f.owner, {
          projectId: "project",
          sessionId: id,
          operationId: "send" + i,
          message: {},
        })
      ).state,
      "locally-written",
    );
  assert.equal(
    (
      await f.call("send", {
        sessionId: id,
        operationId: "too-many",
        message: {},
      })
    ).result.isError,
    true,
  );
  assert.equal(calls[0].writes.length, 100);
  const second = await f.start("second"),
    exact = {
      text: "x".repeat(
        1048576 - Buffer.byteLength(JSON.stringify({ text: "" })),
      ),
    };
  assert.equal(
    (
      await f.call("send", {
        sessionId: second,
        operationId: "oversize",
        message: { text: exact.text + "x" },
      })
    ).result.isError,
    true,
  );
  assert.equal(
    decode(
      await f.call("send", {
        sessionId: second,
        operationId: "exact",
        message: exact,
      }),
    ).state,
    "locally-written",
  );
  assert.equal(
    (
      await f.call("send", {
        sessionId: second,
        operationId: "cumulative",
        message: {},
      })
    ).result.isError,
    true,
  );
  assert.equal(calls[1].writes.length, 1);
});

test("stdio gRPC retains fifty failed evidence slots and shutdown cannot retry persistence", async (t) => {
  const f = await fixture(t),
    calls = controlled(f);
  await f.initialize();
  let attempts = 0;
  f.store.append = async () => {
    attempts++;
    throw Error("controlled save failure");
  };
  for (let i = 0; i < 50; i++) {
    const id = await f.start("start" + i);
    const result = decode(await f.call("cancel", { sessionId: id }));
    assert.equal(result.recordSaved, false);
    assert.equal(result.receiptState, "failed");
  }
  assert.equal(
    (await f.call("start", { definitionId: "chat", operationId: "full" }))
      .result.isError,
    true,
  );
  assert.equal(calls.length, 50);
  assert.equal(f.runtime.grpcManager.sessions.size, 50);
  f.input.end();
  await f.serving;
  assert.equal(attempts, 50);
  assert.equal(f.runtime.grpcManager.sessions.size, 50);
});

test("stdio finite executor close before transport microtask opens no call, including before serve", async (t) => {
  const f = await fixture(t),
    fresh = createMCPStdioSessions({ store: f.store, projects: ["project"] });
  const input = { ...f.definition, method: "Slow", messages: [{}] };
  delete input.id;
  delete input.name;
  const task = fresh.grpcExecutor(input);
  task.catch(() => {});
  await fresh.close();
  const result = await task;
  assert.equal(result.status.code, grpc.status.CANCELLED);
  await delay(10);
  assert.equal(f.slow.length, 0);
  await assert.rejects(fresh.grpcExecutor(input), /closed/);
});

test("stdio finite executor releases exactly its slot on malformed input, completion and abort", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const input = { ...f.definition, method: "Slow", messages: [{}] };
  delete input.id;
  delete input.name;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      assert.rejects(f.runtime.grpcExecutor({ invalid: true })),
    ),
  );
  for (const mode of ["complete", "abort", "complete"]) {
    const offset = f.slow.length,
      controllers = Array.from({ length: 5 }, () => new AbortController());
    const tasks = controllers.map((c) =>
      f.runtime.grpcExecutor(input, c.signal),
    );
    for (const task of tasks) task.catch(() => {});
    await until(() => f.slow.length === offset + 5);
    await assert.rejects(f.runtime.grpcExecutor(input), /5个gRPC/);
    if (mode === "abort") for (const c of controllers) c.abort();
    else
      for (const entry of f.slow.slice(offset))
        entry.callback(null, { text: "done" });
    await Promise.all(tasks);
  }
  const id = await f.start();
  assert.equal(
    f.runtime.grpcManager.get("project", id).view.lifecycle,
    "active",
  );
});

test("stdio pending gRPC send lookup cannot submit after EOF revocation", async (t) => {
  const f = await fixture(t),
    calls = controlled(f);
  await f.initialize();
  const id = await f.start(),
    waits = [];
  f.store.get = () => new Promise((resolve) => waits.push(resolve));
  f.releases.push(() => {
    f.store.get = async () => f.project;
    for (const release of waits) release(f.project);
  });
  f.send("tools/call", {
    name: "localapi_send_grpc_session",
    arguments: {
      projectId: "project",
      sessionId: id,
      operationId: "pending",
      message: { text: "not submitted" },
    },
  });
  await until(() => waits.length > 0);
  f.input.end();
  await until(() => !f.runtime.registry.owns(f.owner));
  f.store.get = async () => f.project;
  for (const release of waits) release(f.project);
  await f.serving;
  assert.equal(calls[0].writes.length, 0);
  assert.equal(
    f.runtime.grpcManager.get("project", id).finalSnapshot.requestMessages
      .length,
    0,
  );
});

test("stdio gRPC owner is withheld until successful initialization response write completes", async () => {
  const input = new PassThrough(),
    seen = [];
  let release,
    released = false;
  const output = new Writable({
    write(_chunk, _encoding, cb) {
      if (!release)
        release = () => {
          if (!released) {
            released = true;
            cb();
          }
        };
      else cb();
    },
  });
  const serving = serveMCPStdio({
    input,
    output,
    writerOptions: { timeoutMs: 1000 },
    dispatch: async (message, options) => {
      seen.push(options);
      return { jsonrpc: "2.0", id: message.id, result: {} };
    },
  });
  try {
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    await until(() => release);
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "ping" }));
    await until(() => seen.length === 2);
    assert.equal(seen[1].grpcOwner, undefined);
    release();
    await delay(5);
    input.write(frame({ jsonrpc: "2.0", id: 3, method: "ping" }));
    await until(() => seen.length === 3);
    assert.equal(typeof seen[2].grpcOwner, "object");
    assert.equal(seen[2].grpcOwner, seen[2].websocketOwner);
    input.end();
    await serving;
  } finally {
    release?.();
    input.end();
    await serving.catch(() => {});
  }
});

test("stdio EOF simultaneously closes real WebSocket, bidi and finite RPC and drains both held records", async (t) => {
  const f = await fixture(t);
  const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(peer, "listening");
  let socketClosed = false,
    socketAccepted = false;
  peer.on("connection", (socket) => {
    socketAccepted = true;
    socket.on("error", () => {});
    socket.on("close", () => (socketClosed = true));
  });
  t.after(async () => {
    for (const socket of peer.clients) socket.terminate();
    await new Promise((resolve) => peer.close(resolve));
  });
  f.project.protocols = [
    {
      id: "ws",
      name: "combined",
      type: "websocket",
      url: `ws://127.0.0.1:${peer.address().port}`,
    },
  ];
  await f.initialize();
  const grpcId = await f.start();
  const ws = await f.runtime.websocketSessions.call("start", f.owner, {
    projectId: "project",
    definitionId: "ws",
    operationId: "combined-ws",
  });
  assert.equal(ws.state, "started");
  await until(() => socketAccepted);
  const input = { ...f.definition, method: "Slow", messages: [{}] };
  delete input.id;
  delete input.name;
  const finite = f.runtime.grpcExecutor(input);
  finite.catch(() => {});
  await until(() => f.slow.length === 1);
  const started = new Set(),
    releases = new Map();
  const holds = new Map(
    [grpcId, ws.sessionId].map((id) => [
      id,
      new Promise((resolve) => releases.set(id, resolve)),
    ]),
  );
  f.releases.push(() => {
    for (const release of releases.values()) release();
  });
  f.store.append = async (_id, _field, record) => {
    started.add(record.id);
    await holds.get(record.id);
    f.project.protocolRuns.push(record);
  };
  f.input.end();
  await until(() => started.size === 2);
  assert.equal(f.runtime.registry.owns(f.owner), false);
  await until(
    () => socketClosed && f.calls[0].cancelled && f.slow[0].cancelled,
  );
  assert.equal((await finite).status.code, grpc.status.CANCELLED);
  assert.equal(f.settled, false);
  assert.equal(f.project.protocolRuns.length, 0);
  releases.get(grpcId)();
  await until(() => f.project.protocolRuns.length === 1);
  await delay(10);
  assert.equal(
    f.settled,
    false,
    "WebSocket persistence must still block combined shutdown",
  );
  releases.get(ws.sessionId)();
  await f.serving;
  assert.equal(f.final, undefined);
  assert.deepEqual(
    new Set(f.project.protocolRuns.map((record) => record.id)),
    new Set([grpcId, ws.sessionId]),
  );
  assert.equal(
    f.runtime.grpcManager.get("project", grpcId).receipt.recordSaved,
    true,
  );
});
