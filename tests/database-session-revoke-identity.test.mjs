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
