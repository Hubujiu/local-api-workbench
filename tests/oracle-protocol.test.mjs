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
