import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import {
  SocketIOSessions,
  normalizeSocketIODefinition,
} from "../src/socketio.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > end) throw Error("legacy fixture deadline");
    await delay(5);
  }
}
async function fixture(t, tls = null) {
  const h = tls ? https.createServer(tls) : http.createServer(),
    io = new Server(h, { allowEIO3: true });
  let connections = 0;
  const replies = [];
  io.of("/legacy").use((s, next) =>
    s.handshake.query.token === "fixture" &&
    s.handshake.headers["x-fixture"] === "yes"
      ? next()
      : next(Error("denied")),
  );
  io.of("/legacy").on("connection", (s) => {
    connections++;
    s.on("echo", (v, ack) => {
      s.emit("answer", v);
      ack?.(v);
    });
    s.on("ask", () => s.emit("question", "value", (v) => replies.push(v)));
    s.on("slow", (_v, ack) => setTimeout(() => ack?.("late"), 200));
    s.on("burst", () => {
      for (let i = 0; i < 16; i++) s.emit("ignored", "x".repeat(600000));
    });
  });
  await new Promise((r) => h.listen(0, "127.0.0.1", r));
  const sessions = new SocketIOSessions();
  t.after(async () => {
    sessions.close();
    await new Promise((r) => io.close(r));
  });
  return {
    sessions,
    replies,
    connections: () => connections,
    input: {
      version: 2,
      url: `${tls ? "https://localhost" : "http://127.0.0.1"}:${h.address().port}/legacy`,
      query: { token: "fixture" },
      headers: { "x-fixture": "yes" },
    },
  };
}
test("legacy EIO3 namespace, query/header auth, binary events and bidirectional ACK use isolated sessions", async (t) => {
  const f = await fixture(t),
    id = f.sessions.start("p", f.input).id;
  await until(() => f.sessions.snapshot("p", id).state === "open");
  assert.equal(f.sessions.snapshot("p", id).definition.version, 2);
  assert.equal(f.sessions.get("p", id).socket.io.engine.transport.query.EIO, 3);
  const result = await f.sessions.send("p", id, {
    event: "echo",
    args: [{ $binary: "AAEC/w==" }],
    ackTimeoutMs: 1000,
  });
  assert.equal(result.status, "acknowledged");
  assert.deepEqual(result.args, [{ $binary: "AAEC/w==" }]);
  await until(() =>
    f.sessions.snapshot("p", id).events.some((e) => e.event === "answer"),
  );
  await f.sessions.send("p", id, { event: "ask", args: [] });
  await until(() =>
    f.sessions.snapshot("p", id).events.some((e) => e.event === "question"),
  );
  const question = f.sessions
    .snapshot("p", id)
    .events.find((e) => e.event === "question");
  assert.throws(
    () =>
      f.sessions.acknowledge("other", id, {
        ackId: question.ackId,
        args: ["yes"],
      }),
    /不存在/,
  );
  f.sessions.acknowledge("p", id, { ackId: question.ackId, args: ["yes"] });
  await until(() => f.replies.length === 1);
  const timeout = await f.sessions.send("p", id, {
    event: "slow",
    args: ["x"],
    ackTimeoutMs: 50,
  });
  assert.equal(timeout.status, "ack-timeout");
  await delay(230);
  assert.equal(Object.keys(f.sessions.get("p", id).socket.acks).length, 0);
  f.sessions.stop("p", id);
  await delay(20);
  assert.equal(f.connections(), 1);
});
test("legacy definitions reject unsupported auth and polling before opening a transport", async (t) => {
  const f = await fixture(t);
  for (const transport of ["polling", "auto"])
    assert.throws(() => f.sessions.start("p", { ...f.input, transport }), /v2/);
  assert.throws(
    () =>
      f.sessions.start("p", { ...f.input, auth: { token: "must-not-ignore" } }),
    /auth/,
  );
  assert.throws(
    () => normalizeSocketIODefinition({ ...f.input, version: 3 }),
    /定义|版本/,
  );
  const id = f.sessions.start("p", { ...f.input, query: { token: "bad" } }).id;
  await until(() => f.sessions.snapshot("p", id).state === "error");
  assert.equal(f.connections(), 0);
});
test("legacy transport rejects oversize frames and malformed handshake without crashing caller", async (t) => {
  const h = http.createServer(),
    wss = new WebSocketServer({ server: h });
  let mode = "oversize";
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    if (mode === "oversize") ws.send("0" + "x".repeat(1024 * 1024));
    else
      ws.send(
        "0" +
          JSON.stringify({
            sid: "x",
            upgrades: [],
            pingInterval: 0,
            pingTimeout: 1000,
          }),
      );
  });
  await new Promise((r) => h.listen(0, "127.0.0.1", r));
  const s = new SocketIOSessions();
  t.after(async () => {
    s.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => h.close(r));
  });
  for (const value of ["oversize", "handshake"]) {
    mode = value;
    const id = s.start("p", {
      version: 2,
      url: `http://127.0.0.1:${h.address().port}`,
    }).id;
    await until(() => s.snapshot("p", id).state === "error");
    assert.equal(s.snapshot("p", id).events.length, 0);
  }
});

test("legacy TLS verifies server identity and client certificate while rejecting missing trust", async (t) => {
  const cert = await readFile(
      new URL("./fixtures/localhost.crt", import.meta.url),
      "utf8",
    ),
    key = await readFile(
      new URL("./fixtures/localhost.key", import.meta.url),
      "utf8",
    );
  const f = await fixture(t, {
    cert,
    key,
    ca: cert,
    requestCert: true,
    rejectUnauthorized: true,
  });
  const rejected = f.sessions.start("p", f.input).id;
  await until(() => f.sessions.snapshot("p", rejected).state === "error");
  const id = f.sessions.start("p", {
    ...f.input,
    tls: { ca: cert, cert, key },
  }).id;
  await until(() => f.sessions.snapshot("p", id).state === "open");
  assert.equal(
    (
      await f.sessions.send("p", id, {
        event: "echo",
        args: ["secure"],
        ackTimeoutMs: 1000,
      })
    ).status,
    "acknowledged",
  );
  f.sessions.stop("p", id);
});
test("legacy frames count toward a cumulative wire limit even when application event filters exclude them", async (t) => {
  const f = await fixture(t),
    id = f.sessions.start("p", { ...f.input, events: [] }).id;
  await until(() => f.sessions.snapshot("p", id).state === "open");
  await f.sessions.send("p", id, { event: "burst", args: [] });
  await until(() => f.sessions.snapshot("p", id).state === "error");
  assert(
    f.sessions
      .snapshot("p", id)
      .events.every((e) => e.direction !== "received"),
  );
});
test("saved legacy definition survives reload and runs a frozen CLI plan using only runtime credentials", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "legacy-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("legacy");
  const definition = normalizeSocketIODefinition({
    version: 2,
    id: "legacy",
    url: f.input.url,
  });
  p.settings.socketioDefinitions = [definition];
  const plan = snapshotPlan({
    steps: [
      {
        id: "legacy-step",
        type: "socketio",
        socketio: {
          definition,
          timeoutMs: 2000,
          commands: [
            {
              type: "emit",
              event: "echo",
              args: ["frozen"],
              ackTimeoutMs: 1000,
            },
          ],
        },
      },
    ],
  });
  p.plans = [plan];
  await store.save(p);
  assert.equal(
    (await new Store(root).get(p.id)).settings.socketioDefinitions[0].version,
    2,
  );
  const output = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        p.id,
        "--plan",
        plan.id,
        "--credentials-stdin",
      ],
      {
        env: { ...process.env, LOCAL_API_DATA: root },
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (e, stdout, stderr) =>
        e ? reject(Error(stderr + stdout)) : resolve(stdout),
    );
    child.stdin.end(
      JSON.stringify({
        socketioCredentials: {
          "legacy-step": { query: f.input.query, headers: f.input.headers },
        },
      }),
    );
  });
  const run = JSON.parse(output);
  assert.equal(run.status, "passed");
  assert.equal(run.snapshot.steps[0].socketio.definition.version, 2);
  const reloaded = await new Store(root).get(p.id);
  assert.equal(reloaded.runs.length, 1);
  assert.equal(
    reloaded.runs[0].results[0].socketioResult.results[0].status,
    "acknowledged",
  );
  assert.equal(JSON.stringify(reloaded).includes("x-fixture"), false);
});

test("modern-only backend startup does not load legacy client modules", async () => {
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); await import('./src/socketio.mjs'); console.log(JSON.stringify(Object.keys(require.cache).filter(p=>p.includes('socket.io-client-v2'))));`,
      ],
      { timeout: 5000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  assert.deepEqual(JSON.parse(stdout), []);
});
