import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { ProtocolSessionIntents } from "../src/protocol-session-intents.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
import { createProtocolSessionController } from "../public/protocol-session-controller.js";
import { createApp } from "../src/server.mjs";
const definition = { type: "tcp", host: "127.0.0.1", port: 1 };
function fixture() {
  const sessions = new ProtocolSessions();
  const sid = randomUUID();
  let writes = 0,
    complete;
  sessions.sessions.set(sid, {
    id: sid,
    type: "tcp",
    state: "open",
    events: [],
    bytes: 0,
    totalEvents: 0,
    socket: {
      write(_buffer, callback) {
        writes++;
        complete = callback;
      },
      destroy() {},
    },
  });
  const intents = new ProtocolSessionIntents(sessions);
  const intent = randomUUID();
  intents.entries.set(intent, {
    phase: "started",
    digest: "fixture",
    sessionId: sid,
  });
  const nonce = randomUUID();
  const operation = (sequence) => intent + ":" + sequence + ":" + nonce;
  const send = (operation, message = "one") =>
    intents.send(intent, intents.instanceId, sid, operation, message);
  return {
    sessions,
    sid,
    intents,
    intent,
    operation,
    send,
    writes: () => writes,
    complete: (error) => complete(error),
  };
}
test("correlated owner send receipts are read-only, payload-bound and never replayed", () => {
  const f = fixture(),
    operation = f.operation(1);
  assert.equal(f.send(operation).sendReceipt.state, "pending");
  assert.equal(f.send(operation).sendReceipt.state, "pending");
  assert.equal(f.writes(), 1);
  f.complete();
  const read = f.intents.read(f.intent);
  assert.equal(read.sendReceipts[0].operationId, operation);
  assert.equal(read.sendReceipts[0].state, "locally-written");
  assert.equal(typeof read.sendReceipts[0].eventId, "string");
  assert.equal(f.send(operation).sendReceipt.state, "locally-written");
  assert.throws(
    () => f.send(operation, "different"),
    (e) => e.intentStatus === 409,
  );
  assert.equal(f.writes(), 1);
  assert.ok(!Object.hasOwn([...f.intents.operations.values()][0], "message"));
});
test("receipt ledger freezes unknown on transport close and late callback cannot upgrade it", () => {
  const f = fixture(),
    operation = f.operation(1);
  f.send(operation);
  f.sessions.stop(f.sid);
  f.complete();
  assert.equal(f.intents.read(f.intent).sendReceipts[0].state, "unknown");
  assert.equal(f.send(operation).sendReceipt.state, "unknown");
  assert.equal(f.writes(), 1);
});
test("pre-submit rejection is retained separately from transport uncertainty", () => {
  const f = fixture(),
    operation = f.operation(1);
  assert.equal(
    f.send(operation, { encoding: "bogus", data: "one" }).sendReceipt.state,
    "failed-before-submit",
  );
  assert.equal(
    f.send(operation, { encoding: "bogus", data: "one" }).sendReceipt.state,
    "failed-before-submit",
  );
  assert.equal(f.writes(), 0);
  assert.equal(f.intents.read(f.intent).sendReceipts[0].eventId, null);
});
test("foreign session, stale instance and project-owned sessions fail closed", () => {
  const f = fixture();
  assert.throws(() =>
    f.intents.send(f.intent, randomUUID(), f.sid, f.operation(1), "one"),
  );
  assert.throws(() =>
    f.intents.send(
      f.intent,
      f.intents.instanceId,
      randomUUID(),
      randomUUID(),
      "one",
    ),
  );
  f.sessions.get(f.sid).projectId = "another-project";
  assert.throws(
    () => f.send(f.operation(1)),
    (e) => e.intentStatus === 403,
  );
  assert.equal(f.writes(), 0);
  assert.equal(f.intents.operations.size, 0);
});
test("bounded receipts permit 1000 sends while retired IDs remain permanently closed", () => {
  const f = fixture();
  for (let i = 1; i <= 1000; i++) {
    f.send(f.operation(i));
    f.complete();
  }
  assert.equal(f.intents.operations.size, 256);
  assert.equal(f.intents.read(f.intent).sendSequence, 1000);
  assert.throws(
    () => f.send(f.operation(1)),
    (e) => e.intentStatus === 410,
  );
  assert.throws(
    () => f.send(f.operation(1), "changed"),
    (e) => e.intentStatus === 410,
  );
  assert.throws(
    () => f.send(f.operation(1002)),
    (e) => e.intentStatus === 409,
  );
  f.intents.close();
  assert.equal(f.send(f.operation(1000)).sendReceipt.state, "locally-written");
  assert.equal(f.writes(), 1000);
});
test("pending receipts are pinned and bounded; after settlement normal sends resume", () => {
  const f = fixture();
  for (let i = 1; i <= 256; i++) f.send(f.operation(i));
  assert.throws(
    () => f.send(f.operation(257)),
    (e) => e.intentStatus === 429,
  );
  assert.equal(f.intents.read(f.intent).sendSequence, 256);
  f.complete();
  f.send(f.operation(257));
  assert.equal(f.intents.operations.size, 256);
  assert.equal(
    f.intents.read(f.intent).sendReceipts[0].operationId,
    f.operation(1),
  );
  assert.throws(
    () => f.send(f.operation(256)),
    (e) => e.intentStatus === 410,
  );
  assert.equal(f.writes(), 257);
  f.sessions.stop(f.sid);
});
for (const suffix of [
  "0",
  "01",
  "1e0",
  "-1",
  "9007199254740992",
  "Infinity",
  "1junk",
])
  test("noncanonical or unsafe send sequence rejected: " + suffix, () => {
    const f = fixture();
    assert.throws(
      () => f.send(f.operation(suffix)),
      (e) => e.intentStatus === 400,
    );
    assert.equal(f.writes(), 0);
  });
function controller(api, instanceId, store = new Map()) {
  return {
    store,
    value: createProtocolSessionController({
      api,
      instanceId,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
      },
      schedule: () => 1,
      cancel() {},
    }),
  };
}
test(
  "lost real HTTP send receipt recovers by GET after reload without a second TCP write",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(tmpdir() + "/protocol-send-receipts-");
    const sockets = new Set();
    let bytes = "",
      sends = 0,
      sentBody;
    const tcp = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (data) => {
        bytes += data.toString();
      });
    });
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      await app.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => tcp.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const api = async (path, method = "GET", body) => {
      const response = await fetch(app.url + "/api" + path, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      if (path.endsWith("/send")) {
        sends++;
        if (sends === 1) {
          sentBody = body;
          throw Error("lost send response");
        }
      }
      return result;
    };
    const { instanceId } = await api("/session");
    const h = controller(api, instanceId);
    await h.value.connect({ ...definition, port: tcp.address().port });
    for (let i = 0; i < 100 && !h.value.status().canSend; i++) {
      await h.value.poll();
      await new Promise((r) => setTimeout(r, 5));
    }
    await assert.rejects(() => h.value.send("ONCE"));
    assert.equal(h.value.status().canSend, false);
    const restored = controller(api, instanceId, h.store);
    await restored.value.restore();
    for (let i = 0; i < 100 && !restored.value.status().canSend; i++) {
      await restored.value.poll();
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(restored.value.status().canSend, true);
    assert.equal(restored.value.status().uncertainDelivery, true);
    assert.match(restored.value.status().warning, /不代表远端业务成功/);
    for (let i = 0; i < 100 && bytes !== "ONCE"; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(bytes, "ONCE");
    assert.equal(sends, 1);
    const url =
      app.url +
      "/api/protocol-sessions/" +
      restored.value.status().snapshot.id +
      "/send";
    const repeat = (body, token = app.token) =>
      fetch(url, {
        method: "POST",
        headers: { "x-local-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const duplicate = await repeat(sentBody);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).sendReceipt.state, "locally-written");
    assert.equal(
      (await repeat({ ...sentBody, message: "changed" })).status,
      409,
    );
    assert.equal((await repeat(sentBody, "not-authorized")).status, 403);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bytes, "ONCE");
    assert.ok(![...h.store.values()][0].includes("ONCE"));
    for (let i = 0; i < 300; i++) await restored.value.send("x");
    assert.equal(sends, 301);
    for (let i = 0; i < 100 && bytes.length < 304; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(bytes, "ONCE" + "x".repeat(300));
    assert.equal((await repeat(sentBody)).status, 410);
    assert.equal(bytes, "ONCE" + "x".repeat(300));
  },
);

for (const state of [
  "pending",
  "unknown",
  "locally-written",
  "failed-before-submit",
  "wrong-id",
  "missing-event",
  "duplicate",
])
  test(`only matching conclusive local receipt recovers a lost send: ${state}`, async () => {
    const instanceId = randomUUID(),
      sid = randomUUID();
    let intentId, operationId;
    const snapshot = { id: sid, type: "tcp", state: "open", events: [] };
    const api = async (path, method, body) => {
      if (path.endsWith("/send")) {
        operationId = body.operationId;
        throw Error("lost");
      }
      intentId ??= path.split("/").at(-1);
      const op = { operationId, eventId: randomUUID(), state };
      if (state === "wrong-id") {
        op.operationId = intentId + ":99:" + randomUUID();
        op.state = "locally-written";
      }
      if (state === "missing-event") {
        op.eventId = null;
        op.state = "locally-written";
      }
      if (state === "duplicate") op.state = "locally-written";
      return {
        instanceId,
        intentId,
        sessionId: sid,
        session: snapshot,
        phase: "started",
        retry_safe: false,
        ...(operationId
          ? { sendReceipts: state === "duplicate" ? [op, op] : [op] }
          : {}),
      };
    };
    const h = controller(api, instanceId);
    await h.value.connect(definition);
    await assert.rejects(() => h.value.send("one"));
    await h.value.poll();
    assert.equal(
      h.value.status().canSend,
      ["locally-written", "failed-before-submit"].includes(state),
    );
    assert.equal(h.value.status().uncertainDelivery, true);
  });

test("same sequence with another nonce cannot borrow a receipt or submit again", () => {
  const f = fixture();
  f.send(f.operation(1));
  f.complete();
  assert.throws(
    () => f.send(f.intent + ":1:" + randomUUID()),
    (e) => e.intentStatus === 410,
  );
  assert.throws(
    () => f.send(randomUUID() + ":2:" + randomUUID()),
    (e) => e.intentStatus === 400,
  );
  assert.equal(f.writes(), 1);
  assert.equal(
    f.intents.read(f.intent).sendReceipts[0].operationId,
    f.operation(1),
  );
});

test("unknown receipt eviction retains the non-replay watermark", () => {
  const f = fixture();
  f.sessions.get(f.sid).socket.write = () => {
    throw Error("uncertain submission");
  };
  f.send(f.operation(1));
  assert.equal(f.intents.read(f.intent).sendReceipts[0].state, "unknown");
  for (let i = 2; i <= 300; i++) f.send(f.operation(i));
  assert.equal(f.intents.operations.size, 256);
  assert.throws(
    () => f.send(f.operation(1)),
    (e) => e.intentStatus === 410,
  );
  assert.equal(f.intents.read(f.intent).sendSequence, 300);
});
