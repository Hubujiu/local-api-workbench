import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
const http = (id, request = {}) => ({
  id,
  request: { url: "http://example.test", ...request },
});
const rows = (steps = [http("body")], extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const db = (id = "db") => ({
  type: "database",
  connectionId: id,
  sql: "SELECT 1",
  parameters: [],
  name: "queryResult",
});
const response = () => ({ status: 200, headers: {}, body: "{}" });
const opts = (extra = {}) => ({
  allowRuntimeRows: true,
  variableScopes: { runtime: { items: [] } },
  ...extra,
});
const falseIf = (steps) => ({
  id: "false",
  type: "if",
  condition: { op: "eq", left: { literal: true }, right: { literal: false } },
  steps,
});
const first = () =>
  http("first", { beforeScript: "pm.environment.set('touched', true);" });
const protocols = [
  {
    id: "grpc",
    type: "grpc",
    grpc: {
      definition: {
        target: "grpc://localhost:50051",
        proto:
          'syntax = "proto3"; service Echo { rpc Call (Msg) returns (Msg); } message Msg {}',
        service: "Echo",
        method: "Call",
      },
      messages: [{}],
    },
  },
  {
    id: "socketio",
    type: "socketio",
    socketio: {
      definition: {
        url: "http://localhost:3000",
        version: 4,
        transport: "websocket",
      },
      commands: [{ type: "wait", event: "hello", timeoutMs: 50 }],
    },
  },
  {
    id: "protocol",
    type: "protocol",
    protocol: { definition: { type: "tcp", url: "localhost", port: 12345 } },
  },
];

for (const sibling of protocols) {
  test(`missing potential ${sibling.type} executor prevents earlier script, commit and HTTP`, async () => {
    let calls = 0,
      commits = 0;
    await assert.rejects(
      runPlan(
        { steps: [first(), rows(), sibling] },
        {},
        async () => {
          calls++;
          return response();
        },
        opts({
          onScopeChanges: async () => {
            commits++;
          },
        }),
      ),
      new RegExp(`未授权${sibling.type}`),
    );
    assert.equal(calls, 0);
    assert.equal(commits, 0);
  });
}

test("missing HTTP executor is rejected even when rows would be empty", async () => {
  await assert.rejects(
    runPlan({ steps: [rows()] }, {}, undefined, opts()),
    /未授权http/,
  );
});

for (const mode of ["empty", "false-if"]) {
  for (const missing of ["query", "preflight", "grant"]) {
    test(`${mode} potential declarative database still requires ${missing} before earlier HTTP`, async () => {
      let calls = 0,
        commits = 0,
        queries = 0,
        preflights = 0;
      const body = http("db-leaf", { before: [db()] });
      const plan = {
        steps: [first(), rows(mode === "empty" ? [body] : [falseIf([body])])],
      };
      const options = opts({
        onScopeChanges: async () => {
          commits++;
        },
        databaseQuery:
          missing === "query"
            ? undefined
            : async () => {
                queries++;
              },
        databasePreflight:
          missing === "preflight"
            ? undefined
            : async (ids) => {
                preflights++;
                assert.deepEqual(ids, ["db"]);
                if (missing === "grant") throw Error("grant denied");
              },
      });
      await assert.rejects(
        runPlan(
          plan,
          {},
          async () => {
            calls++;
            return response();
          },
          options,
        ),
        /未授权database|数据库执行前|grant denied/,
      );
      assert.equal(calls, 0);
      assert.equal(commits, 0);
      assert.equal(queries, 0);
      assert.equal(preflights, missing === "grant" ? 1 : 0);
    });
  }
}

test("authorization waits before any effects, passes immutable deduplicated IDs and signal", async () => {
  const controller = new AbortController();
  let release, entered;
  const waiting = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  let calls = 0,
    commits = 0,
    queries = 0;
  const run = runPlan(
    {
      steps: [
        first(),
        rows([
          http("db-leaf", { before: [db("a"), db("a")], after: [db("b")] }),
        ]),
      ],
    },
    {},
    async () => {
      calls++;
      return response();
    },
    opts({
      signal: controller.signal,
      databaseQuery: async () => {
        queries++;
      },
      onScopeChanges: async () => {
        commits++;
      },
      databasePreflight: async (ids, signal) => {
        assert.deepEqual(ids, ["a", "b"]);
        assert.equal(Object.isFrozen(ids), true);
        assert.equal(signal, controller.signal);
        entered();
        await gate;
      },
    }),
  );
  await waiting;
  assert.equal(calls, 0);
  assert.equal(commits, 0);
  assert.equal(queries, 0);
  release();
  const result = await run;
  assert.equal(result.status, "passed");
  assert.equal(calls, 1);
  assert.equal(commits, 1);
  assert.equal(queries, 0);
});

for (const finish of ["resolve", "reject"]) {
  test(`abort during authorization callback ${finish} returns cancelled with no effects`, async () => {
    const controller = new AbortController();
    let release, entered;
    const waiting = new Promise((r) => {
      entered = r;
    });
    const gate = new Promise((resolve, reject) => {
      release = () =>
        finish === "resolve" ? resolve() : reject(Error("grant revoked"));
    });
    let calls = 0;
    const run = runPlan(
      { steps: [first(), rows([http("db-leaf", { before: [db()] })])] },
      {},
      async () => {
        calls++;
        return response();
      },
      opts({
        signal: controller.signal,
        databaseQuery: async () => {
          calls++;
        },
        onScopeChanges: async () => {
          calls++;
        },
        databasePreflight: async () => {
          entered();
          await gate;
        },
      }),
    );
    await waiting;
    controller.abort();
    release();
    const result = await run;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.results, []);
    assert.equal(calls, 0);
  });
}

test("pre-aborted run does not call authorization adapter and preserves cancelled result", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runPlan(
    { steps: [first(), rows([http("db-leaf", { before: [db()] })])] },
    {},
    async () => {
      calls++;
      return response();
    },
    opts({
      signal: controller.signal,
      databaseQuery: async () => {
        calls++;
      },
      databasePreflight: async () => {
        calls++;
      },
      onScopeChanges: async () => {
        calls++;
      },
    }),
  );
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.results, []);
  assert.equal(calls, 0);
});

test("revocation rejection during awaited authorization stops earlier HTTP", async () => {
  let release,
    entered,
    calls = 0;
  const waiting = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((_, reject) => {
    release = () => reject(Error("grant revoked"));
  });
  const run = runPlan(
    { steps: [first(), rows([http("db-leaf", { before: [db()] })])] },
    {},
    async () => {
      calls++;
      return response();
    },
    opts({
      databaseQuery: async () => {
        calls++;
      },
      databasePreflight: async () => {
        entered();
        await gate;
      },
    }),
  );
  await waiting;
  release();
  await assert.rejects(run, /grant revoked/);
  assert.equal(calls, 0);
});

test("explicit authorization refusal is not success", async () => {
  await assert.rejects(
    runPlan(
      { steps: [rows([http("db-leaf", { before: [db()] })])] },
      {},
      async () => response(),
      opts({
        databaseQuery: async () => {},
        databasePreflight: async () => false,
      }),
    ),
    /授权检查未通过/,
  );
});

test("legacy and disabled-only plans do not acquire new database preflight requirement", async () => {
  for (const disabled of [false, true]) {
    let queries = 0,
      preflights = 0;
    const steps = [http("db-leaf", { before: [db()] })];
    if (disabled) steps.push(rows(undefined, { enabled: false }));
    const result = await runPlan(
      snapshotPlan({ steps }, { allowRuntimeRows: true }),
      {},
      async () => response(),
      opts({
        databaseQuery: async () => {
          queries++;
          return { value: 1 };
        },
        databasePreflight: async () => {
          preflights++;
          throw Error("must not call");
        },
      }),
    );
    assert.equal(result.status, "passed");
    assert.equal(queries, 1);
    assert.equal(preflights, 0);
  }
});

test("script-only database access is not inferred as a static connection requirement", async () => {
  let preflights = 0;
  const result = await runPlan(
    {
      steps: [
        rows([
          http("body", { beforeScript: "const unused = 'apt.queryDatabase';" }),
        ]),
      ],
    },
    {},
    async () => response(),
    opts({
      databasePreflight: async () => {
        preflights++;
      },
    }),
  );
  assert.equal(result.status, "passed");
  assert.equal(preflights, 0);
});

test("successful preflight does not replace the actual query-time grant check", async () => {
  let queries = 0,
    calls = 0,
    preflights = 0;
  const result = await runPlan(
    { steps: [rows([http("body", { before: [db()] })])] },
    {},
    async () => {
      calls++;
      return response();
    },
    opts({
      variableScopes: { runtime: { items: [{}] } },
      databasePreflight: async () => {
        preflights++;
      },
      databaseQuery: async () => {
        queries++;
        throw Error("grant revoked after preflight");
      },
    }),
  );
  assert.equal(preflights, 1);
  assert.equal(queries, 1);
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
  assert.match(result.results[0].error, /grant revoked after preflight/);
});

test("native declarative DB tasks also require preflight before preceding HTTP", async () => {
  let calls = 0;
  const nativeTasks = {
    version: 1,
    before: [
      {
        type: "database",
        enabled: 1,
        data: {
          connectionId: "native-db",
          query: "SELECT 1",
          variables: [],
          isConsoleOutput: 0,
        },
      },
    ],
    after: [],
  };
  await assert.rejects(
    runPlan(
      {
        steps: [
          first(),
          rows([http("native", { nativeTasks, inheritSharedScripts: false })]),
        ],
      },
      {},
      async () => {
        calls++;
        return response();
      },
      opts({
        databaseQuery: async () => {
          calls++;
        },
        databasePreflight: async (ids) => {
          assert.deepEqual(ids, ["native-db"]);
          throw Error("no native grant");
        },
      }),
    ),
    /no native grant/,
  );
  assert.equal(calls, 0);
});
