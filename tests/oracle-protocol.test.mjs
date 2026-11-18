import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { queryOracleRead } from "../src/oracle-read-process.mjs";
import { oracleInput } from "./helpers/oracle-fixture.mjs";
test("official Thin driver sends TLS not credentials to inert untrusted peer, publishes no result", async (t) => {
  const received = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", (b) => {
      received.push(b);
      socket.destroy();
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const input = oracleInput();
  input.connection.host = "127.0.0.1";
  input.connection.port = server.address().port;
  await assert.rejects(
    queryOracleRead(input),
    (e) =>
      e.code?.startsWith("ORACLE_READ_") &&
      !String(e).includes("private-secret"),
  );
  assert.ok(received.length >= 1);
  for (const b of received) {
    assert.equal(b[0], 22);
    assert.ok(!b.includes(Buffer.from("private-secret")));
  }
});

test("abort during held TLS handshake kills owned Oracle process before returning", async (t) => {
  let arrived;
  const first = new Promise((r) => {
    arrived = r;
  });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", arrived);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const c = new AbortController(),
    input = oracleInput();
  input.connection.host = "127.0.0.1";
  input.connection.port = server.address().port;
  const result = queryOracleRead(input, { signal: c.signal });
  const assertion = assert.rejects(result, (e) =>
    [
      "ORACLE_READ_CANCELLED",
      "ORACLE_READ_FORCED_TERMINATION_CONFIRMED",
    ].includes(e.code),
  );
  await first;
  c.abort("private-secret");
  await assertion;
});

test("owned Oracle provider revocation cancels actual Thin TLS connection without replay", async (t) => {
  const { OracleReadSessions } = await import(
    "../src/oracle-read-sessions.mjs"
  );
  const sessions = new OracleReadSessions({ enabled: true });
  let arrived;
  const first = new Promise((r) => {
    arrived = r;
  });
  const sockets = new Set();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", (b) => {
      assert.equal(b[0], 22);
      assert.ok(!b.includes(Buffer.from("private-secret")));
      arrived();
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    sessions.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const input = oracleInput();
  input.connection.host = "127.0.0.1";
  input.connection.port = server.address().port;
  const { id } = sessions.register("owner", "project", {
    connection: input.connection,
    relations: ["fixture.items"],
  });
  const result = sessions.query("owner", "project", id, {
    sql: input.sql,
    parameters: input.parameters,
  });
  const assertion = assert.rejects(result, {
    code: "ORACLE_SESSION_CANCELLED",
  });
  await first;
  sessions.revoke("owner", "project", id);
  await assertion;
  assert.equal(connections, 1);
  assert.deepEqual(sessions.list("owner", "project"), []);
});
