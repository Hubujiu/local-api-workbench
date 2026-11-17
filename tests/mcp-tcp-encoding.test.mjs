import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
import { MCPWebSocketSessions } from "../src/mcp-websocket-sessions.mjs";

async function until(check) {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(5);
  }
  throw Error("TCP fixture observation missing");
}
for (const encoding of ["utf8", "hex", "base64"]) {
  test(`TCP ${encoding} evidence is stream data, not message frames`, async (t) => {
    let socket,
      received = 0,
      final;
    const server = net.createServer((s) => {
      socket = s;
      s.on("data", (b) => {
        received += b.length;
      });
      s.on("error", () => {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const manager = new ProtocolSessions({
      onFinish(s) {
        final = structuredClone(s.finalSnapshot);
        s.recordSaved = true;
        s.receipt = { recordSaved: true, recordId: s.id };
      },
    });
    const owner = {},
      project = {
        id: "p",
        protocols: [
          {
            id: "tcp",
            type: "tcp",
            url: "127.0.0.1",
            port: server.address().port,
            receiveEncoding: encoding,
            message: "must-not-auto-send",
          },
        ],
      };
    const service = new MCPWebSocketSessions({
      sessions: manager,
      store: {
        async get() {
          return structuredClone(project);
        },
      },
      owns: (x) => x === owner,
    });
    const tcp = service.forProtocol("tcp");
    const call = (action, args = {}) =>
      tcp.call(action, owner, { projectId: "p", ...args });
    t.after(async () => {
      await service.dispose(owner);
      await manager.close();
      socket?.destroy();
      await new Promise((r) => server.close(r));
    });
    const start = await call("start", {
      definitionId: "tcp",
      operationId: "start",
    });
    const sessionId = start.sessionId;
    await until(() => socket && manager.get(sessionId).state === "open");
    assert.equal(received, 0);
    // Explicit empty text is still an operation, never the saved default.
    await call("send", { sessionId, operationId: "empty", message: "" });
    await until(
      async () =>
        (await call("operation", { operationId: "empty" })).state ===
        "locally-written",
    );
    assert.equal(received, 0);
    const bytes =
      encoding === "utf8"
        ? Buffer.from("€🙂tail")
        : Buffer.from([0, 255, 195, 40, 128, 1, 2]);
    for (const chunk of [
      bytes.subarray(0, 1),
      bytes.subarray(1, 2),
      bytes.subarray(2),
    ]) {
      socket.write(chunk);
      await delay(15);
    }
    socket.end();
    await until(() => final);
    const page = await call("get", { sessionId });
    const events = page.events.filter((e) => e.direction === "received");
    assert(events.length > 0);
    assert(events.every((e) => e.encoding === encoding && !e.truncated));
    const rebuilt =
      encoding === "utf8"
        ? Buffer.from(events.map((e) => e.data).join(""))
        : Buffer.concat(events.map((e) => Buffer.from(e.data, encoding)));
    assert.deepEqual(rebuilt, bytes);
    assert.equal(page.recordSaved, true);
    assert.equal(page.closeReason, "remote");
    const snapshot = structuredClone(final);
    assert.equal(
      (await call("send", { sessionId, operationId: "late", message: "late" }))
        .state,
      "failed-before-submit",
    );
    assert.throws(() => call("renew", { sessionId }));
    await call("stop", { sessionId });
    assert.deepEqual(final, snapshot);
    assert.equal(received, 0);
  });
}
