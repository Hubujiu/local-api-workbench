import test from "node:test";
import assert from "node:assert/strict";
import {
  runSQLServerReadWIP as run,
  SQLSERVER_READONLY_PROBE as probe,
} from "../src/sqlserver-read-wip.mjs";
const input = {
  connection: {
    host: "localhost",
    user: "fictional",
    password: "",
    database: "fixture",
    ssl: true,
  },
  sql: "SELECT id FROM dbo.items WHERE id=@p0",
  parameters: [1],
};
function port(options = {}) {
  let close;
  const calls = [],
    closed = new Promise((r) => (close = r));
  return {
    calls,
    closed,
    destroys: 0,
    async connect() {
      calls.push("connect");
      await options.connect?.();
    },
    async query(q, sink) {
      calls.push(q);
      if (q.sql === probe) {
        sink.metadata([{ name: "updateability", type: "NVarChar" }]);
        sink.row([options.state ?? "READ_ONLY"]);
        await options.afterProbe?.();
      } else {
        await options.query?.(sink);
        if (!options.query) {
          sink.metadata([{ name: "id", type: "BigInt" }]);
          sink.row(["9223372036854775807"]);
        }
      }
    },
    destroy() {
      this.destroys++;
      close();
    },
  };
}
test("inert SQLServer port checks READ_ONLY before reconstructed SQL and exact data, closes once", async () => {
  const p = port();
  const result = await run(input, { factory: () => p });
  assert.equal(result.rows[0].id, "9223372036854775807");
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls[1].sql, probe);
  assert.equal(
    p.calls[2].sql,
    "SELECT TOP (1001) [id] FROM [dbo].[items] WHERE [id] = @p0",
  );
  assert.equal(p.destroys, 1);
  await assert.rejects(run(input), /no installed transport/);
  for (const state of ["READ_WRITE", "UNKNOWN", null]) {
    const p = port({ state: state === null ? "" : state });
    await assert.rejects(run(input, { factory: () => p }));
    assert.equal(p.calls.length, 2);
    assert.equal(p.destroys, 1);
  }
});
test("inert SQLServer cancellation before/during connect and probe never starts user SQL or replays", async () => {
  const before = new AbortController();
  before.abort();
  let made = 0;
  await assert.rejects(
    run(input, {
      factory: () => {
        made++;
        return port();
      },
      signal: before.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(made, 0);
  for (const stage of ["connect", "afterProbe"]) {
    const c = new AbortController();
    const p = port({
      [stage]: async () => {
        c.abort();
      },
    });
    await assert.rejects(run(input, { factory: () => p, signal: c.signal }), {
      name: "AbortError",
    });
    assert.equal(p.calls.filter((x) => x?.sql && x.sql !== probe).length, 0);
    assert.equal(p.destroys, 1);
  }
  const c = new AbortController();
  let release;
  const gate = new Promise((r) => (release = r));
  const p = port({
    query: async (sink) => {
      c.abort();
      await gate;
      sink.metadata([{ name: "id", type: "Int" }]);
      sink.row([1]);
    },
  });
  await assert.rejects(run(input, { factory: () => p, signal: c.signal }), {
    name: "AbortError",
  });
  release();
  assert.equal(p.destroys, 1);
  assert.equal(p.calls.length, 3);
});
test("inert SQLServer metadata, precision and result failures publish no partial result", async () => {
  for (const query of [
    async (s) => s.metadata([{ name: "v", type: "DecimalN" }]),
    async (s) => {
      s.metadata([{ name: "v", type: "BigInt" }]);
      s.row([9007199254740992]);
    },
    async (s) => {
      s.metadata([{ name: "v", type: "NVarChar" }]);
      s.row(["x".repeat(1024 * 1024)]);
    },
    async (s) => {
      s.metadata([{ name: "v", type: "Int" }]);
      s.row([1]);
      throw Error("secret password raw error");
    },
    async (s) => {
      s.metadata([{ name: "v", type: "Int" }]);
      s.metadata([{ name: "v", type: "Int" }]);
    },
  ]) {
    const p = port({ query });
    await assert.rejects(
      run(input, { factory: () => p }),
      (e) => e.message === "SQL Server WIP read failed; no result published",
    );
    assert.equal(p.destroys, 1);
  }
  const p = port({
    query: async (s) => {
      s.metadata([{ name: "v", type: "Int" }]);
      for (let i = 0; i < 1001; i++) s.row([i]);
    },
  });
  const r = await run(input, { factory: () => p });
  assert.equal(r.rows.length, 1000);
  assert.equal(r.truncated, true);
});

test("inert SQLServer closure failures and factory errors cannot report success or leak credentials", async () => {
  await assert.rejects(
    run(input, {
      factory: () => {
        throw Error("password secret");
      },
    }),
    (e) => e.message === "SQL Server WIP transport initialization failed",
  );
  const p = port();
  p.closed = Promise.reject(Error("private driver detail"));
  await assert.rejects(
    run(input, { factory: () => p }),
    (e) =>
      e.message ===
      "SQL Server transport closure not confirmed; no result published",
  );
  assert.equal(p.destroys, 1);
  const tooMany = port({
    query: async (s) => {
      s.metadata([{ name: "v", type: "Int" }]);
      for (let i = 0; i < 1002; i++) s.row([i]);
    },
  });
  await assert.rejects(
    run(input, { factory: () => tooMany }),
    /no result published/,
  );
});
