import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  throw Error("Missing TCP observation: " + description);
}
function decode(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}
function failedReceipt(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  const receipt = JSON.parse(result.content[0].text);
  assert.ok(["failed-before-submit", "unknown"].includes(receipt.state));
  return receipt;
}
const rejected = (result) =>
  assert.equal(result.isError, true, JSON.stringify(result));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-tcp-workflow-"));
  const app = await createApp({ root, port: 0 });
  const wsPeer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wsPeer, "listening");
  const clients = [],
    connections = [],
    messages = [];
  const wss = net.createServer().listen(0, "127.0.0.1");
  wss.on("connection", (socket) => {
    const connection = {
      socket,
      nonce: randomUUID(),
      closed: false,
      accepted: 0,
    };
    connections.push(connection);
    socket.on("error", () => {});
    socket.on("close", () => {
      connection.closed = true;
    });
    socket.on("data", (value) => {
      const text = value.toString();
      messages.push({ connection, text });
      if (text === "answer:" + connection.nonce) {
        connection.accepted++;
        socket.write("accepted:" + connection.nonce);
      } else socket.write("echo:" + text);
    });
    socket.write("challenge:" + connection.nonce);
  });
  await once(wss, "listening");
  t.after(async () => {
    for (const { client } of clients) await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    for (const { socket } of connections) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    for (const socket of wsPeer.clients) socket.terminate();
    await new Promise((resolve) => wsPeer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("MCP socket"),
    other = await app.store.create("Other socket");
  for (const project of [p, other]) {
    project.protocols = [
      {
        id: "real-ws",
        type: "websocket",
        url: `ws://127.0.0.1:${wsPeer.address().port}`,
        name: "WS quota peer",
      },
      {
        id: "ws",
        type: "tcp",
        url: "127.0.0.1",
        port: wss.address().port,
        name: "Synthetic nonce challenge",
      },
    ];
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
    const requests = [];
    const transport = new StreamableHTTPClientTransport(
      new URL(app.url + "/mcp"),
      {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
        fetch: (url, init) => {
          if (typeof init?.body === "string")
            requests.push(JSON.parse(init.body));
          return fetch(url, init);
        },
      },
    );
    const client = new Client({ name: "ws-workflow-fixture", version: "1" });
    client.onerror = () => {};
    const item = { client, transport, requests };
    clients.push(item);
    await client.connect(transport);
    return item;
  };
  const invoke = (client, action, args = {}) =>
    client.callTool({
      name:
        action === "operation"
          ? "localapi_get_tcp_operation"
          : `localapi_${action}_tcp_session`,
      arguments: { projectId: p.id, ...args },
    });
  const start = async (client, operationId) => {
    const receipt = decode(
      await invoke(client, "start", { definitionId: "ws", operationId }),
    );
    assert.equal(receipt.state, "started");
    assert.ok(receipt.sessionId);
    await waitFor(
      async () =>
        decode(await invoke(client, "get", { sessionId: receipt.sessionId }))
          .state === "open",
      "socket open",
    );
    return receipt.sessionId;
  };
  return {
    root,
    wsPeer,
    app,
    p,
    other,
    connections,
    messages,
    ownerHeaders,
    config,
    configure,
    connect,
    invoke,
    start,
  };
}

test(
  "official HTTP SDK preserves same-socket challenge, deduplicates operations and DELETE drains owned evidence",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect(),
      b = await f.connect();
    const sessionId = await f.start(a.client, "start-once");
    const duplicate = decode(
      await f.invoke(a.client, "start", {
        definitionId: "ws",
        operationId: "start-once",
      }),
    );
    assert.equal(duplicate.sessionId, sessionId);
    assert.equal(f.connections.length, 1);
    const page = await waitFor(async () => {
      const page = decode(await f.invoke(a.client, "get", { sessionId }));
      return (
        page.events.some((event) => event.data.startsWith("challenge:")) && page
      );
    }, "nonce message");
    const challenge = page.events.find((event) =>
      event.data.startsWith("challenge:"),
    );
    const args = {
      sessionId,
      operationId: "send-once",
      message: "answer:" + challenge.data.slice("challenge:".length),
    };
    decode(await f.invoke(a.client, "send", args));
    decode(await f.invoke(a.client, "send", args));
    await waitFor(
      () => f.connections[0].accepted === 1,
      "same socket challenge accepted once",
    );
    const operation = await waitFor(async () => {
      const op = decode(
        await f.invoke(a.client, "operation", { operationId: "send-once" }),
      );
      return op.state === "locally-written" && op;
    }, "local write receipt");
    assert.equal(operation.remoteConfirmed, false);
    assert.equal(operation.retrySafe, false);
    rejected(
      await f.invoke(a.client, "send", { ...args, message: "different" }),
    );
    for (const [name, args] of [
      ["localapi_get_websocket_session", { sessionId }],
      ["localapi_get_websocket_operation", { operationId: "send-once" }],
      [
        "localapi_send_websocket_session",
        { sessionId, operationId: "cross-protocol", message: "must-not-write" },
      ],
      [
        "localapi_start_websocket_session",
        { definitionId: "real-ws", operationId: "start-once" },
      ],
    ])
      rejected(
        await a.client.callTool({
          name,
          arguments: { projectId: f.p.id, ...args },
        }),
      );
    assert.equal(f.wsPeer.clients.size, 0);
    rejected(await f.invoke(b.client, "get", { sessionId }));
    assert.equal(
      failedReceipt(
        await f.invoke(b.client, "send", { ...args, operationId: "foreign" }),
      ).state,
      "failed-before-submit",
    );
    rejected(
      await f.invoke(b.client, "operation", { operationId: "send-once" }),
    );
    rejected(
      await f.invoke(a.client, "get", { projectId: f.other.id, sessionId }),
    );
    assert.equal(
      failedReceipt(
        await f.invoke(a.client, "send", {
          ...args,
          projectId: f.other.id,
          operationId: "wrong-project",
        }),
      ).state,
      "failed-before-submit",
    );
    rejected(
      await f.invoke(a.client, "start", {
        projectId: "ungranted",
        definitionId: "ws",
        operationId: "ungranted",
      }),
    );
    assert.equal(f.connections.length, 1);
    assert.equal(f.messages.length, 1);
    const startRequests = a.requests.filter(
      (r) => r.params?.name === "localapi_start_tcp_session",
    );
    assert.equal(startRequests.length, 3); // initial, duplicate, unauthorized project
    assert.notEqual(startRequests[0].id, startRequests[1].id);
    const sendRequests = a.requests.filter(
      (r) => r.params?.name === "localapi_send_tcp_session",
    );
    assert.notEqual(sendRequests[0].id, sendRequests[1].id);
    const response = await fetch(f.app.url + "/mcp", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + f.config.token,
        "mcp-session-id": a.transport.sessionId,
      },
    });
    assert.equal(response.status, 204);
    await waitFor(
      () => f.connections[0].closed,
      "DELETE closes physical socket",
    );
    const ownerReceipt = await fetch(
      `${f.app.url}/api/projects/${f.p.id}/protocol-sessions/${sessionId}`,
      { headers: f.ownerHeaders },
    ).then((r) => r.json());
    const saved = await f.app.store.get(f.p.id);
    assert.equal(
      saved.protocolRuns.length,
      1,
      "DELETE returns after initiated record persistence drains: " +
        JSON.stringify(ownerReceipt),
    );
    assert.equal(f.connections.length, 1);
    assert.equal(f.messages.length, 1);
    assert.ok(
      (await b.client.listTools()).tools.some(
        (tool) => tool.name === "localapi_start_tcp_session",
      ),
    );
  },
);

test(
  "HTTP MCP authorization reduction closes real TCP and persists terminal evidence without resend",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sessionId = await f.start(a.client, "revocable");
    await f.configure({ execute: false });
    await waitFor(
      () => f.connections[0].closed,
      "authorization reduction closes socket",
    );
    await waitFor(
      async () => (await f.app.store.get(f.p.id)).protocolRuns.length === 1,
      "revocation terminal evidence",
    );
    rejected(
      await f.invoke(a.client, "send", {
        sessionId,
        operationId: "after-revoke",
        message: "must-not-send",
      }),
    );
    assert.equal(f.connections.length, 1);
    assert.equal(f.messages.length, 0);
  },
);

test(
  "HTTP MCP TCP and owner interactive WebSockets share the existing five-connection quota",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const ownerIds = [];
    for (let i = 0; i < 4; i++) {
      const response = await fetch(
        `${f.app.url}/api/projects/${f.p.id}/protocol-sessions`,
        {
          method: "POST",
          headers: f.ownerHeaders,
          body: JSON.stringify({ definitionId: "real-ws" }),
        },
      );
      assert.equal(response.status, 200);
      ownerIds.push((await response.json()).id);
    }
    await f.start(a.client, "fifth");
    await waitFor(
      () => f.connections.length + f.wsPeer.clients.size === 5,
      "five physical connections",
    );
    const refused = failedReceipt(
      await f.invoke(a.client, "start", {
        definitionId: "ws",
        operationId: "sixth",
      }),
    );
    assert.ok(["failed-before-submit", "unknown"].includes(refused.state));
    assert.equal(f.connections.length, 1);
    assert.equal(f.wsPeer.clients.size, 4);
    const ownerRefused = await fetch(
      `${f.app.url}/api/projects/${f.p.id}/protocol-sessions`,
      {
        method: "POST",
        headers: f.ownerHeaders,
        body: JSON.stringify({ definitionId: "real-ws" }),
      },
    );
    assert.notEqual(ownerRefused.status, 200);
    assert.equal(f.connections.length, 1);
    assert.equal(f.wsPeer.clients.size, 4);
  },
);

test(
  "archiving one project drains only its MCP sockets and preserves another project's live session",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const first = await f.start(a.client, "archive-first");
    const second = decode(
      await f.invoke(a.client, "start", {
        projectId: f.other.id,
        definitionId: "ws",
        operationId: "keep-second",
      }),
    ).sessionId;
    await waitFor(
      async () =>
        decode(
          await f.invoke(a.client, "get", {
            projectId: f.other.id,
            sessionId: second,
          }),
        ).state === "open",
      "other project socket open",
    );
    assert.equal(f.connections.length, 2);
    const before = await fetch(`${f.app.url}/api/projects/${f.p.id}`, {
      headers: f.ownerHeaders,
    }).then((r) => r.json());
    const archived = await fetch(`${f.app.url}/api/projects/${f.p.id}`, {
      method: "PUT",
      headers: f.ownerHeaders,
      body: JSON.stringify({ ...before, archived: true }),
    });
    assert.equal(archived.status, 200, await archived.text());
    await waitFor(
      () => f.connections[0].closed,
      "archived project socket closes",
    );
    assert.equal(f.connections[1].closed, false);
    rejected(await f.invoke(a.client, "get", { sessionId: first }));
    rejected(
      await f.invoke(a.client, "send", {
        sessionId: first,
        operationId: "after-archive",
        message: "must-not-send",
      }),
    );
    decode(
      await f.invoke(a.client, "send", {
        projectId: f.other.id,
        sessionId: second,
        operationId: "still-live",
        message: "other-project-still-live",
      }),
    );
    await waitFor(
      () =>
        f.messages.some(
          (event) =>
            event.connection === f.connections[1] &&
            event.text === "other-project-still-live",
        ),
      "unrelated project's send remains live",
    );
    const firstSaved = await f.app.store.get(f.p.id);
    assert.equal(firstSaved.protocolRuns.length, 1);
    assert.equal(firstSaved.protocolRuns[0].id, first);
    assert.equal((await f.app.store.get(f.other.id)).protocolRuns.length, 0);
    const stopped = decode(
      await f.invoke(a.client, "stop", {
        projectId: f.other.id,
        sessionId: second,
      }),
    );
    assert.equal(stopped.recordSaved, true);
    assert.equal((await f.app.store.get(f.other.id)).protocolRuns.length, 1);
    assert.equal(f.messages.length, 1);
    assert.equal(f.connections.length, 2);
  },
);

// Real TCP HTTP connections with keep-alive disabled. Await the socket's close
// event, not merely the response, before issuing the next request.
async function closedConnectionRPC(f, sessionId, id, name, args) {
  let socket;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const result = new Promise((resolve, reject) => {
    const request = http.request(
      new URL(f.app.url + "/mcp"),
      {
        method: "POST",
        agent: false,
        headers: {
          Authorization: "Bearer " + f.config.token,
          "content-type": "application/json",
          "mcp-session-id": sessionId,
          Connection: "close",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 200, body);
            resolve(JSON.parse(body).result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("socket", (value) => {
      socket = value;
      socket.once("close", resolveClosed);
    });
    request.on("error", reject);
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: { projectId: f.p.id, ...args } },
      }),
    );
  });
  const response = await result;
  await closed;
  assert.equal(socket.destroyed, true);
  return { receipt: decode(response), socket };
}

test(
  "closing physical HTTP connections preserves logical MCP socket ownership and operation deduplication",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sid = a.transport.sessionId;
    const started = await closedConnectionRPC(
      f,
      sid,
      "closed-start-1",
      "localapi_start_tcp_session",
      { definitionId: "ws", operationId: "across-connections" },
    );
    const wsId = started.receipt.sessionId;
    assert.equal(started.receipt.state, "started");
    await waitFor(
      () => f.connections.length === 1,
      "TCP handshake after closed HTTP response",
    );
    const read = await closedConnectionRPC(
      f,
      sid,
      "closed-read-2",
      "localapi_get_tcp_session",
      { sessionId: wsId },
    );
    assert.notEqual(read.socket, started.socket);
    assert.equal(read.receipt.sessionId, wsId);
    assert.equal(read.receipt.state, "open");
    const operation = await closedConnectionRPC(
      f,
      sid,
      "closed-op-3",
      "localapi_get_tcp_operation",
      { operationId: "across-connections" },
    );
    assert.equal(operation.receipt.sessionId, wsId);
    assert.equal(operation.receipt.state, "started");
    const duplicate = await closedConnectionRPC(
      f,
      sid,
      "closed-start-4",
      "localapi_start_tcp_session",
      { definitionId: "ws", operationId: "across-connections" },
    );
    assert.equal(duplicate.receipt.sessionId, wsId);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].closed, false);
    assert.equal(f.messages.length, 0);
    const stopped = decode(
      await f.invoke(a.client, "stop", { sessionId: wsId }),
    );
    assert.equal(stopped.recordSaved, true);
  },
);

test(
  "host server close terminates a real MCP TCP and drains evidence before its callback",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const sessionId = await f.start(a.client, "shutdown-owned");
    await a.client.close();
    assert.equal(
      f.connections[0].closed,
      false,
      "client transport close alone is not logical session DELETE",
    );
    await new Promise((resolve, reject) =>
      f.app.server.close((error) => (error ? reject(error) : resolve())),
    );
    const saved = await f.app.store.get(f.p.id);
    assert.equal(
      saved.protocolRuns.length,
      1,
      "shutdown callback observes completed record persistence",
    );
    assert.equal(saved.protocolRuns[0].id, sessionId);
    assert.equal(saved.protocolRuns[0].result.state, "closed");
    await waitFor(
      () => f.connections[0].closed,
      "remote peer observes physical socket closure",
    );
    assert.equal(f.connections.length, 1);
    assert.equal(f.messages.length, 0);
  },
);

test(
  "unarchive needs a fresh grant; the same logical HTTP session gets a new owner without reviving old sockets",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const logicalId = a.transport.sessionId;
    const old = await f.start(a.client, "before-archive");
    const setArchive = async (archived) => {
      const project = await fetch(`${f.app.url}/api/projects/${f.p.id}`, {
        headers: f.ownerHeaders,
      }).then((r) => r.json());
      const response = await fetch(`${f.app.url}/api/projects/${f.p.id}`, {
        method: "PUT",
        headers: f.ownerHeaders,
        body: JSON.stringify({ ...project, archived }),
      });
      assert.equal(response.status, 200, await response.text());
    };
    await setArchive(true);
    await waitFor(
      () => f.connections[0].closed,
      "archive closes old connection",
    );
    await setArchive(false);
    rejected(
      await f.invoke(a.client, "start", {
        definitionId: "ws",
        operationId: "not-yet-regranted",
      }),
    );
    assert.equal(f.connections.length, 1);
    const configuration = await f.configure();
    assert.equal(configuration.token, f.config.token);
    assert.equal(a.transport.sessionId, logicalId);
    const fresh = await f.start(a.client, "after-regrant");
    assert.notEqual(fresh, old);
    assert.equal(a.transport.sessionId, logicalId);
    rejected(await f.invoke(a.client, "get", { sessionId: old }));
    assert.equal(f.connections[0].closed, true);
    assert.equal(f.connections.length, 2);
    assert.equal(
      decode(await f.invoke(a.client, "stop", { sessionId: fresh }))
        .recordSaved,
      true,
    );
  },
);

test(
  "TCP freezes session variables and terminal evidence survives backup/restart without reconnect",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    const project = await f.app.store.get(f.p.id);
    project.environments[0].variables = { value: "frozen" };
    project.protocols.find((d) => d.id === "ws").templateMode = "variables";
    await f.app.store.save(project);
    const sessionId = await f.start(a.client, "frozen-start");
    const changed = await f.app.store.get(f.p.id);
    changed.environments[0].variables.value = "edited";
    await f.app.store.save(changed);
    decode(await f.invoke(a.client, "renew", { sessionId }));
    decode(
      await f.invoke(a.client, "send", {
        sessionId,
        operationId: "frozen-send",
        message: "value={{value}}",
      }),
    );
    await waitFor(() => f.messages.length === 1, "frozen variable write");
    assert.equal(f.messages[0].text, "value=frozen");
    const stopped = decode(await f.invoke(a.client, "stop", { sessionId }));
    assert.equal(stopped.recordSaved, true);
    const saved = await f.app.store.get(f.p.id);
    assert.equal(saved.protocolRuns.length, 1);
    const exported = await fetch(`${f.app.url}/api/projects/${f.p.id}/export`, {
      headers: f.ownerHeaders,
    });
    assert.equal(exported.status, 200);
    const document = await exported.json();
    const restored = await fetch(f.app.url + "/api/restore", {
      method: "POST",
      headers: f.ownerHeaders,
      body: JSON.stringify({ document }),
    });
    assert.equal(restored.status, 201);
    const restoredProject = await restored.json();
    assert.deepEqual(restoredProject.protocolRuns, saved.protocolRuns);
    assert.deepEqual(restoredProject.protocols, saved.protocols);
    await a.client.close();
    await new Promise((resolve) => f.app.server.close(resolve));
    const restarted = await createApp({ root: f.root, port: 0 });
    t.after(async () => {
      restarted.server.closeAllConnections();
      await new Promise((resolve) => restarted.server.close(resolve));
    });
    assert.deepEqual(
      (await restarted.store.get(f.p.id)).protocolRuns,
      saved.protocolRuns,
    );
    assert.deepEqual(
      (await restarted.store.get(restoredProject.id)).protocolRuns,
      saved.protocolRuns,
    );
    await delay(100);
    assert.equal(f.connections.length, 1);
    assert.equal(f.messages.length, 1);
    assert.equal(f.connections[0].closed, true);
  },
);

test(
  "TCP rejects unsupported saved definition fields before creating any socket",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    for (const [key, value] of Object.entries({
      completion: "first-data",
      duration: 1000,
    })) {
      const p = await f.app.store.get(f.p.id);
      const clean = { ...p.protocols.find((d) => d.id === "ws") };
      p.protocols = [{ ...clean, [key]: value }];
      await f.app.store.save(p);
      rejected(
        await f.invoke(a.client, "start", {
          definitionId: "ws",
          operationId: "unsupported-" + key,
        }),
      );
      p.protocols = [clean];
      await f.app.store.save(p);
    }
    assert.equal(f.connections.length, 0);
  },
);
