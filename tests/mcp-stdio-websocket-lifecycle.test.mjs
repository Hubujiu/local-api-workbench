import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { createMCP } from "../src/mcp.mjs";
import { serveMCPStdio } from "../src/mcp-stdio.mjs";
import { createMCPStdioWebSocketSessions } from "../src/mcp-stdio-websocket.mjs";

const frame = (message) => JSON.stringify(message) + "\n";
const decode = (answer) => {
  assert.notEqual(answer.result?.isError, true, JSON.stringify(answer));
  return JSON.parse(answer.result.content[0].text);
};
async function waitFor(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw Error("stdio lifecycle observation timeout");
}
async function fixture(t, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connections = [];
  server.on("connection", (socket) => {
    connections.push(socket);
    socket.on("error", () => {});
  });
  const project = {
    id: "project",
    protocols: [
      {
        id: "ws",
        type: "websocket",
        name: "fixture",
        url: `ws://127.0.0.1:${server.address().port}`,
      },
    ],
  };
  const projects = [project.id],
    store = { get: async () => project };
  const resources = createMCPStdioWebSocketSessions({ store, projects });
  resources.sessions.onFinish = (session) => {
    session.recordSaved = true;
    return Promise.resolve();
  };
  const input = new PassThrough(),
    replies = new Map(),
    releases = [];
  let outputMode = "ok",
    owner,
    nextId = 0,
    settled = false,
    final;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (outputMode === "stall") return;
      if (outputMode === "fail")
        return callback(Error("controlled output failure"));
      for (const line of chunk.toString().trim().split("\n")) {
        const reply = JSON.parse(line);
        replies.set(reply.id, reply);
      }
      callback();
    },
  });
  const dispatch = createMCP({
    store,
    projects: ["project", "imported"],
    write: true,
    execute: true,
    websocketSessions: resources.service,
  });
  const serving = serveMCPStdio({
    input,
    output,
    registry: resources.registry,
    closeResources: () => resources.close(),
    ...options,
    writerOptions: { timeoutMs: 30, ...options.writerOptions },
    dispatch: (message, options) => {
      if (options.websocketOwner) owner = options.websocketOwner;
      return dispatch(message, options);
    },
  });
  serving.then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      final = error;
    },
  );
  const send = (method, params = {}) => {
    const id = ++nextId;
    input.write(frame({ jsonrpc: "2.0", id, method, params }));
    return id;
  };
  const request = async (method, params = {}) => {
    const id = send(method, params);
    return waitFor(() => replies.get(id));
  };
  const call = (action, args = {}) =>
    request("tools/call", {
      name:
        action === "operation"
          ? "localapi_get_websocket_operation"
          : `localapi_${action}_websocket_session`,
      arguments: { projectId: "project", ...args },
    });
  const initialize = () =>
    request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "lifecycle", version: "1" },
    });
  const start = async (operationId = "start") => {
    const op = decode(await call("start", { definitionId: "ws", operationId }));
    assert.equal(op.state, "started");
    await waitFor(() => resources.sessions.get(op.sessionId).state === "open");
    return op.sessionId;
  };
  t.after(async () => {
    for (const release of releases) release();
    input.end();
    await serving.catch(() => {});
    await resources.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    input,
    output,
    resources,
    projects,
    store,
    project,
    connections,
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
    get settled() {
      return settled;
    },
    get final() {
      return final;
    },
    outputMode(value) {
      outputMode = value;
    },
  };
}

test("stdio WebSocket owner requires completed initialize; startup allowlist cannot expand or be forged", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call("start", { definitionId: "ws", operationId: "before-init" }))
      .result.isError,
    true,
  );
  assert.equal(f.connections.length, 0);
  await f.initialize();
  const sessionId = await f.start();
  const original = f.owner;
  f.projects.push("imported");
  assert.equal(
    (
      await f.call("start", {
        projectId: "imported",
        definitionId: "ws",
        operationId: "imported",
      })
    ).result.isError,
    true,
  );
  assert.equal(
    (await f.call("get", { sessionId, owner: { epoch: 0 } })).result.isError,
    true,
  );
  assert.throws(
    () =>
      f.resources.service.call(
        "get",
        { ...original },
        { projectId: "project", sessionId },
      ),
    /live|session|owner/i,
  );
  await f.initialize();
  assert.equal(
    decode(await f.call("start", { definitionId: "ws", operationId: "start" }))
      .sessionId,
    sessionId,
  );
  assert.equal(f.owner, original);
  assert.equal(f.connections.length, 1);
});

for (const mode of [
  "eof",
  "incomplete-eof",
  "stdin-error",
  "stdin-close",
  "stdout-error",
  "stdout-close",
  "stdout-write-error",
  "stdout-timeout",
]) {
  test(`stdio ${mode} synchronously revokes and waits for socket persistence`, async (t) => {
    const f = await fixture(t);
    await f.initialize();
    const sessionId = await f.start();
    let release,
      saveStarted = false;
    const saved = new Promise((resolve) => {
      release = resolve;
    });
    f.resources.sessions.onFinish = (session) => {
      saveStarted = true;
      return saved.then(() => {
        session.recordSaved = true;
      });
    };
    f.releases.push(() => release());
    if (mode === "eof") f.input.end();
    if (mode === "incomplete-eof") f.input.end('{"jsonrpc":');
    if (mode === "stdin-error")
      f.input.emit("error", Error("controlled input error"));
    if (mode === "stdin-close") f.input.emit("close");
    if (mode === "stdout-error")
      f.output.emit("error", Error("controlled output error"));
    if (mode === "stdout-close") f.output.emit("close");
    if (mode === "stdout-write-error" || mode === "stdout-timeout") {
      f.outputMode(mode === "stdout-timeout" ? "stall" : "fail");
      f.send("ping");
    }
    await waitFor(() => saveStarted);
    assert.equal(f.resources.registry.owns(f.owner), false);
    assert.throws(
      () =>
        f.resources.service.call("renew", f.owner, {
          projectId: "project",
          sessionId,
        }),
      /live|session|owner/i,
    );
    await waitFor(() => f.connections[0].readyState === 3);
    await delay(10);
    assert.equal(
      f.settled,
      false,
      "shutdown must wait for evidence persistence",
    );
    release();
    await f.serving.catch(() => {});
    assert.equal(f.settled, true);
    assert.equal(Boolean(f.final), mode !== "eof");
  });
}

test("stdio EOF while project lookup is pending prevents late start admission", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  let release;
  f.store.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.releases.push(() => release?.(f.project));
  f.send("tools/call", {
    name: "localapi_start_websocket_session",
    arguments: {
      projectId: "project",
      definitionId: "ws",
      operationId: "pending",
    },
  });
  await waitFor(() => release);
  f.input.end();
  await delay(10);
  assert.equal(f.settled, false);
  release(f.project);
  await f.serving;
  assert.equal(f.connections.length, 0);
  assert.equal(f.resources.sessions.sessions.size, 0);
});

test("stdio EOF freezes submitted send as unknown and ignores late success callback", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const sessionId = await f.start();
  const session = f.resources.sessions.get(sessionId);
  let callback,
    writes = 0,
    frozen;
  session.socket.send = (_value, _options, done) => {
    writes++;
    callback = done;
  };
  f.resources.sessions.onFinish = (value) => {
    frozen = structuredClone(value.finalSnapshot);
    return Promise.resolve();
  };
  const op = decode(
    await f.call("send", {
      sessionId,
      operationId: "send",
      message: "unconfirmed",
    }),
  );
  assert.equal(op.state, "pending");
  f.input.end();
  await f.serving;
  assert.equal(session.events.at(-1).sendState, "queued");
  callback();
  assert.deepEqual(session.finalSnapshot, frozen);
  assert.equal(session.events.at(-1).sendState, "queued");
  assert.equal(writes, 1);
});

test("stdio send validates one-MiB bound before submission and pages remain bounded", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const sessionId = await f.start();
  const session = f.resources.sessions.get(sessionId);
  let writes = 0;
  session.socket.send = (_value, _options, done) => {
    writes++;
    done();
  };
  assert.equal(
    (
      await f.call("send", {
        sessionId,
        operationId: "large",
        message: "x".repeat(1048577),
      })
    ).result.isError,
    true,
  );
  decode(
    await f.call("send", {
      sessionId,
      operationId: "exact",
      message: "x".repeat(1048576),
    }),
  );
  assert.equal(writes, 1);
  const page = decode(await f.call("get", { sessionId, limit: 20 }));
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].data.length, 4096);
  assert.equal(page.events[0].dataBytes, 1048576);
  assert.equal(page.events[0].truncated, true);
  assert.equal(
    (await f.call("get", { sessionId, limit: 21 })).result.isError,
    true,
  );
});

test("stdio initialized owner is not exposed until initialization response write completes", async () => {
  const input = new PassThrough();
  let release,
    seen = [];
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      if (!release) {
        let done = false;
        release = () => {
          if (!done) {
            done = true;
            callback();
          }
        };
      } else callback();
    },
  });
  const serving = serveMCPStdio({
    input,
    output,
    writerOptions: { timeoutMs: 1000 },
    dispatch: async (message, options) => {
      seen.push({ id: message.id, owner: options.websocketOwner });
      return { jsonrpc: "2.0", id: message.id, result: {} };
    },
  });
  try {
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    await waitFor(() => release);
    input.write(
      frame({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "localapi_get_websocket_operation" },
      }),
    );
    await waitFor(() => seen.length === 2);
    assert.equal(seen[1].owner, undefined);
    release();
    await delay(5);
    input.write(
      frame({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "localapi_get_websocket_operation" },
      }),
    );
    await waitFor(() => seen.length === 3);
    assert.equal(typeof seen[2].owner, "object");
    input.end();
    await serving;
  } finally {
    release?.();
    input.end();
    await serving.catch(() => {});
  }
});

test("stdio cumulative eight-MiB budget rejects before a ninth write", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const sessionId = await f.start(),
    session = f.resources.sessions.get(sessionId);
  let writes = 0;
  session.socket.send = (_value, _options, done) => {
    writes++;
    done();
  };
  const message = "x".repeat(1048576);
  for (let i = 0; i < 8; i++)
    decode(
      await f.call("send", { sessionId, operationId: "send" + i, message }),
    );
  const ninth = await f.call("send", {
    sessionId,
    operationId: "send8",
    message,
  });
  assert.equal(ninth.result.isError, true);
  assert.equal(
    JSON.parse(ninth.result.content[0].text).state,
    "failed-before-submit",
  );
  assert.equal(writes, 8);
  assert.equal(session.bytes, 8 * 1048576);
  assert.equal(session.overflow, true);
});

test("stdio operation ledger caps at 200 without evicting replay protection or blocking stop", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const sessionId = await f.start(),
    session = f.resources.sessions.get(sessionId);
  let writes = 0;
  session.socket.send = (_value, _options, done) => {
    writes++;
    done();
  };
  for (let i = 0; i < 199; i++)
    decode(
      await f.call("send", {
        sessionId,
        operationId: "send" + i,
        message: "x",
      }),
    );
  assert.equal(
    (await f.call("send", { sessionId, operationId: "overflow", message: "x" }))
      .result.isError,
    true,
  );
  assert.equal(
    decode(
      await f.call("send", { sessionId, operationId: "send0", message: "x" }),
    ).state,
    "locally-written",
  );
  assert.equal(writes, 199);
  decode(await f.call("renew", { sessionId }));
  assert.equal(decode(await f.call("get", { sessionId })).events.length, 20);
  decode(await f.call("stop", { sessionId }));
});

for (const mode of ["input-budget", "handler-budget", "output-queue-budget"]) {
  test(`stdio ${mode} fatally revokes existing socket and drains evidence`, async (t) => {
    const f = await fixture(
      t,
      mode === "input-budget"
        ? { maxInputBytes: 1024 }
        : mode === "handler-budget"
          ? { maxHandlers: 2 }
          : {
              maxHandlers: 64,
              writerOptions: { maxQueuedBytes: 512, timeoutMs: 1000 },
            },
    );
    await f.initialize();
    const sessionId = await f.start();
    await delay(5);
    let releaseSave,
      saveStarted = false;
    const saved = new Promise((resolve) => {
      releaseSave = resolve;
    });
    f.releases.push(() => releaseSave());
    f.resources.sessions.onFinish = (session) => {
      saveStarted = true;
      return saved.then(() => {
        session.recordSaved = true;
      });
    };
    const lookups = [];
    f.releases.push(() => {
      for (const release of lookups) release(f.project);
    });
    if (mode === "input-budget") f.input.write("x".repeat(1025));
    if (mode === "handler-budget") {
      f.store.get = () => new Promise((resolve) => lookups.push(resolve));
      for (let i = 0; i < 2; i++)
        f.send("tools/call", {
          name: "localapi_start_websocket_session",
          arguments: {
            projectId: "project",
            definitionId: "ws",
            operationId: "pending" + i,
          },
        });
      await waitFor(() => lookups.length === 2);
      f.send("ping");
    }
    if (mode === "output-queue-budget") {
      f.outputMode("stall");
      for (let i = 0; i < 20; i++) f.send("ping");
    }
    await waitFor(() => saveStarted);
    assert.equal(f.resources.registry.owns(f.owner), false);
    assert.throws(
      () =>
        f.resources.service.call("send", f.owner, {
          projectId: "project",
          sessionId,
          operationId: "late",
          message: "not sent",
        }),
      /live|session|owner/i,
    );
    await waitFor(() => f.connections[0].readyState === 3);
    for (const release of lookups) release(f.project);
    await delay(10);
    assert.equal(f.settled, false);
    releaseSave();
    await f.serving.catch(() => {});
    assert.match(
      f.final.message,
      mode === "input-budget"
        ? /input exceeds/
        : mode === "handler-budget"
          ? /pending handler limit/
          : /output queue exhausted/,
    );
    assert.equal(
      f.connections.length,
      1,
      "pending admissions cannot reconnect after shutdown",
    );
  });
}

test("stdio EOF drains a failed persistence attempt without claiming recordSaved", async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const sessionId = await f.start(),
    session = f.resources.sessions.get(sessionId);
  let attempts = 0;
  f.resources.sessions.onFinish = () => {
    attempts++;
    return Promise.reject(Error("controlled storage failure"));
  };
  f.input.end();
  await f.serving;
  assert.equal(attempts, 1);
  assert.notEqual(session.recordSaved, true);
  assert.equal(session.recordPending, false);
  assert.equal(session.receipt.recordSaved, false);
  assert.equal(
    f.resources.sessions.sessions.get(sessionId),
    session,
    "failed save retains its slot and receipt",
  );
  await f.resources.close();
  assert.equal(attempts, 1, "repeated cleanup cannot retry network or storage");
});
