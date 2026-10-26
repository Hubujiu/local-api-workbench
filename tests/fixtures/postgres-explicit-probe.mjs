// Runs with a wholly synthetic environment. No actual password file is opened.
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import {
  explicitPostgresOptions,
  createExplicitPostgresClient,
} from "../../src/postgres-client.mjs";
import { queryRemoteDatabase } from "../../src/remote-database.mjs";
import { mutatePostgres } from "../../src/postgres-write.mjs";
const require = createRequire(import.meta.url),
  pgRequire = createRequire(require.resolve("pg/lib/client.js"));
let passwordFileCalls = 0;
const pgpassPath = pgRequire.resolve("pgpass");
pgRequire.cache[pgpassPath] = {
  id: pgpassPath,
  filename: pgpassPath,
  loaded: true,
  exports: (_config, cb) => {
    passwordFileCalls++;
    cb("ambient-file-password");
  },
};
const defaults = pgRequire("./defaults.js"),
  defaultsBefore = {
    user: defaults.user,
    password: defaults.password,
    ssl: defaults.ssl,
  };
const auth = (code) => {
  const b = Buffer.alloc(9);
  b[0] = 82;
  b.writeInt32BE(8, 1);
  b.writeInt32BE(code, 5);
  return b;
};
const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
const sockets = new Set(),
  seen = [],
  failures = [];
const expected = new Map([
  ["explicit-a", ""],
  ["explicit-b", ""],
  ["explicit-c", "explicit-password"],
]);
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  let buffer = Buffer.alloc(0),
    startup,
    requests = 0;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length) {
        if (!startup) {
          if (buffer.length < 4) return;
          const length = buffer.readInt32BE(0);
          assert(length >= 8 && length <= 65536);
          if (buffer.length < length) return;
          const packet = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          assert.equal(
            packet.readInt32BE(4),
            196608,
            "ambient PGSSLMODE must not enable SSL negotiation",
          );
          const parts = packet.subarray(8).toString("utf8").split("\0");
          assert.equal(parts.pop(), "");
          assert.equal(parts.pop(), "");
          const fields = {};
          for (let i = 0; i < parts.length; i += 2) {
            assert(!Object.hasOwn(fields, parts[i]), "duplicate startup field");
            fields[parts[i]] = parts[i + 1];
          }
          assert(expected.has(fields.user));
          assert.equal(fields.database, "fixture-" + fields.user.at(-1));
          assert.deepEqual(Object.keys(fields).sort(), [
            "application_name",
            "client_encoding",
            "database",
            "statement_timeout",
            "user",
          ]);
          assert.equal(fields.application_name, "Local API Workbench");
          assert.equal(fields.client_encoding, "UTF8");
          assert.equal(fields.statement_timeout, "2000");
          startup = fields;
          socket.write(auth(3));
          continue;
        }
        if (buffer.length < 5) return;
        const tag = String.fromCharCode(buffer[0]),
          length = buffer.readInt32BE(1);
        assert(length >= 4 && length <= 65536);
        if (buffer.length < length + 1) return;
        const packet = buffer.subarray(0, length + 1);
        buffer = buffer.subarray(length + 1);
        if (tag === "X") {
          socket.end();
          continue;
        }
        assert.equal(tag, "p");
        assert.equal(packet.at(-1), 0);
        const password = packet.subarray(5, -1).toString("utf8");
        assert.equal(password, expected.get(startup.user));
        seen.push({ user: startup.user, password });
        requests++;
        if (requests === 1) socket.write(auth(3));
        else {
          assert.equal(requests, 2);
          socket.write(Buffer.concat([auth(0), ready]));
        }
      }
    } catch (error) {
      failures.push(error);
      socket.destroy();
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const common = { host: "127.0.0.1", port: server.address().port };
  for (const patch of [
    { user: undefined },
    { user: "" },
    { database: undefined },
    { database: "" },
    { password: null },
    { password: 42 },
    { port: true },
    { ssl: "false" },
  ])
    assert.throws(() =>
      explicitPostgresOptions({
        ...common,
        user: "fixture",
        database: "fixture",
        ...patch,
      }),
    );
  await Promise.all(
    [...expected].map(async ([user, password], index) => {
      const input = {
        ...common,
        user,
        database: "fixture-" + user.at(-1),
        ...(index === 0 ? {} : { password }),
        ssl: false,
      };
      const options = explicitPostgresOptions(input);
      input.password = "later-mutation";
      assert.equal(typeof options.password, "function");
      assert.equal(options.password(), password);
      const client = await createExplicitPostgresClient(options);
      client.on("error", () => {});
      assert.equal(client.connectionParameters.ssl, false);
      assert.equal(client.binary, false);
      assert.equal(client.replication, undefined);
      const startup = client.getStartupConf();
      startup.user = "changed";
      assert.equal(client.getStartupConf().user, user);
      try {
        await client.connect();
      } finally {
        await client.end();
      }
    }),
  );
  assert.deepEqual(failures, []);
  assert.equal(seen.length, 6);
  assert.equal(passwordFileCalls, 0);
  const verified = await createExplicitPostgresClient(
    explicitPostgresOptions({
      ...common,
      user: "tls",
      database: "tls",
      ssl: true,
      ca: "fixture-ca",
    }),
  );
  assert.equal(verified.connectionParameters.ssl.rejectUnauthorized, true);
  assert.equal(verified.connectionParameters.ssl.ca, "fixture-ca");
  await verified.end();
  let created = 0,
    observed = [];
  class FakeClient {
    constructor(options) {
      created++;
      this.options = options;
      observed.push(options);
    }
    on() {}
    async connect() {}
    async end() {}
    async query(input) {
      if (typeof input === "string") return {};
      return input.text.startsWith("WITH localapi_written")
        ? { rows: [{ affected_rows: "1" }] }
        : { rows: [["ok"]], fields: [{ name: "value" }] };
    }
  }
  const input = {
    ...common,
    type: "postgres",
    user: "explicit-wrapper",
    database: "fixture",
    password: "",
  };
  await queryRemoteDatabase(
    { ...input, sql: "SELECT 1" },
    { Client: FakeClient },
  );
  await mutatePostgres(
    {
      ...input,
      allowWrite: true,
      sql: "UPDATE fixture SET value=$1",
      parameters: ["x"],
    },
    { Client: FakeClient },
  );
  assert.equal(created, 2);
  assert(
    observed.every(
      (options) =>
        options.password() === "" &&
        options.ssl === false &&
        options.connectionTimeoutMillis === 3000 &&
        options.statement_timeout === 2000 &&
        options.query_timeout === 3000,
    ),
  );
  await assert.rejects(
    queryRemoteDatabase(
      {
        type: "postgres",
        sql: "SELECT 1",
        ssh: { host: "must-not-contact.invalid" },
      },
      { Client: FakeClient },
    ),
    /user/,
  );
  assert.equal(created, 2);
  assert.deepEqual(
    { user: defaults.user, password: defaults.password, ssl: defaults.ssl },
    defaultsBefore,
  );
  assert.equal(process.env.PGPASSWORD, "ambient-env-password");
  assert.equal(process.env.PGSSLMODE, "no-verify");
  console.log("EXPLICIT_PG_IDENTITY_WIRE_NO_AMBIENT_NO_PGPASS_PASS");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => server.close(r));
}
const { verifyPostgresTLS } = await import("./postgres-tls-probe.mjs");
await verifyPostgresTLS();
