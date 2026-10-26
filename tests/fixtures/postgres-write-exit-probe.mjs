import assert from "node:assert/strict";
import { mutatePostgres } from "../../src/postgres-write.mjs";
import { startPostgresWritePeer } from "./postgres-write-peer.mjs";
import { startSSHFixture } from "./ssh-server.mjs";
const peer = await startPostgresWritePeer({ ssl: true }),
  ssh = await startSSHFixture({
    targets: [{ host: "localhost", port: peer.port }],
  });
try {
  const result = await mutatePostgres({
    type: "postgres",
    allowWrite: true,
    host: "localhost",
    port: peer.port,
    user: "fictional",
    database: "fixture",
    password: "",
    ssl: true,
    ca: peer.cert,
    ssh: ssh.ssh,
    sql: "INSERT INTO entries(value) VALUES ($1)",
    parameters: ["fictional-value"],
  });
  assert.equal(result.committed, true);
} finally {
  await ssh.close();
  await peer.close();
}
console.log("PG_WRITE_RESOURCES_CLOSED");
// No process.exit(): referenced driver/SSH handles or timers keep this child alive.
