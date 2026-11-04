import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { parseRESP } from "../src/redis.mjs";
const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
const project = {
  id: "p",
  settings: { apipostDatabases: [{ id: bindingId, type: "redis" }] },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(t) {
  const sockets = [],
    seen = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        const parsed = parseRESP(pending);
        if (!parsed) break;
        pending = pending.subarray(parsed.bytes);
        seen.push(parsed.value.map((v) => v.toString()));
        socket.write("$5\r\nvalue\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return {
    seen,
    config: {
      name: "fixture",
      type: "redis",
      host: "127.0.0.1",
      port: server.address().port,
      bindingId,
    },
  };
}
for (const phase of ["before", "after"])
  for (const action of ["revoke", "close", "replace"]) {
    test(
      `${action} while ${phase} source lookup is held cannot revive captured grant`,
      { timeout: 5000 },
      async (t) => {
        const f = await fixture(t),
          entered = deferred(),
          release = deferred();
        t.after(() => release.resolve());
        let calls = 0;
        const sessions = new DatabaseSessions({
          resolveProject: async () => {
            if (++calls === (phase === "before" ? 1 : 2)) {
              entered.resolve();
              await release.promise;
            }
            return project;
          },
        });
        t.after(() => sessions.close());
        const old = sessions.register("p", f.config);
        const pending = sessions
          .query("p", { connectionId: bindingId, sql: '["GET","fixture"]' })
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await entered.promise;
        if (action === "close") sessions.close();
        else sessions.revoke("p", old.id);
        let fresh;
        if (action === "replace") fresh = sessions.register("p", f.config);
        release.resolve();
        const result = await pending;
        assert.match(result.error?.message || "", /撤销/);
        assert.equal(result.value, undefined);
        assert.equal(f.seen.length, phase === "before" ? 0 : 1);
        if (fresh) {
          assert.notEqual(fresh.id, old.id);
          const value = await sessions.query("p", {
            connectionId: bindingId,
            sql: '["GET","fresh"]',
          });
          assert.ok(value);
          assert.equal(f.seen.at(-1)[1], "fresh");
        }
      },
    );
  }
test(
  "pre-aborted caller opens no socket; returned result is not retroactively changed by revoke",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      sessions = new DatabaseSessions({ resolveProject: async () => project });
    t.after(() => sessions.close());
    const id = sessions.register("p", f.config).id;
    const controller = new AbortController();
    controller.abort(new Error("private caller reason"));
    await assert.rejects(
      sessions.query(
        "p",
        { connectionId: id, sql: '["GET","no"]' },
        controller.signal,
      ),
      /已取消/,
    );
    assert.equal(f.seen.length, 0);
    const value = await sessions.query("p", {
      connectionId: id,
      sql: '["GET","yes"]',
    });
    const saved = JSON.stringify(value);
    sessions.revoke("p", id);
    assert.equal(JSON.stringify(value), saved);
    assert.equal(f.seen.length, 1);
  },
);

for (const order of ["caller-first", "session-first"]) {
  test(
    `${order} simultaneous cancellation keeps original driver error and does not expose reasons`,
    { timeout: 5000 },
    async (t) => {
      let enter;
      const entered = new Promise((r) => (enter = r));
      const sockets = [];
      const server = net.createServer((s) => {
        sockets.push(s);
        s.on("error", () => {});
        s.on("data", () => enter());
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const sessions = new DatabaseSessions(),
        controller = new AbortController();
      t.after(async () => {
        controller.abort();
        sessions.close();
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
      });
      const id = sessions.register("p", {
        name: "fictional",
        type: "redis",
        host: "127.0.0.1",
        port: server.address().port,
        password: "fictional",
      }).id;
      const pending = sessions
        .query(
          "p",
          { connectionId: id, sql: '["GET","fixture"]' },
          controller.signal,
        )
        .then(
          () => null,
          (e) => e,
        );
      await entered;
      if (order === "caller-first") {
        controller.abort(new Error("private reason"));
        sessions.revoke("p", id);
      } else {
        sessions.revoke("p", id);
        controller.abort(new Error("private reason"));
      }
      const error = await pending;
      assert.equal(error.name, "AbortError");
      assert.equal(error.code, "DATABASE_QUERY_CANCELLED");
      assert.doesNotMatch(error.message, /private/);
    },
  );
}

// Public driver seam is only an error-precedence control, not wire evidence.
test("a PostgreSQL query failure preceding cleanup-time caller abort retains its original error", async () => {
  const { queryRemoteDatabase } = await import("../src/remote-database.mjs");
  const controller = new AbortController();
  class Client {
    constructor(config) {
      this.stream = config.stream;
      this.stream.once("close", () =>
        controller.abort(new Error("private cleanup reason")),
      );
    }
    on() {}
    async connect() {}
    async query(sql) {
      if (sql === "BEGIN READ ONLY") return;
      throw Object.assign(Error("fixture undefined column"), { code: "42703" });
    }
  }
  await assert.rejects(
    queryRemoteDatabase(
      {
        type: "postgres",
        host: "127.0.0.1",
        port: 5432,
        user: "fixture",
        password: "",
        database: "fixture",
        ssl: false,
        sql: "SELECT 1",
      },
      { signal: controller.signal, Client },
    ),
    (error) =>
      error.code === "42703" &&
      error.name === "Error" &&
      !error.message.includes("private"),
  );
  assert.equal(controller.signal.aborted, true);
});
