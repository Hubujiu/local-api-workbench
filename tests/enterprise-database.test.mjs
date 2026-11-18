import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { existsSync } from "node:fs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { runDamengProcess } from "../src/dameng-process.mjs";

const oracle = {
  type: "oracle",
  name: "fixture",
  host: "db.invalid",
  database: "svc",
  user: "reader",
  password: "fixture-only",
  ssl: true,
  serverDN: "CN=db.invalid",
  relations: ["app.items"],
};
test("enterprise grants use explicit reviewed relations and never cross owner / MCP scopes", async (t) => {
  t.mock.method(Date, "now", Date.now);
  const saved = process.env.LOCALAPI_ORACLE_PREVIEW;
  t.after(() => {
    if (saved === undefined) delete process.env.LOCALAPI_ORACLE_PREVIEW;
    else process.env.LOCALAPI_ORACLE_PREVIEW = saved;
  });
  delete process.env.LOCALAPI_ORACLE_PREVIEW;
  const manual = new DatabaseSessions();
  t.after(() => manual.close());
  assert.throws(() => manual.register("p", oracle), /未启用/);
  process.env.LOCALAPI_ORACLE_PREVIEW = "read-only";
  const mcp = new MCPDatabaseGrants(() => ({
    enabled: true,
    write: true,
    execute: true,
    projects: ["p"],
  }));
  const grant = mcp.register({ id: "p" }, oracle);
  assert.deepEqual(grant.relations, ["APP.ITEMS"]);
  assert(!JSON.stringify(mcp.list("p")).includes(oracle.password));
  await assert.rejects(manual.assertAuthorized("p", grant.id));
  assert.throws(() =>
    manual.register("p", { ...oracle, relations: ["app.t", "APP.T"] }),
  );
  await assert.rejects(
    queryRemoteDatabase({ ...oracle, sql: "SELECT id FROM other.items" }),
    /授权范围/,
  );
  const id = manual.register("p", oracle).id;
  await assert.rejects(
    manual.query("p", { connectionId: id, sql: "SELECT id FROM other.items" }),
    /授权范围/,
  );
  mcp.revoke("p", grant.id);
  assert.deepEqual(mcp.list("p"), []);
  await manual.assertAuthorized("p", id);
  const later = Date.now() + 900001;
  Date.now.mock.mockImplementation(() => later);
  assert.deepEqual(manual.list("p"), []);
  await assert.rejects(manual.assertAuthorized("p", id));
});

const built = existsSync(
  new URL(
    "../src/vendor/dameng-native/workbench-dameng-read" +
      (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
test(
  "native DM8 client closes a plaintext-only DM handshake before transmitting LOGIN",
  { skip: !built },
  async (t) => {
    const saved = process.env.LOCALAPI_DAMENG_PREVIEW;
    process.env.LOCALAPI_DAMENG_PREVIEW = "read-only";
    t.after(() => {
      if (saved === undefined) delete process.env.LOCALAPI_DAMENG_PREVIEW;
      else process.env.LOCALAPI_DAMENG_PREVIEW = saved;
    });
    const records = [];
    const server = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 64 || pending.length < 64 + pending.readInt32LE(6))
          return;
        records.push(pending);
        pending = Buffer.alloc(0);
        const version = Buffer.from("8.1.3.62");
        const reply = Buffer.alloc(68 + version.length);
        reply.writeInt16LE(200, 4);
        reply.writeInt32LE(reply.length - 64, 6);
        reply.writeUInt16LE(6, 48);
        reply.writeInt32LE(version.length, 64);
        version.copy(reply, 68);
        reply[19] = reply.subarray(0, 19).reduce((a, b) => a ^ b, 0);
        socket.write(reply);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((r) => server.close(r)));
    const credentials = "secret-never-sent";
    await assert.rejects(
      runDamengProcess({
        connection: {
          host: "127.0.0.1",
          serverName: "127.0.0.1",
          port: server.address().port,
          ssl: true,
          user: "test-reader",
          password: credentials,
          ca: "unused-on-plaintext",
        },
        sql: "SELECT id FROM APP.ITEMS",
      }),
      /NO_RESULT/,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].readInt16LE(4), 200);
    assert(!records[0].includes(Buffer.from(credentials)));
  },
);
