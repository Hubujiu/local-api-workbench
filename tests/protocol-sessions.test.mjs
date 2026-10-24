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
