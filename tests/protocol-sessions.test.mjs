import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
test("interactive TCP retains multiple sends and closes deterministically", async (t) => {
  const server = net.createServer((socket) =>
    socket.on("data", (data) => socket.write("echo:" + data)),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sessions = new ProtocolSessions();
  t.after(() => {
    sessions.close();
    server.close();
  });
  const session = sessions.start({
    type: "tcp",
    host: "127.0.0.1",
    port: server.address().port,
  });
  const wait = async (condition) => {
    const until = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > until) throw Error("fixture timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await wait(() => sessions.snapshot(session.id).state === "open");
  sessions.send(session.id, "first");
  await wait(() =>
    sessions
      .snapshot(session.id)
      .events.some((event) => event.data === "echo:first"),
  );
  sessions.send(session.id, "second");
  await wait(() =>
    sessions
      .snapshot(session.id)
      .events.some((event) => event.data === "echo:second"),
  );
  sessions.stop(session.id);
  assert.equal(sessions.snapshot(session.id).state, "closed");
  assert.throws(() => sessions.send(session.id, "third"), /不可发送/);
});

test("invalid connection attempts do not retain an unbounded session registry", () => {
  const manager = new ProtocolSessions();
  try {
    for (let i = 0; i < 80; i++)
      manager.start({ type: "tcp", host: "", port: 0 });
    assert(manager.sessions.size <= 50);
  } finally {
    manager.close();
  }
});

test("terminal lifecycle retains failed receipts within fifty states, binds synchronous failures and expires only saved evidence", async () => {
  let attempts = 0;
  const manager = new ProtocolSessions({
    onFinish(session) {
      attempts++;
      assert.equal(session.projectId, "owner");
      assert.equal(session.definition.name, "original");
      assert.equal(session.finalSnapshot.state, "error");
      session.receipt = { recordSaved: false };
      session.recordPromise = Promise.resolve(session.receipt);
      return session.recordPromise;
    },
  });
  const definition = { name: "original" };
  const first = manager.start(
    { type: "tcp", host: "", port: 0, projectId: "forged" },
    { projectId: "owner", definition },
  );
  definition.name = "changed later";
  const session = manager.get(first.id);
  assert.equal(session.definition.name, "original");
  assert.equal(session.expiry._idleTimeout, 60 * 60 * 1000);
  session.expiry._onTimeout();
  assert.equal(manager.sessions.has(first.id), true);
  for (let i = 1; i < 50; i++)
    manager.start(
      { type: "tcp", host: "", port: 0 },
      { projectId: "owner", definition: { name: "original" } },
    );
  assert.throws(
    () => manager.start({ type: "tcp", host: "", port: 0 }),
    /上限/,
  );
  assert.equal(attempts, 50);
  assert.equal(manager.sessions.size, 50);
  // Only confirmed evidence may free a slot; eviction does not retry failures.
  session.recordSaved = true;
  manager.start(
    { type: "tcp", host: "", port: 0 },
    { projectId: "owner", definition: { name: "original" } },
  );
  assert.equal(manager.sessions.has(first.id), false);
  assert.equal(attempts, 51);
  await manager.close();
  assert.equal(attempts, 51);
  assert.equal(manager.sessions.size, 50);
  assert.throws(() => manager.start({ type: "tcp" }), /关闭/);
});

test("deadline and expiry callbacks close real TCP once, and observer failure cannot skip cleanup", async (t) => {
  const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let attempts = 0;
  const manager = new ProtocolSessions({
    onFinish(session) {
      attempts++;
      if (attempts === 3) throw Error("test storage observer failed");
      session.recordSaved = true;
    },
  });
  t.after(async () => {
    await manager.close();
    for (const s of peers) s.destroy();
    await new Promise((r) => server.close(r));
  });
  for (const mode of ["deadline", "expiry", "manual"]) {
    const id = manager.start(
      { type: "tcp", host: "127.0.0.1", port: server.address().port },
      { projectId: "owner", definition: {} },
    ).id;
    const session = manager.get(id);
    for (let i = 0; session.state !== "open"; i++) {
      assert(i < 500);
      await new Promise((r) => setTimeout(r, 5));
    }
    const socket = session.socket;
    assert.equal(session.deadline._idleTimeout, 15 * 60 * 1000);
    if (mode === "manual") manager.stop(id);
    else session[mode]._onTimeout();
    assert.equal(socket.destroyed, true);
    assert.equal(
      session.finalSnapshot.closeReason,
      mode === "deadline" ? "deadline" : "manual",
    );
    const frozen = JSON.stringify(session.finalSnapshot);
    manager.stop(id);
    assert.equal(JSON.stringify(session.finalSnapshot), frozen);
    if (mode === "expiry") assert.equal(manager.sessions.has(id), false);
    if (mode === "manual")
      assert.equal(
        session.receipt.persistenceOutcome.code,
        "RECORD_SAVE_FAILED",
      );
  }
  assert.equal(attempts, 3);
});
