import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoFile, "utf8");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const rejected = (result) =>
  assert.equal(result.isError, true, JSON.stringify(result));
async function until(read, label = "gRPC observation") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw Error("Timed out waiting for " + label);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-grpc-workflow-"));
  const peer = new grpc.Server();
  const calls = [];
  const definition = loader.loadSync(fileURLToPath(protoFile), {
    keepCase: true,
    longs: String,
    bytes: String,
    enums: String,
    defaults: true,
  });
  peer.addService(grpc.loadPackageDefinition(definition).fixture.Echo.service, {
    Chat(call) {
      const entry = {
        nonce: randomUUID(),
        messages: [],
        cancelled: false,
        ended: false,
      };
      calls.push(entry);
      call.on("error", () => {});
      call.on("cancelled", () => {
        entry.cancelled = true;
      });
      call.on("data", (message) => {
        entry.messages.push(message);
        call.write({
          text:
            message.text === "answer:" + entry.nonce
              ? "accepted:" + entry.nonce
              : "echo:" + message.text,
        });
      });
      call.on("end", () => {
        entry.ended = true;
        call.end();
      });
      call.write({ text: "challenge:" + entry.nonce });
    },
  });
  const port = await new Promise((resolve, reject) =>
    peer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const app = await createApp({ root, port: 0 });
  const clients = [];
  t.after(async () => {
    for (const item of clients) await item.client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    peer.forceShutdown();
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("MCP gRPC"),
    other = await app.store.create("Other gRPC");
  for (const project of [p, other]) {
    project.settings.grpcDefinitions = [
      "Chat",
      "Watch",
      "Collect",
      "Unary",
    ].map((method) => ({
      id: method.toLowerCase(),
      name: method,
      target: `grpc://127.0.0.1:${port}`,
      proto,
      service: "fixture.Echo",
      method,
      timeoutMs: 30000,
    }));
    await app.store.save(project);
  }
  const ownerHeaders = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  const configure = async (changes = {}) => {
    const response = await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        enabled: true,
        projects: [p.id, other.id],
        write: true,
        execute: true,
        ...changes,
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const config = await configure();
  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(app.url + "/mcp"),
      { requestInit: { headers: { Authorization: "Bearer " + config.token } } },
    );
    const client = new Client({ name: "grpc-workflow", version: "1" });
    client.onerror = () => {};
    const item = { client, transport };
    clients.push(item);
    await client.connect(transport);
    return item;
  };
  const invoke = (client, action, args = {}) =>
    client.callTool({
      name:
        action === "operation"
          ? "localapi_get_grpc_operation"
          : `localapi_${action}_grpc_session`,
      arguments: { projectId: p.id, ...args },
    });
  const get = async (client, sessionId, extra = {}) =>
    decode(await invoke(client, "get", { sessionId, ...extra }));
  const start = async (client, operationId, extra = {}) => {
    const op = decode(
      await invoke(client, "start", {
        definitionId: "chat",
        operationId,
        ...extra,
      }),
    );
    assert.equal(op.state, "started");
    await until(
      async () =>
        (
          await get(
            client,
            op.sessionId,
            extra.projectId ? { projectId: extra.projectId } : {},
          )
        ).messages.length > 0,
      "challenge",
    );
    return op.sessionId;
  };
  const owner = async (suffix, body, projectId = p.id) => {
    const response = await fetch(
      `${app.url}/api/projects/${projectId}/${suffix}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: ownerHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    app,
    calls,
    clients,
    p,
    other,
    ownerHeaders,
    config,
    configure,
    connect,
    invoke,
    get,
    start,
    owner,
  };
}

test(
  "HTTP gRPC bidi reads a real challenge, sends once and deduplicates half-close without reconnect",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect(),
      b = await f.connect();
    const sessionId = await f.start(a.client, "start");
    assert.equal(
      decode(
        await f.invoke(a.client, "start", {
          definitionId: "chat",
          operationId: "start",
        }),
      ).sessionId,
      sessionId,
    );
    const page = await f.get(a.client, sessionId);
    const nonce = page.messages[0].message.text.slice("challenge:".length);
    const args = {
      sessionId,
      operationId: "send",
      message: { text: "answer:" + nonce },
    };
    decode(await f.invoke(a.client, "send", args));
    decode(await f.invoke(a.client, "send", args));
    await until(async () =>
      (await f.get(a.client, sessionId)).messages.some(
        (e) => e.message?.text === "accepted:" + nonce,
      ),
    );
    const written = await until(async () => {
      const op = decode(
        await f.invoke(a.client, "operation", { operationId: "send" }),
      );
      return op.state === "locally-written" && op;
    });
    assert.equal(written.remoteConfirmed, false);
    rejected(
      await f.invoke(a.client, "send", {
        ...args,
        message: { text: "different" },
      }),
    );
    rejected(await f.invoke(b.client, "get", { sessionId }));
    rejected(
      await f.invoke(a.client, "get", { sessionId, projectId: f.other.id }),
    );
    rejected(await f.invoke(b.client, "operation", { operationId: "send" }));
    const closeArgs = { sessionId, operationId: "half" };
    decode(await f.invoke(a.client, "half_close", closeArgs));
    decode(await f.invoke(a.client, "half_close", closeArgs));
    const terminal = await until(async () => {
      const page = await f.get(a.client, sessionId);
      return page.lifecycle === "terminal" && page;
    });
    assert.equal(terminal.status.code, grpc.status.OK);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 1);
    assert.equal(f.calls[0].ended, true);
    decode(await f.invoke(a.client, "cancel", { sessionId }));
    assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 1);
  },
);

test(
  "HTTP gRPC DELETE revokes owner and drains terminal evidence before returning",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sessionId = await f.start(a.client, "start");
    const response = await fetch(f.app.url + "/mcp", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + f.config.token,
        "mcp-session-id": a.transport.sessionId,
      },
    });
    assert.equal(response.status, 204);
    await until(() => f.calls[0].cancelled);
    const saved = (await f.app.store.get(f.p.id)).protocolRuns;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, sessionId);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 0);
  },
);

test(
  "HTTP gRPC authorization reduction cancels the live call without sending or restarting",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sessionId = await f.start(a.client, "start");
    await f.configure({ execute: false });
    await until(() => f.calls[0].cancelled);
    rejected(
      await f.invoke(a.client, "send", {
        sessionId,
        operationId: "late",
        message: { text: "forbidden" },
      }),
    );
    assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 0);
  },
);

test(
  "HTTP gRPC archive cancels only the revoked project and preserves another bidi stream",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const first = await f.start(a.client, "first");
    const second = await f.start(a.client, "second", { projectId: f.other.id });
    const before = await fetch(`${f.app.url}/api/projects/${f.p.id}`, {
      headers: f.ownerHeaders,
    }).then((r) => r.json());
    const archived = await fetch(`${f.app.url}/api/projects/${f.p.id}`, {
      method: "PUT",
      headers: f.ownerHeaders,
      body: JSON.stringify({ ...before, archived: true }),
    });
    assert.equal(archived.status, 200, await archived.text());
    await until(() => f.calls[0].cancelled);
    assert.equal(f.calls[1].cancelled, false);
    rejected(await f.invoke(a.client, "get", { sessionId: first }));
    decode(
      await f.invoke(a.client, "send", {
        projectId: f.other.id,
        sessionId: second,
        operationId: "other-send",
        message: { text: "alive" },
      }),
    );
    await until(() => f.calls[1].messages.length === 1);
    assert.equal(f.calls[1].messages[0].text, "alive");
    assert.equal((await f.app.store.get(f.p.id)).protocolRuns.length, 1);
  },
);

test(
  "HTTP MCP gRPC uses the existing five-slot owner pool and refuses non-bidi definitions",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    for (const definitionId of ["watch", "collect", "unary"])
      rejected(
        await f.invoke(a.client, "start", {
          definitionId,
          operationId: definitionId,
        }),
      );
    assert.equal(f.calls.length, 0);
    for (let i = 0; i < 4; i++) {
      const response = await f.owner("grpc-sessions", { definitionId: "chat" });
      assert.equal(response.status, 200, JSON.stringify(response.value));
    }
    await f.start(a.client, "fifth");
    await until(() => f.calls.length === 5);
    const denied = await f.invoke(a.client, "start", {
      definitionId: "chat",
      operationId: "sixth",
    });
    rejected(denied);
    assert.equal(
      JSON.parse(denied.content[0].text).state,
      "failed-before-submit",
    );
    assert.notEqual(
      (await f.owner("grpc-sessions", { definitionId: "chat" })).status,
      200,
    );
    assert.notEqual(
      (
        await f.owner("grpc-run", {
          definitionId: "chat",
          messages: [{ text: "must-not-start" }],
        })
      ).status,
      200,
      "finite RPC execution must share the saturated gRPC slot pool",
    );
    assert.equal(f.calls.length, 5);
  },
);

test(
  "HTTP gRPC uncertain persistence stays unknown and repeated cancel never retries storage or network",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sessionId = await f.start(a.client, "start");
    const append = f.app.store.append.bind(f.app.store);
    let attempts = 0;
    f.app.store.append = async (...args) => {
      if (args[1] === "protocolRuns") {
        attempts++;
        throw new ProjectCommitUncertain(
          f.p.id,
          Error("injected uncertain commit"),
        );
      }
      return append(...args);
    };
    const first = decode(await f.invoke(a.client, "cancel", { sessionId }));
    assert.equal(first.recordSaved, false);
    assert.equal(first.receiptState, "unknown");
    const again = decode(await f.invoke(a.client, "cancel", { sessionId }));
    assert.equal(again.receiptState, "unknown");
    assert.equal(attempts, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].messages.length, 0);
    const response = await fetch(f.app.url + "/mcp", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + f.config.token,
        "mcp-session-id": a.transport.sessionId,
      },
    });
    assert.equal(response.status, 204);
    assert.equal(attempts, 1);
  },
);

test(
  "official stdio SDK without execute grant does not expose or execute interactive gRPC tools",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        f.p.id,
        "--write",
      ],
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stderr: "pipe",
    });
    const client = new Client({ name: "grpc-stdio-denied", version: "1" });
    client.onerror = () => {};
    f.clients.push({ client, transport });
    await client.connect(transport);
    assert.equal(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "localapi_start_grpc_session",
      ),
      false,
    );
    rejected(
      await f.invoke(client, "start", {
        definitionId: "chat",
        operationId: "stdio",
      }),
    );
    assert.equal(f.calls.length, 0);
  },
);

test(
  "HTTP gRPC host shutdown cancels its stream and waits for the original save without replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sessionId = await f.start(a.client, "start");
    const append = f.app.store.append.bind(f.app.store);
    let release,
      saving = false,
      attempts = 0,
      closed = false;
    const gate = new Promise((resolve) => (release = resolve));
    f.app.store.append = async (...args) => {
      if (args[1] === "protocolRuns") {
        attempts++;
        saving = true;
        await gate;
      }
      return append(...args);
    };
    const close = new Promise((resolve) =>
      f.app.server.close(() => {
        closed = true;
        resolve();
      }),
    );
    try {
      await until(() => saving, "save admission");
      await until(() => f.calls[0].cancelled, "physical cancellation");
      assert.equal(closed, false);
      release();
      await close;
      const project = await f.app.store.get(f.p.id);
      assert(project.protocolRuns.some((record) => record.id === sessionId));
      assert.equal(attempts, 1);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].messages.length, 0);
    } finally {
      release();
      await close;
    }
  },
);
