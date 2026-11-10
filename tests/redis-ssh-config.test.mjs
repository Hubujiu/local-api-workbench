// Pure isolation: every transport constructor is replaced by a tripwire.
// No server, driver connection, application, SDK or subprocess is started.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { databaseSSHConfig } from "../src/database-ssh.mjs";
import {
  queryRedis,
  mutateRedis,
  observeNativeRedisSet,
} from "../src/redis.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";

const ssh = {
  host: "ssh.fixture.invalid",
  username: "fixture",
  password: "ssh-secret",
  hostKeySHA256: "SHA256:" + "A".repeat(43),
};
const base = {
  type: "redis",
  allowWrite: true,
  host: "redis.fixture.invalid",
  port: 6379,
  database: "2",
  password: "db-secret",
  ssh,
  command: ["SET", "key", "value"],
};
function forbidTransport(t) {
  let attempts = 0;
  const tripwire = () => {
    attempts++;
    throw Error("transport must not be created");
  };
  t.mock.method(net, "connect", tripwire);
  t.mock.method(tls, "connect", tripwire);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => assert.equal(attempts, 0);
}
test("malformed Redis SSH configurations fail without any transport or credential leakage", async (t) => {
  const noConnections = forbidTransport(t);
  const keyOnly = { ...ssh };
  delete keyOnly.password;
  for (const invalid of [
    null,
    false,
    "",
    {},
    { ...ssh, host: " " },
    { ...ssh, port: 0 },
    { ...ssh, hostKeySHA256: "" },
    { ...ssh, password: undefined },
    { ...ssh, username: "" },
    { ...ssh, agent: "/not-read" },
    { ...ssh, privateKey: "extra" },
    { ...keyOnly, privateKey: "not-a-private-key" },
    { ...ssh, passphrase: "invalid-password-combination" },
  ]) {
    for (const writing of [false, true]) {
      const input = {
        ...base,
        ssh: invalid,
        command: writing ? base.command : ["GET", "key"],
      };
      await assert.rejects(
        writing ? mutateRedis(input) : queryRedis(input),
        (error) => {
          assert.match(error.message, /SSH/);
          assert.doesNotMatch(error.message, /ssh-secret|db-secret/);
          return true;
        },
      );
    }
  }
  noConnections();
});
test("Redis commands, target, authentication and TLS validate before SSH opens", async (t) => {
  const noConnections = forbidTransport(t);
  for (const patch of [
    { host: "bad host" },
    { host: "" },
    { host: null },
    { host: "x/y" },
    { port: 0 },
    { port: "wrong" },
    { port: true },
    { port: 65536 },
    { database: "1024" },
    { database: "-1" },
    { database: [] },
    { user: null },
    { password: Buffer.from("secret") },
    { password: "a".repeat(8193) },
    { ssl: "false" },
    { ca: {} },
    { ca: "a".repeat(65537) },
    { ssl: true, host: "127.0.0.1" },
  ]) {
    await assert.rejects(
      queryRedis({ ...base, ...patch, command: ["GET", "key"] }),
    );
    await assert.rejects(mutateRedis({ ...base, ...patch }));
  }
  await assert.rejects(queryRedis(base), /只读/);
  await assert.rejects(mutateRedis({ ...base, allowWrite: false }), /授权/);
  await assert.rejects(
    mutateRedis({ ...base, command: ["SET", "key", "v", "NX", "XX"] }),
    /选项/,
  );
  await assert.rejects(mutateRedis({ ...base, port: undefined }), /明确/);
  noConnections();
});
test("invalid Redis CA bundles fail before either transport, including valid prefixes and DER trailing bytes", async (t) => {
  const noConnections = forbidTransport(t);
  const ca = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  );
  const paddedDER = Buffer.concat([
    new X509Certificate(ca).raw,
    Buffer.from("junk"),
  ]);
  const extraDER =
    "-----BEGIN CERTIFICATE-----\n" +
    paddedDER.toString("base64") +
    "\n-----END CERTIFICATE-----\n";
  const bad = "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n";
  for (const value of [
    "not a certificate",
    "   \n",
    bad,
    ca + "trailing junk",
    "leading junk" + ca,
    ca + bad,
    bad + ca,
    ca + "junk" + ca,
    extraDER,
    ca.replace("-----END CERTIFICATE-----", ""),
    ca.replace("-----BEGIN CERTIFICATE-----", "-----BEGIN PRIVATE KEY-----"),
    ca.replace(/MIID/, "!IID"),
  ]) {
    for (const sshConfig of [ssh, undefined]) {
      await assert.rejects(
        queryRedis({
          ...base,
          ssl: true,
          ca: value,
          ssh: sshConfig,
          command: ["GET", "key"],
        }),
        /Redis CA/,
      );
      await assert.rejects(
        mutateRedis({ ...base, ssl: true, ca: value, ssh: sshConfig }),
        /Redis CA/,
      );
    }
  }
  noConnections();
});
test("complete Redis CA certificates and bundles pass validation without losing default-trust empty fields", async (t) => {
  const noConnections = forbidTransport(t);
  const ca = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  );
  for (const value of [
    undefined,
    "",
    ca,
    ca + ca,
    " \r\n" +
      ca.replace(/\n/g, "\r\n") +
      "\t" +
      tls.rootCertificates[0] +
      " \n",
  ]) {
    for (const ssl of [false, true]) {
      // An invalid SSH config is the next boundary, proving that CA parsing
      // and context creation succeeded without actually creating a transport.
      await assert.rejects(
        queryRedis({
          ...base,
          ssl,
          ca: value,
          ssh: {},
          command: ["GET", "key"],
        }),
        /SSH/,
      );
      await assert.rejects(
        mutateRedis({ ...base, ssl, ca: value, ssh: {} }),
        /SSH/,
      );
    }
  }
  noConnections();
});
test("canonical Redis SSH sessions remain memory-only/read-only and native SET is refused before dispatch", async (t) => {
  const noConnections = forbidTransport(t),
    sessions = new DatabaseSessions();
  const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  const source = {
    id: "p",
    settings: { apipostDatabases: [{ id: bindingId, type: "redis" }] },
  };
  const bound = new DatabaseSessions({ resolveProject: async () => source });
  t.after(() => {
    sessions.close();
    bound.close();
  });
  const original = structuredClone(base);
  const grant = sessions.register("p", { ...base, name: "Canonical SSH" });
  assert.deepEqual(base, original);
  assert.deepEqual(sessions.list("p"), [
    { id: grant.id, name: "Canonical SSH", type: "redis" },
  ]);
  assert.deepEqual(sessions.list("q"), []);
  await assert.rejects(
    sessions.query("q", { connectionId: grant.id, sql: '["GET","key"]' }),
    /未授权/,
  );
  await assert.rejects(
    sessions.query("p", {
      connectionId: grant.id,
      sql: '["SET","key","value"]',
      allowWrite: true,
    }),
    /只读/,
  );
  const native = bound.register("p", { ...base, name: "Bound SSH", bindingId });
  await assert.rejects(bound.captureNativeRedisTarget("p", native.id), {
    code: "NATIVE_WRITE_TARGET_INVALID",
  });
  let guardCalls = 0;
  assert.deepEqual(
    await observeNativeRedisSet(base, {
      beforeDispatch() {
        guardCalls++;
      },
    }),
    { outcome: "not-sent", reason: "transport" },
  );
  assert.equal(guardCalls, 0);
  sessions.revoke("p", grant.id);
  await assert.rejects(
    sessions.query("p", { connectionId: grant.id, sql: '["GET","key"]' }),
    /未授权/,
  );
  assert.equal(JSON.stringify(sessions), "{}");
  noConnections();
});
test("SSH canonical validation copies credentials and preserves the explicit fingerprint", () => {
  const result = databaseSSHConfig(ssh);
  assert.notEqual(result, ssh);
  assert.deepEqual(result, { ...ssh, port: 22 });
});
