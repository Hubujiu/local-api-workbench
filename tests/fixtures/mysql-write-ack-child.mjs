// Deliberate scheduling interference belongs in this isolated test process.
// This is a protocol ACK proof, not evidence of a real engine's commit/rollback.
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mutateMySQL, mysqlWriteUsage } from "../../src/mysql-write.mjs";
import { startMySQLWritePeer } from "./mysql-write-peer.mjs";

const phase = process.argv[2];
assert(["commit", "rollback"].includes(phase));
const f = await startMySQLWritePeer({ count: phase === "rollback" ? 1001 : 1 });
let observedACK = false;
const observe = ({ socket }) =>
  socket.once("connect", () => {
    if (socket.remotePort !== f.input.port) return;
    // The real mysql2 parser already registered its data listener before connect.
    socket.on("data", (bytes) => {
      if (
        observedACK ||
        !f.records.some((record) => record.stage === phase) ||
        bytes.length < 5 ||
        bytes[4] !== 0
      )
        return;
      observedACK = true;
      // The ACK has been decoded, but delay the promise continuation until after
      // the operation deadline. An ACK must not become an unknown outcome.
      // Block this isolated test event loop without competing for a CPU core with
      // unrelated suites that have their own unchanged wall-clock budgets.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3100);
    });
  });
channel("net.client.socket").subscribe(observe);
try {
  const result = await mutateMySQL(f.input, { operationTimeoutMs: 3000 }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert(observedACK, "must observe the actual final OK after driver parsing");
  assert.equal(f.records.filter((record) => record.stage === phase).length, 1);
  assert(!f.records.some((record) => record.stage === "kill"));
  if (phase === "commit") {
    assert.equal(result.value?.committed, true, result.error?.message);
    assert(!f.records.some((record) => record.stage === "rollback"));
  } else {
    assert.match(result.error?.message || "", /事务已回滚/);
    assert(!f.records.some((record) => record.stage === "commit"));
  }
  assert.equal(mysqlWriteUsage().active, 0);
  assert.equal(f.clients.length, 2);
  assert(f.clients.every((client) => client.closed));
  process.stdout.write(JSON.stringify({ phase, observedACK, closed: true }));
} finally {
  channel("net.client.socket").unsubscribe(observe);
  await f.close();
}
