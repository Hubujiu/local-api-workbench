import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "socket.io";
import { SocketIOSessions } from "../src/socketio.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { socketIOError, socketIODiagnostic } from "../src/socketio-errors.mjs";
const secret = 'synthetic-auth-"\\-保密-value';
const hidden = "Socket.IO连接或协议失败（对端诊断已隐藏）";
const variants = [
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString("base64"),
  [...secret].reverse().join(""),
];
function clean(value) {
  const text = JSON.stringify(value);
  for (const variant of variants)
    assert.ok(!text.includes(JSON.stringify(variant).slice(1, -1)));
}
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, "fixture deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("diagnostics accept local provenance, never peer text, nested descriptions or spoofed local messages", () => {
  for (const value of variants) {
    assert.equal(
      socketIODiagnostic({
        message: value,
        description: { message: value },
        data: value,
        stack: value,
      }),
      hidden,
    );
    assert.equal(socketIODiagnostic(value), hidden);
  }
  assert.equal(socketIODiagnostic(Error("Socket.IO消息超过1MiB")), hidden);
  const local = socketIOError("Socket.IO消息超过1MiB");
  local.message = secret;
  local.description = { message: secret };
  assert.equal(socketIODiagnostic(local), "Socket.IO消息超过1MiB");
  assert.equal(
    socketIODiagnostic({ message: "websocket error " + secret }),
    hidden,
  );

  assert.equal(
    socketIODiagnostic(socketIOError("Socket.IO消息超过1MiB")),
    "Socket.IO消息超过1MiB",
  );
  assert.equal(
    socketIODiagnostic({
      message: secret,
      description: socketIOError("Socket.IO polling HTTP 401"),
    }),
    "Socket.IO polling HTTP 401",
  );
  assert.equal(
    socketIODiagnostic({
      message: "websocket error",
      description: { message: secret, code: "ECONNREFUSED" },
    }),
    "Socket.IO连接被拒绝",
  );
  for (const value of [
    null,
    undefined,
    0,
    false,
    {},
    [],
    { message: { secret } },
  ])
    assert.equal(socketIODiagnostic(value), hidden);
});
for (const version of [2, 4])
  for (const transport of ["websocket", "polling", "auto"]) {
    test(`real v${version} ${transport} rejection cannot persist raw or transformed ephemeral authentication`, async (t) => {
      const server = http.createServer(),
        io = new Server(server, { allowEIO3: true });
      const seen = [];
      io.use((socket, next) => {
        const received =
          version === 4
            ? socket.handshake.auth.nested.secret
            : socket.handshake.query.token;
        seen.push(received);
        const error = Error(variants.join(" | "));
        error.data = {
          message: received,
          description: { message: received },
          code: received,
        };
        next(error);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const sessions = new SocketIOSessions();
      t.after(async () => {
        sessions.close();
        await new Promise((r) => io.close(r));
      });
      const definition = {
        url: `http://127.0.0.1:${server.address().port}`,
        version,
        transport,
      };
      const credentials =
        version === 4
          ? { auth: { nested: { secret } } }
          : { query: { token: secret } };
      const session = sessions.start("project", {
        ...definition,
        ...credentials,
      });
      await until(
        () => sessions.snapshot("project", session.id).state === "error",
      );
      const snapshot = sessions.snapshot("project", session.id);
      assert.equal(snapshot.error, hidden);
      assert.equal(sessions.get("project", session.id).socket, null);
      clean(snapshot);
      clean(sessions.list("project"));
      clean(sessions.stop("project", session.id));
      const result = await executeSocketIOFlow({
        definition,
        ...credentials,
        commands: [],
        timeoutMs: 3000,
      });
      assert.equal(result.status, "failed");
      assert.equal(result.error, hidden);
      clean(result);
      assert.deepEqual(seen, [secret, secret]);
    });
  }
test("disconnect diagnostics hide arbitrary reason while received events and ACKs remain explicit application data", async (t) => {
  const server = http.createServer(),
    io = new Server(server);
  io.on("connection", (socket) => {
    socket.on("echo", (value, ack) => {
      socket.emit("answer", {
        peerEchoedCredential: socket.handshake.auth.secret,
      });
      ack({ peerEchoedCredential: socket.handshake.auth.secret });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const sessions = new SocketIOSessions();
  t.after(async () => {
    sessions.close();
    await new Promise((r) => io.close(r));
  });
  const { id } = sessions.start("project", {
    url: `http://127.0.0.1:${server.address().port}`,
    auth: { secret },
  });
  await until(() => sessions.snapshot("project", id).state === "open");
  const ack = await sessions.send("project", id, {
    event: "echo",
    args: [{ explicitApplicationData: secret }],
    ackTimeoutMs: 1000,
  });
  assert.equal(ack.args[0].peerEchoedCredential, secret);
  await until(() =>
    sessions
      .snapshot("project", id)
      .events.some((event) => event.event === "answer"),
  );
  const socket = sessions.get("project", id).socket;
  socket.emitReserved("disconnect", secret);
  assert.equal(sessions.snapshot("project", id).error, hidden);
});
