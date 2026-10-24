import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { Server } from "socket.io";
import { SocketIOSessions } from "../src/socketio.mjs";
import { boundedPollingUsage } from "../src/socketio-polling.mjs";
const cert = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  ),
  key = await readFile(
    new URL("./fixtures/localhost.key", import.meta.url),
    "utf8",
  );
const wait = async (fn) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture timeout");
};
async function serverFixture(t, { secure = false, upgrade = false } = {}) {
  const server = secure
    ? https.createServer({
        ca: cert,
        key,
        cert,
        requestCert: true,
        rejectUnauthorized: true,
      })
    : http.createServer();
  const io = new Server(server, {
    path: "/bounded/",
    transports: upgrade ? ["polling", "websocket"] : ["polling"],
  });
  const nsp = io.of("/private");
  let connections = 0,
    disconnections = 0;
  const seen = [];
  nsp.use((s, next) =>
    s.handshake.auth.token === "fixture-token" &&
    s.handshake.query.tenant === "one" &&
    s.handshake.headers["x-fixture"] === "yes"
      ? next()
      : next(Error("denied")),
  );
  nsp.on("connection", (s) => {
    connections++;
    s.on("echo", (v, ack) => {
      seen.push(v);
      ack(v);
    });
    s.on("disconnect", () => disconnections++);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => io.close(r)));
  return {
    url: `${secure ? "https://localhost" : "http://127.0.0.1"}:${server.address().port}/private`,
    path: "/bounded/",
    get connections() {
      return connections;
    },
    get disconnections() {
      return disconnections;
    },
    get engineClients() {
      return io.engine.clientsCount;
    },
    seen,
  };
}
const config = (f) => ({
  url: f.url,
  path: f.path,
  transport: "polling",
  auth: { token: "fixture-token" },
  query: { tenant: "one" },
  headers: { "x-fixture": "yes" },
});
test("bounded official Socket.IO polling supports namespace auth, binary ack and clean shutdown", async (t) => {
  const f = await serverFixture(t),
    sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const s = sessions.start("p", config(f));
  await wait(() => sessions.snapshot("p", s.id).state === "open");
  assert.equal(sessions.snapshot("p", s.id).transport, "polling");
  const ack = await sessions.send("p", s.id, {
    event: "echo",
    args: [{ $binary: "AQID/w==" }],
    ackTimeoutMs: 1000,
  });
  assert.equal(ack.status, "acknowledged");
  assert.equal(ack.args[0].$binary, "AQID/w==");
  assert(Buffer.isBuffer(f.seen[0]));
  sessions.stop("p", s.id);
  await wait(() => f.disconnections === 1);
  await wait(() => f.engineClients === 0);
  await wait(() => boundedPollingUsage().active === 0);
  assert(
    !JSON.stringify(sessions.snapshot("p", s.id)).includes("fixture-token"),
  );
});
test("bounded polling upgrades once through official Engine.IO and keeps TLS verification", async (t) => {
  const f = await serverFixture(t, { secure: true, upgrade: true }),
    sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const bad = sessions.start("p", config(f));
  await wait(() => sessions.snapshot("p", bad.id).state === "error");
  assert.equal(f.connections, 0);
  const good = sessions.start("p", {
    ...config(f),
    transport: "auto",
    tls: { ca: cert, key, cert },
  });
  await wait(() => sessions.snapshot("p", good.id).state === "open");
  await wait(() => sessions.snapshot("p", good.id).transport === "websocket");
  assert.equal(
    (
      await sessions.send("p", good.id, {
        event: "echo",
        args: [{ secure: true }],
        ackTimeoutMs: 1000,
      })
    ).status,
    "acknowledged",
  );
  assert.equal(f.connections, 1);
  sessions.stop("p", good.id);
  await wait(() => boundedPollingUsage().active === 0);
});
test("polling refuses redirects without forwarding credentials or connecting the redirected destination", async (t) => {
  let destinationCalls = 0;
  const destination = http.createServer((_q, r) => {
    destinationCalls++;
    r.end("unexpected");
  });
  await new Promise((r) => destination.listen(0, "127.0.0.1", r));
  const redirect = http.createServer((_q, r) => {
    r.writeHead(302, {
      location: `http://127.0.0.1:${destination.address().port}/`,
    });
    r.end();
  });
  await new Promise((r) => redirect.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of [redirect, destination]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });
  const sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const s = sessions.start("p", {
    url: `http://127.0.0.1:${redirect.address().port}`,
    transport: "polling",
    headers: { authorization: "fixture-only" },
  });
  await wait(() => sessions.snapshot("p", s.id).state === "error");
  assert.equal(destinationCalls, 0);
  assert.match(sessions.snapshot("p", s.id).error, /302/);
  await wait(() => boundedPollingUsage().active === 0);
});
test("polling stops oversized chunked responses while reading instead of buffering their full body", async (t) => {
  let chunks = 0,
    closed = false;
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => {
      chunks++;
      res.write(Buffer.alloc(65536, 120));
      if (chunks === 40) {
        clearInterval(timer);
        res.end();
      }
    }, 2);
    res.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const s = sessions.start("p", {
    url: `http://127.0.0.1:${server.address().port}`,
    transport: "polling",
  });
  await wait(() => sessions.snapshot("p", s.id).state === "error");
  await wait(() => closed);
  assert(chunks < 40);
  assert.match(sessions.snapshot("p", s.id).error, /1MiB/);
  await wait(() => boundedPollingUsage().active === 0);
});

test("polling saved definitions execute through fixed plans and restore without transport secrets", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { Store } = await import("../src/runtime.mjs");
  const { restoreProject } = await import("../src/core.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await serverFixture(t),
    root = await mkdtemp(join(tmpdir(), "polling-plan-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("polling"),
    base = app.url + "/api/projects/" + p.id,
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
    const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  };
  const { definition } = await post("socketio-definitions", {
    id: "poll",
    url: f.url,
    path: f.path,
    transport: "polling",
  });
  assert.equal(definition.transport, "polling");
  const plan = await post("plans", {
    steps: [
      {
        id: "step",
        type: "socketio",
        socketio: {
          definitionId: "poll",
          commands: [
            {
              type: "emit",
              event: "echo",
              args: [{ value: 7 }],
              ackTimeoutMs: 1000,
            },
          ],
        },
      },
    ],
  });
  const { auth, query, headers: extraHeaders } = config(f);
  const run = await post("run", {
    planId: plan.id,
    socketioCredentials: { step: { auth, query, headers: extraHeaders } },
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(run.results[0].socketioResult.results[0].args, [
    { value: 7 },
  ]);
  await wait(() => boundedPollingUsage().active === 0);
  await wait(() => f.engineClients === 0);
  const restored = restoreProject({
    ...(await app.store.get(p.id)),
    version: 1,
  });
  await app.store.save(restored);
  const copy = await new Store(root).get(restored.id);
  assert.equal(copy.settings.socketioDefinitions[0].transport, "polling");
  assert.equal(copy.plans[0].steps[0].socketio.definition.transport, "polling");
  assert(!JSON.stringify(copy).includes("fixture-token"));
});
test("polling cancels pending handshake requests and refuses protocol-control query/header overrides", async (t) => {
  let arrived = false,
    closed = false;
  const server = http.createServer((req, res) => {
    arrived = true;
    res.on("close", () => (closed = true));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const definition = {
    url: `http://127.0.0.1:${server.address().port}`,
    transport: "polling",
  };
  for (const input of [
    { ...definition, query: { sid: "not-a-new-session" } },
    { ...definition, headers: { "content-length": "100" } },
    { ...definition, headers: { "accept-encoding": "gzip" } },
  ])
    assert.throws(() => sessions.start("p", input), /不可覆盖/);
  assert.equal(arrived, false);
  const s = sessions.start("p", definition);
  await wait(() => arrived);
  sessions.stop("p", s.id);
  await wait(() => boundedPollingUsage().active === 0);
  await wait(() => closed);
  assert.equal(sessions.snapshot("p", s.id).state, "closed");
});

test("polling rejects oversized declarations, invalid UTF-8, unsolicited compression and HTTP denial without fallback", async (t) => {
  for (const kind of ["length", "utf8", "compressed", "denied"]) {
    let upgrades = 0;
    const server = http.createServer((_req, res) => {
      if (kind === "length") {
        res.writeHead(200, { "content-length": String(1024 * 1024 + 1) });
        res.end("x");
      } else if (kind === "utf8") res.end(Buffer.from([255, 254]));
      else if (kind === "compressed") {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end("not-used");
      } else {
        res.writeHead(401);
        res.end("denied");
      }
    });
    server.on("upgrade", (_req, socket) => {
      upgrades++;
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const sessions = new SocketIOSessions();
    try {
      const s = sessions.start("p", {
        url: `http://127.0.0.1:${server.address().port}`,
        transport: "auto",
      });
      await wait(() => sessions.snapshot("p", s.id).state === "error");
      const error = sessions.snapshot("p", s.id).error;
      assert.match(
        error,
        kind === "length"
          ? /1MiB/
          : kind === "utf8"
            ? /encoding|UTF|utf/
            : kind === "compressed"
              ? /压缩/
              : /401/,
      );
      assert.equal(upgrades, 0);
      await wait(() => boundedPollingUsage().active === 0);
    } finally {
      sessions.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
});
test("polling acquisition pool is bounded and cancelling transports releases every pending request", async (t) => {
  const { BoundedPolling } = await import("../src/socketio-polling.mjs");
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const transports = Array.from(
    { length: 21 },
    () =>
      new BoundedPolling({
        hostname: "127.0.0.1",
        port: server.address().port,
        secure: false,
        path: "/socket.io/",
        query: { EIO: 4, transport: "polling" },
        socket: { binaryType: "arraybuffer" },
      }),
  );
  const pending = transports
    .slice(0, 20)
    .map((x) => x._fetch().catch((error) => error));
  assert.equal(boundedPollingUsage().active, 20);
  await assert.rejects(transports[20]._fetch(), /20项/);
  for (const transport of transports) transport.onClose();
  await Promise.all(pending);
  assert.equal(boundedPollingUsage().active, 0);
  await assert.rejects(
    transports[20]._fetch("x".repeat(1024 * 1024 + 1)),
    /closed|1MiB/,
  );
});

test("malformed Engine.IO handshake cannot hang or crash the client process", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const file = new URL("../src/socketio.mjs", import.meta.url).href;
  const server = http.createServer((_req, res) =>
    res.end(
      "0" +
        JSON.stringify({
          sid: "fixture",
          upgrades: { length: 1e12 },
          pingInterval: 25000,
          pingTimeout: 20000,
          maxPayload: 1000000,
        }),
    ),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const code = `import {SocketIOSessions} from ${JSON.stringify(file)};const sessions=new SocketIOSessions();const s=sessions.start('p',{url:'http://127.0.0.1:${server.address().port}',transport:'polling'});let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);const value=sessions.snapshot('p',s.id);sessions.close();if(value.state!=='error')process.exitCode=1;else process.stdout.write(JSON.stringify({state:value.state,error:value.error}));};const timer=setTimeout(finish,3000);if(sessions.snapshot('p',s.id).state==='error')finish();else sessions.get('p',s.id).socket.once('connect_error',finish);`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", code],
    { timeout: 5000, maxBuffer: 100000 },
  );
  assert.equal(JSON.parse(stdout).state, "error");
  assert.match(JSON.parse(stdout).error, /握手|handshake/);
});

test("WebSocket transport applies the same malformed-handshake guard before upstream processing", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { WebSocketServer } = await import("ws");
  const server = http.createServer(),
    ws = new WebSocketServer({ server });
  ws.on("connection", (socket) =>
    socket.send(
      "0" +
        JSON.stringify({
          sid: "fixture",
          upgrades: { length: 1e12 },
          pingInterval: 25000,
          pingTimeout: 20000,
          maxPayload: 1000000,
        }),
    ),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise((r) => ws.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const file = new URL("../src/socketio.mjs", import.meta.url).href;
  const code = `import {SocketIOSessions} from ${JSON.stringify(file)};const sessions=new SocketIOSessions();const s=sessions.start('p',{url:'http://127.0.0.1:${server.address().port}',transport:'websocket'});let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);const value=sessions.snapshot('p',s.id);sessions.close();if(value.state!=='error')process.exitCode=1;else process.stdout.write(JSON.stringify({state:value.state,error:value.error}));};const timer=setTimeout(finish,3000);if(sessions.snapshot('p',s.id).state==='error')finish();else sessions.get('p',s.id).socket.once('connect_error',finish);`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", code],
    { timeout: 5000, maxBuffer: 100000 },
  );
  assert.equal(JSON.parse(stdout).state, "error");
  assert.match(JSON.parse(stdout).error, /握手|handshake/);
});
test("Engine.IO handshake guards validate metadata and clamp only the client payload budget", async () => {
  const { checkedEngineIOPacket } = await import(
    "../src/socketio-handshake.mjs"
  );
  const valid = {
    sid: "fixture",
    upgrades: ["websocket"],
    pingInterval: 25000,
    pingTimeout: 20000,
    maxPayload: 2000000,
  };
  assert.equal(
    JSON.parse(
      checkedEngineIOPacket({ type: "open", data: JSON.stringify(valid) }).data,
    ).maxPayload,
    1024 * 1024,
  );
  for (const extra of [
    { sid: "\ud800" },
    { sid: "x".repeat(257) },
    { upgrades: { length: 1e12 } },
    { pingInterval: Infinity },
    { pingTimeout: -1 },
    { maxPayload: 0 },
  ])
    assert.throws(() =>
      checkedEngineIOPacket({
        type: "open",
        data: JSON.stringify({ ...valid, ...extra }),
      }),
    );
  assert.throws(
    () =>
      checkedEngineIOPacket(
        { type: "open", data: JSON.stringify(valid) },
        "already-connected",
      ),
    /重复握手/,
  );
});
