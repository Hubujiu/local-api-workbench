// Owned loopback/process observations only, not remote database rollback proof.
// SQLite IPC and Mongo worker dispatch have no strict cross-thread no-dispatch
// guarantee. These tests revoke after actual resource creation and observe exit.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DatabaseSessions } from "../src/database-sessions.mjs";

async function until(predicate, label, budget = 1500) {
  const deadline = Date.now() + budget;
  while (!predicate()) {
    assert(Date.now() < deadline, label);
    await delay(5);
  }
}
function observe(promise) {
  const state = { done: false };
  state.promise = promise.then(
    (value) => Object.assign(state, { done: true, value }),
    (error) => Object.assign(state, { done: true, error }),
  );
  return state;
}
async function revoked(state) {
  await until(
    () => state.done,
    "revoked query must settle before driver timeout",
  );
  await state.promise;
  assert.match(state.error?.message ?? "", /已撤销/);
  assert.equal(state.value, undefined);
}

for (const type of ["mongodb", "clickhouse"]) {
  test(
    `${type}: revoke closes actual resource, isolates same-project grant, close permits fresh registration`,
    { timeout: 12000 },
    async (t) => {
      const peers = [],
        closed = new Set();
      const endpoint =
        type === "mongodb"
          ? net.createServer((socket) => {
              const peer = { socket, data: false };
              peers.push(peer);
              socket.on("data", () => {
                peer.data = true;
              });
              socket.on("error", () => {});
              socket.once("close", () => closed.add(peer));
            })
          : http.createServer((request, response) => {
              const peer = { socket: response.socket, response, data: true };
              peers.push(peer);
              request.resume();
              response.socket.on("error", () => {});
              response.socket.once("close", () => closed.add(peer));
              // Hold an actual response body open, rather than merely TCP connect.
              response.writeHead(200, { "content-type": "application/json" });
              response.write('{"meta":[],"data":[');
            });
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const sessions = new DatabaseSessions();
      t.after(async () => {
        sessions.close();
        for (const peer of peers) peer.socket.destroy();
        await new Promise((resolve) => endpoint.close(resolve));
      });
      const config = {
        type,
        name: "resource fixture",
        host: "127.0.0.1",
        port: endpoint.address().port,
        database: "fixture",
      };
      const start = (grant) =>
        observe(
          sessions.query("project", {
            connectionId: grant.id,
            sql:
              type === "mongodb"
                ? '{"collection":"items","limit":1}'
                : "SELECT 1",
          }),
        );
      const a = sessions.register("project", config);
      const b = sessions.register("project", config);
      const qa = start(a);
      await until(
        () => peers.length === 1 && peers[0].data,
        "first actual driver request",
        2500,
      );
      const qb = start(b);
      await until(
        () => peers.length === 2 && peers[1].data,
        "second actual driver request",
        2500,
      );
      sessions.revoke("project", a.id);
      await revoked(qa);
      await until(() => closed.has(peers[0]), "revoked peer must close");
      assert(
        !closed.has(peers[1]),
        "same-project distinct grant remains alive",
      );
      assert.equal(qb.done, false);
      assert.deepEqual(
        sessions.list("project").map((entry) => entry.id),
        [b.id],
      );
      await assert.rejects(
        sessions.query("project", { connectionId: a.id, sql: "SELECT 1" }),
        /失效|未授权/,
      );
      assert.equal(peers.length, 2);
      sessions.close();
      await revoked(qb);
      await until(
        () => closed.has(peers[1]),
        "close must release remaining peer",
      );
      assert.deepEqual(sessions.list("project"), []);
      const fresh = sessions.register("project", config);
      assert.notEqual(fresh.id, a.id);
      const qfresh = start(fresh);
      await until(
        () => peers.length === 3 && peers[2].data,
        "fresh grant must actually connect",
        2500,
      );
      assert.equal(
        qfresh.done,
        false,
        "old aborted controller must not poison fresh grant",
      );
      sessions.close();
      await revoked(qfresh);
      await until(() => closed.has(peers[2]), "fresh peer must close");
      if (type === "clickhouse") {
        assert(
          peers.every((peer) => peer.response.destroyed),
          "all held responses destroyed",
        );
      }
    },
  );
}

test(
  "SQLite: session revoke/close waits for actual child exit and fresh grants still query",
  { timeout: 10000 },
  async (t) => {
    const require = createRequire(import.meta.url),
      cp = require("node:child_process"),
      original = cp.fork;
    const children = [],
      closed = new Set(),
      sessions = new DatabaseSessions();
    // Observe real fork objects only; do not substitute execution, send, or kill.
    cp.fork = (...args) => {
      const child = original(...args);
      children.push(child);
      child.once("close", () => closed.add(child));
      return child;
    };
    syncBuiltinESMExports();
    const root = await mkdtemp(path.join(tmpdir(), "session-revoke-sqlite-"));
    const filename = path.join(root, "fixture.sqlite");
    t.after(async () => {
      sessions.close();
      cp.fork = original;
      syncBuiltinESMExports();
      await Promise.all(
        children.map(async (child) => {
          if (closed.has(child)) return;
          const exit = once(child, "close");
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await exit;
        }),
      );
      await rm(root, { recursive: true, force: true });
    });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE fixture(value INTEGER)");
    db.close();
    const config = { type: "sqlite", name: "sqlite fixture", filename };
    const longSQL =
      "WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<1000000000) SELECT sum(x) FROM c";
    const a = sessions.register("project", config),
      b = sessions.register("project", config);
    const qa = observe(
      sessions.query("project", { connectionId: a.id, sql: longSQL }),
    );
    await until(
      () => children.length === 1 && Number.isInteger(children[0].pid),
      "first real child spawned",
    );
    const qb = observe(
      sessions.query("project", { connectionId: b.id, sql: longSQL }),
    );
    await until(
      () => children.length === 2 && Number.isInteger(children[1].pid),
      "second real child spawned",
    );
    await delay(150);
    assert.equal(closed.size, 0);
    sessions.revoke("project", a.id);
    await revoked(qa);
    assert(
      closed.has(children[0]),
      "query settles only after actual child close",
    );
    assert(!closed.has(children[1]), "other grant child remains alive");
    assert.equal(qb.done, false);
    sessions.close();
    await revoked(qb);
    assert(closed.has(children[1]), "close releases other actual child");
    const fresh = sessions.register("project", config);
    const result = await sessions.query("project", {
      connectionId: fresh.id,
      sql: "SELECT 7 AS value",
    });
    assert.equal(result.rows[0].value, 7);
    assert.equal(children.length, 3);
    assert(closed.has(children[2]));
  },
);
