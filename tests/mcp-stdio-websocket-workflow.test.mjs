import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";

const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw Error("stdio WebSocket observation timeout");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "stdio-ws-sdk-"));
  const store = new Store(root);
  await store.init();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const connections = [],
    clients = [];
  wss.on("connection", (socket) => {
    const connection = {
      socket,
      nonce: randomUUID(),
      messages: [],
      closed: false,
    };
    connections.push(connection);
    socket.on("error", () => {});
    socket.on("close", () => (connection.closed = true));
    socket.on("message", (message) => {
      connection.messages.push(message.toString());
      socket.send("echo:" + message);
    });
    socket.send("challenge:" + connection.nonce);
  });
  const project = await store.create("stdio WebSocket"),
    other = await store.create("not granted");
  for (const p of [project, other]) {
    p.protocols = [
      {
        id: "ws",
        type: "websocket",
        name: "loopback",
        url: `ws://127.0.0.1:${wss.address().port}`,
      },
    ];
    await store.save(p);
  }
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const connect = async (grants = ["--write", "--execute"]) => {
    const client = new Client({ name: "stdio-ws-test", version: "1" });
    client.onerror = () => {};
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [main, "--project", project.id, ...grants],
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    });
    clients.push(client);
    await client.connect(transport);
    return client;
  };
  const invoke = (client, action, args = {}) =>
    client.callTool({
      name:
        action === "operation"
          ? "localapi_get_websocket_operation"
          : `localapi_${action}_websocket_session`,
      arguments: { projectId: project.id, ...args },
    });
  const start = async (client, operationId) => {
    const receipt = decode(
      await invoke(client, "start", { definitionId: "ws", operationId }),
    );
    assert.equal(receipt.state, "started");
    await waitFor(
      async () =>
        decode(await invoke(client, "get", { sessionId: receipt.sessionId }))
          .state === "open",
    );
    return receipt.sessionId;
  };
  return { root, store, project, other, connections, connect, invoke, start };
}

test(
  "official stdio SDK keeps one challenge socket, deduplicates and EOF persists terminal history",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      client = await f.connect();
    const sessionId = await f.start(client, "once");
    assert.equal(
      decode(
        await f.invoke(client, "start", {
          definitionId: "ws",
          operationId: "once",
        }),
      ).sessionId,
      sessionId,
    );
    const page = await waitFor(async () => {
      const value = decode(await f.invoke(client, "get", { sessionId }));
      return value.events.some((e) => e.data.startsWith("challenge:")) && value;
    });
    const message =
      "answer:" +
      page.events.find((e) => e.data.startsWith("challenge:")).data.slice(10);
    const args = { sessionId, operationId: "send", message };
    decode(await f.invoke(client, "send", args));
    decode(await f.invoke(client, "send", args));
    await waitFor(() => f.connections[0].messages.length === 1);
    assert.equal(f.connections[0].messages[0], message);
    assert.equal(f.connections.length, 1);
    assert.equal(
      (await f.invoke(client, "send", { ...args, message: "changed" })).isError,
      true,
    );
    assert.equal(
      (
        await f.invoke(client, "start", {
          projectId: f.other.id,
          definitionId: "ws",
          operationId: "denied",
        })
      ).isError,
      true,
    );
    const operation = await waitFor(async () => {
      const op = decode(
        await f.invoke(client, "operation", { operationId: "send" }),
      );
      return op.state === "locally-written" && op;
    });
    assert.equal(operation.remoteConfirmed, false);
    assert.equal(operation.retrySafe, false);
    await client.close();
    assert.equal(f.connections[0].closed, true);
    const saved = await f.store.get(f.project.id);
    assert.equal(saved.protocolRuns.length, 1);
    assert.equal(saved.protocolRuns[0].id, sessionId);
    assert.equal(f.connections[0].messages.length, 1);
  },
);

test(
  "stdio exposes WebSocket only with both startup grants",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const websocketNames = [
      "localapi_start_websocket_session",
      "localapi_get_websocket_session",
      "localapi_send_websocket_session",
      "localapi_stop_websocket_session",
      "localapi_renew_websocket_session",
      "localapi_get_websocket_operation",
    ];
    const authorized = await f.connect();
    const tools = (await authorized.listTools()).tools;
    const names = new Set(tools.map((tool) => tool.name));
    assert.equal(tools.length, 93);
    assert.equal(names.size, 93);
    assert.equal(
      tools.filter((tool) => tool.name.startsWith("localapi_")).length,
      63,
    );
    assert.equal(
      tools.filter((tool) => tool.name.startsWith("apipost_")).length,
      30,
    );
    for (const name of websocketNames) assert(names.has(name), name);
    await authorized.close();
    for (const flags of [[], ["--write"], ["--execute"]]) {
      const client = await f.connect(flags);
      const names = new Set(
        (await client.listTools()).tools.map((tool) => tool.name),
      );
      for (const name of websocketNames)
        assert.equal(names.has(name), false, name);
      assert.equal(
        (
          await f.invoke(client, "start", {
            definitionId: "ws",
            operationId: "denied",
          })
        ).isError,
        true,
      );
      await client.close();
    }
    assert.equal(f.connections.length, 0);
  },
);

test(
  "two stdio processes have separate five-slot pools and cannot read each other's operations",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect(),
      b = await f.connect();
    const aIds = [];
    for (let i = 0; i < 5; i++) aIds.push(await f.start(a, "a" + i));
    assert.equal(
      (
        await f.invoke(a, "start", {
          definitionId: "ws",
          operationId: "overflow",
        })
      ).isError,
      true,
    );
    const bId = await f.start(b, "a0");
    assert.notEqual(bId, aIds[0]);
    assert.equal(f.connections.length, 6);
    assert.equal(
      (await f.invoke(b, "get", { sessionId: aIds[0] })).isError,
      true,
    );
    assert.equal(
      (await f.invoke(b, "operation", { operationId: "a1" })).isError,
      true,
    );
    await a.close();
    await waitFor(() => f.connections.slice(0, 5).every((c) => c.closed));
    assert.equal(
      decode(await f.invoke(b, "get", { sessionId: bId })).state,
      "open",
    );
    await b.close();
  },
);

test(
  "HTTP token rotation and permission reduction do not revoke independent stdio startup grants",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      client = await f.connect();
    const sessionId = await f.start(client, "start");
    const app = await createApp({ root: f.root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    });
    for (const config of [
      { enabled: true, projects: [f.project.id], write: true, execute: true },
      {
        enabled: true,
        projects: [f.project.id],
        write: true,
        execute: true,
        rotate: true,
      },
      { enabled: false, projects: [], write: false, execute: false },
    ]) {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(config),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(
      decode(await f.invoke(client, "get", { sessionId })).state,
      "open",
    );
    decode(
      await f.invoke(client, "send", {
        sessionId,
        operationId: "after-owner-revoke",
        message: "still-startup-authorized",
      }),
    );
    await waitFor(() => f.connections[0].messages.length === 1);
    await client.close();
  },
);
