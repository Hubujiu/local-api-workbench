import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";

function runCLI(root, projectId, planId, input, flag = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        projectId,
        "--plan",
        planId,
        ...(flag ? ["--credentials-stdin"] : []),
      ],
      {
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CLI fixture timeout"));
    }, 15000);
    child.on("error", reject);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
test("CLI stdin credentials run actual gRPC, Socket.IO and WebSocket plan without persisting credentials or inheriting them into later runs", async (t) => {
  const secret = "cli-fixture-private-value",
    seen = [];
  const server = http.createServer((req, res) => res.end("ok"));
  const io = new Server(server);
  io.use((s, next) =>
    s.handshake.auth.token === secret ? next() : next(Error("unauthorized")),
  );
  io.on("connection", (s) => {
    seen.push("socketio");
    s.on("echo", (v, ack) => ack(v));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url != "/wire") return;
    if (req.headers.authorization !== secret) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    ws.handleUpgrade(req, socket, head, (s) => {
      seen.push("websocket");
      s.on("message", (b) => s.send(b.toString()));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gs = new grpc.Server(),
    file = new URL("./fixtures/grpc.proto", import.meta.url),
    proto = await readFile(file, "utf8");
  const pkg = grpc.loadPackageDefinition(loader.loadSync(fileURLToPath(file)));
  gs.addService(pkg.fixture.Echo.service, {
    Unary(call, done) {
      if (call.metadata.get("authorization")[0] !== secret)
        return done({ code: 16, details: "unauthorized" });
      seen.push("grpc");
      done(null, call.request);
    },
  });
  const gp = await new Promise((resolve, reject) =>
    gs.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  const root = await mkdtemp(path.join(tmpdir(), "cli-protocol-"));
  t.after(async () => {
    gs.forceShutdown();
    for (const s of ws.clients) s.terminate();
    await new Promise((r) => ws.close(r));
    await new Promise((r) => io.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    p = await store.create("CLI fixture"),
    port = server.address().port;
  const plan = snapshotPlan({
    steps: [
      {
        id: "g",
        type: "grpc",
        grpc: {
          definition: {
            target: `grpc://127.0.0.1:${gp}`,
            proto,
            service: "fixture.Echo",
            method: "Unary",
          },
          messages: [{ text: "grpc-payload" }],
        },
      },
      {
        id: "s",
        type: "socketio",
        socketio: {
          definition: { url: `http://127.0.0.1:${port}` },
          timeoutMs: 2000,
          commands: [
            {
              type: "emit",
              event: "echo",
              args: ["socket-payload"],
              ackTimeoutMs: 1000,
            },
          ],
        },
      },
      {
        id: "w",
        type: "protocol",
        expectedStatus: "partial",
        protocol: {
          definition: { type: "websocket", url: `ws://127.0.0.1:${port}/wire` },
          message: "wire-payload",
          maxMessages: 1,
          duration: 2000,
        },
      },
    ],
  });
  p.plans = [plan];
  await store.save(p);
  const credentials = {
    grpcCredentials: {
      g: { metadata: [{ key: "authorization", value: secret }] },
    },
    socketioCredentials: { s: { auth: { token: secret } } },
    protocolCredentials: { w: { headers: { Authorization: secret } } },
  };
  const first = await runCLI(root, p.id, plan.id, JSON.stringify(credentials));
  assert.equal(first.code, 0, first.stderr + "\n" + first.stdout);
  assert.equal(JSON.parse(first.stdout).status, "passed");
  assert.deepEqual(seen, ["grpc", "socketio", "websocket"]);
  assert.equal((first.stdout + first.stderr).includes(secret), false);
  const reloaded = await new Store(root).get(p.id);
  assert.equal(reloaded.runs.length, 1);
  assert.equal(JSON.stringify(reloaded).includes(secret), false);
  const second = await runCLI(root, p.id, plan.id, "", false);
  assert.equal(second.code, 1, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, "failed");
  assert.deepEqual(seen, ["grpc", "socketio", "websocket"]);
  const bad = await runCLI(root, p.id, plan.id, "malformed " + secret);
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr.includes(secret), false);
  assert.equal((await new Store(root).get(p.id)).runs.length, 2);
});
