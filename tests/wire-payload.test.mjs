import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { protocolPayload } from "../src/protocol-payload.mjs";
import { exchangeTCP, exchangeWebSocket } from "../src/protocols.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
import { Store } from "../src/runtime.mjs";
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("protocol fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function websocket(
  t,
  { secure = false, mtls = false, auth = false, onMessage } = {},
) {
  const key = await readFile(
      new URL("./fixtures/localhost.key", import.meta.url),
      "utf8",
    ),
    ca = await readFile(
      new URL("./fixtures/localhost.crt", import.meta.url),
      "utf8",
    );
  const server = secure
    ? https.createServer({
        key,
        cert: ca,
        ...(mtls ? { requestCert: true, rejectUnauthorized: true, ca } : {}),
      })
    : http.createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let handshakes = 0;
  server.on("upgrade", (req, socket, head) => {
    handshakes++;
    if (auth && req.headers.authorization !== "Bearer fixture-only") {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("message", (data, binary) => {
      if (onMessage) onMessage(ws, data, binary);
      else ws.send(data, { binary });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return {
    url: `${secure ? "wss" : "ws"}://localhost:${server.address().port}`,
    ca,
    key,
    handshakes: () => handshakes,
    wss,
  };
}
test("protocol payloads preserve binary bytes and explicit UTF-8 byte-width/delimiter semantics", () => {
  assert.equal(
    protocolPayload({ encoding: "hex", data: "00ff0180" }).buffer.toString(
      "base64",
    ),
    "AP8BgA==",
  );
  assert.equal(
    protocolPayload({ encoding: "base64", data: "AP8BgA==" }).buffer.toString(
      "hex",
    ),
    "00ff0180",
  );
  assert.equal(
    protocolPayload({
      format: "fixed",
      fields: [
        { value: "中", width: 4 },
        { value: "7", width: 3, pad: "0", align: "right" },
      ],
    }).buffer.toString(),
    "中 007",
  );
  assert.equal(
    protocolPayload({
      format: "delimited",
      delimiter: "|",
      fields: ["first", "", "third"],
      trailing: true,
    }).buffer.toString(),
    "first||third|",
  );
  for (const value of [
    { encoding: "hex", data: "0" },
    { encoding: "base64", data: "YQ" },
    { encoding: "hex", data: "zz" },
    { format: "fixed", fields: [{ value: "中", width: 2 }] },
    { format: "fixed", fields: [{ value: "x", width: 8, pad: "中" }] },
    { format: "iso8583", fields: [] },
    { encoding: "utf8", data: "\ud800" },
  ])
    assert.throws(() => protocolPayload(value));
  assert.throws(
    () =>
      protocolPayload({
        format: "fixed",
        fields: [
          { value: "", width: 1024 * 1024 },
          { value: "", width: 1 },
        ],
      }),
    /1MiB/,
  );
});
test("TCP exchanges exact binary bytes and saved packet definitions survive reload", async (t) => {
  const sockets = new Set(),
    server = net.createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("data", (b) => s.end(b));
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const message = { encoding: "hex", data: "00ff0180" },
    result = await exchangeTCP({
      host: "127.0.0.1",
      port: server.address().port,
      message,
    });
  assert.equal(result.base64, "AP8BgA==");
  assert.equal(result.size, 4);
  const root = await mkdtemp(path.join(tmpdir(), "wire-definitions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("wire");
  project.protocols = [
    normalizeProtocol({
      type: "tcp",
      url: "127.0.0.1",
      port: server.address().port,
      message,
      receiveEncoding: "base64",
    }),
  ];
  await store.save(project);
  const saved = await new Store(root).get(project.id);
  assert.deepEqual(saved.protocols[0].message, message);
  assert.equal(saved.protocols[0].receiveEncoding, "base64");
  const again = await exchangeTCP({
    host: saved.protocols[0].url,
    port: saved.protocols[0].port,
    message: saved.protocols[0].message,
  });
  assert.equal(again.base64, result.base64);
});
test("interactive TCP preserves split UTF-8 or explicit binary encoding", async (t) => {
  const sockets = new Set(),
    server = net.createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("data", async () => {
        const bytes = Buffer.from("中文");
        for (const b of bytes) {
          s.write(Buffer.from([b]));
          await new Promise((r) => setTimeout(r, 2));
        }
        s.end();
      });
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const sessions = new ProtocolSessions();
  t.after(() => sessions.close());
  for (const receiveEncoding of ["utf8", "hex"]) {
    const s = sessions.start({
      type: "tcp",
      host: "127.0.0.1",
      port: server.address().port,
      receiveEncoding,
    });
    await until(() => sessions.snapshot(s.id).state === "open");
    sessions.send(s.id, "go");
    await until(() => sessions.snapshot(s.id).state === "closed");
    const values = sessions
      .snapshot(s.id)
      .events.filter((e) => e.direction === "received")
      .map((e) => e.data)
      .join("");
    assert.equal(
      values,
      receiveEncoding === "utf8" ? "中文" : Buffer.from("中文").toString("hex"),
    );
  }
});
test("WebSocket real text/binary and empty-binary frames use explicit authentication and subprotocols", async (t) => {
  const fixture = await websocket(t, { auth: true });
  for (const [message, encoding, data] of [
    ["中文", "utf8", "中文"],
    [{ encoding: "hex", data: "00ff0180" }, "base64", "AP8BgA=="],
    [{ encoding: "hex", data: "" }, "base64", ""],
  ]) {
    const result = await exchangeWebSocket({
      url: fixture.url,
      message,
      headers: { Authorization: "Bearer fixture-only" },
      protocols: ["fixture.v1"],
      maxMessages: 1,
    });
    assert.equal(result.protocol, "fixture.v1");
    assert.equal(result.messages[0].encoding, encoding);
    assert.equal(result.messages[0].data, data);
  }
  await assert.rejects(
    exchangeWebSocket({ url: fixture.url, message: "denied" }),
    /403/,
  );
});
test("WebSocket rejects oversize native frames and pre-cancellation before opening transport", async (t) => {
  const fixture = await websocket(t, {
    onMessage: (ws) => ws.send(Buffer.alloc(1024 * 1024 + 1)),
  });
  await assert.rejects(
    exchangeWebSocket({ url: fixture.url, message: "large" }),
    /payload|1 MiB|length/i,
  );
  const count = fixture.handshakes(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exchangeWebSocket({ url: fixture.url }, controller.signal),
  );
  assert.equal(fixture.handshakes(), count);
  assert.throws(
    () =>
      exchangeWebSocket({
        url: fixture.url,
        headers: { "Sec-WebSocket-Key": "override" },
      }),
    /保留/,
  );
  assert.throws(
    () =>
      exchangeWebSocket({
        url: fixture.url,
        tls: { rejectUnauthorized: false },
      }),
    /校验/,
  );
});
test("WebSocket strict TLS/mTLS succeeds only with trusted certificate material", async (t) => {
  const fixture = await websocket(t, { secure: true, mtls: true });
  await assert.rejects(
    exchangeWebSocket({ url: fixture.url, message: "untrusted" }),
    /证书|certificate|self.signed/i,
  );
  await assert.rejects(
    exchangeWebSocket({
      url: fixture.url,
      tls: { ca: fixture.ca },
      message: "no client certificate",
    }),
  );
  const result = await exchangeWebSocket({
    url: fixture.url,
    tls: { ca: fixture.ca, key: fixture.key, cert: fixture.ca },
    message: "mutual",
    maxMessages: 1,
  });
  assert.equal(result.messages[0].data, "mutual");
});
test("interactive WebSocket binary messages retain encoding and stop without late event mutation", async (t) => {
  const fixture = await websocket(t),
    sessions = new ProtocolSessions();
  t.after(() => sessions.close());
  const s = sessions.start({ type: "websocket", url: fixture.url });
  await until(() => sessions.snapshot(s.id).state === "open");
  sessions.send(s.id, { encoding: "base64", data: "AP8BgA==" });
  await until(() =>
    sessions.snapshot(s.id).events.some((e) => e.direction === "received"),
  );
  const event = sessions
    .snapshot(s.id)
    .events.find((e) => e.direction === "received");
  assert.equal(event.encoding, "base64");
  assert.equal(event.data, "AP8BgA==");
  sessions.stop(s.id);
  const count = sessions.snapshot(s.id).events.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.snapshot(s.id).events.length, count);
  assert.equal(sessions.snapshot(s.id).state, "closed");
});

test("TCP duration-cut data is marked partial and pre-aborted calls never connect", async (t) => {
  let connections = 0;
  const sockets = new Set(),
    server = net.createServer((s) => {
      connections++;
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("data", () => s.write("partial"));
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const input = {
    host: "127.0.0.1",
    port: server.address().port,
    message: "request",
    duration: 100,
  };
  const result = await exchangeTCP(input);
  assert.equal(result.body, "partial");
  assert.equal(result.partial, true);
  assert.equal(result.timedOut, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exchangeTCP(input, controller.signal));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(connections, 1);
});
test("WebSocket duration capture reports timeout rather than invented completion", async (t) => {
  const fixture = await websocket(t, { onMessage: () => {} });
  const result = await exchangeWebSocket({
    url: fixture.url,
    message: "no reply",
    duration: 100,
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.messages, []);
});
