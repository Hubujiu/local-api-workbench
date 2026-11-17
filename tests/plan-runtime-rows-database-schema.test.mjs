import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
const http = (id, request = {}) => ({
  id,
  request: { url: "http://example.test", ...request },
});
const db = (extra = {}) => ({
  type: "database",
  name: "result",
  connectionId: "db",
  sql: "SELECT 1",
  parameters: [],
  ...extra,
});
const rows = (steps, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 1,
  steps,
  ...extra,
});
const falseIf = (steps) => ({
  id: "false",
  type: "if",
  condition: { op: "eq", left: { literal: true }, right: { literal: false } },
  steps,
});
const producer = () =>
  http("producer", { beforeScript: "pm.environment.set('effect', 1);" });
const response = () => ({ status: 200, headers: {}, body: "{}" });
const invalids = [
  ["enabled", [db({ enabled: 1 })], /启用标识/],
  ["missing name", [db({ name: undefined })], /变量名/],
  ["wrong name type", [db({ name: 7 })], /变量名/],
  ["long name", [db({ name: "n".repeat(101) })], /变量名/],
  ["reserved name", [db({ name: "constructor" })], /变量名/],
  ["path type", [db({ path: {} })], /提取路径/],
  ["long path", [db({ path: "x".repeat(1001) })], /提取路径/],
  ["path syntax", [db({ path: "$[bad]" })], /JSON 路径/],
  ["reserved path", [db({ path: "$.constructor" })], /JSON 路径/],
  ["parameters type", [db({ parameters: {} })], /配置无效/],
  ["parameters count", [db({ parameters: Array(1001).fill(1) })], /参数最多/],
  ["connection type", [db({ connectionId: 1 })], /配置无效/],
  ["sql type", [db({ sql: {} })], /配置无效/],
  ["sql length", [db({ sql: "x".repeat(50001) })], /配置无效/],
  ["phase count", Array.from({ length: 6 }, () => db()), /每阶段/],
];
for (const mode of ["empty", "false-if"]) {
  for (const [name, operations, error] of invalids) {
    test(`${mode}: invalid declared DB ${name} prevents all producer effects`, async () => {
      let effects = 0;
      const body = http("database", { after: operations });
      const plan = {
        steps: [
          producer(),
          rows(mode === "empty" ? [body] : [falseIf([body])]),
        ],
      };
      await assert.rejects(
        runPlan(
          plan,
          {},
          async () => {
            effects++;
            return response();
          },
          {
            allowRuntimeRows: true,
            variableScopes: {
              runtime: { items: mode === "empty" ? [] : [{}] },
            },
            databaseQuery: async () => {
              effects++;
            },
            databasePreflight: async () => {
              effects++;
            },
            onScopeChanges: async () => {
              effects++;
            },
          },
        ),
        error,
      );
      assert.equal(effects, 0);
    });
  }
}

test("preflight preserves null parameters, empty path and ignored fields", async () => {
  let queries = 0;
  const plan = {
    steps: [
      rows([
        http("body", {
          before: [
            db({
              name: "ordinary",
              parameters: null,
              path: "",
              ignored: { arbitrary: true },
            }),
          ],
        }),
      ]),
    ],
  };
  const result = await runPlan(plan, {}, async () => response(), {
    allowRuntimeRows: true,
    variableScopes: { runtime: { items: [{}] } },
    databasePreflight: async () => {},
    databaseQuery: async (operation) => {
      queries++;
      assert.deepEqual(operation.parameters, []);
      return { value: 1 };
    },
  });
  assert.equal(result.status, "passed", result.results[0]?.error);
  assert.equal(queries, 1);
  assert.deepEqual(result.variables.ordinary, { value: 1 });
});

test("disabled operations skip malformed payload and do not consume phase budget or grants", async () => {
  let grants = 0,
    queries = 0;
  const plan = {
    steps: [
      rows([
        http("body", {
          before: Array.from({ length: 8 }, () => ({
            type: "database",
            enabled: false,
            name: null,
            sql: false,
            path: {},
            parameters: {},
          })),
        }),
      ]),
    ],
  };
  const result = await runPlan(plan, {}, async () => response(), {
    allowRuntimeRows: true,
    variableScopes: { runtime: { items: [{}] } },
    databasePreflight: async () => {
      grants++;
    },
    databaseQuery: async () => {
      queries++;
    },
  });
  assert.equal(result.status, "passed", result.results[0]?.error);
  assert.equal(grants, 0);
  assert.equal(queries, 0);
});

for (const kind of ["linear", "fixed", "disabled-only"]) {
  test(`${kind} keeps legacy DB validation timing and error precedence`, async () => {
    const body = http("bad", { before: [db({ name: undefined })] });
    const steps = [
      http("producer"),
      ...(kind === "fixed"
        ? [{ id: "fixed", type: "repeat", count: 1, steps: [body] }]
        : [body]),
    ];
    if (kind === "disabled-only")
      steps.push(rows([http("unused")], { enabled: false }));
    let calls = 0,
      preflights = 0;
    const result = await runPlan(
      snapshotPlan({ steps }, { allowRuntimeRows: true }),
      {},
      async () => {
        calls++;
        return response();
      },
      {
        allowRuntimeRows: true,
        databasePreflight: async () => {
          preflights++;
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(preflights, 0);
    assert.equal(result.status, "failed");
    assert.match(result.results[1].error, /未授权数据库前后置操作/);
  });
}

test("before and after database counts are independent", async () => {
  const operation = db({
    sql: "SELECT 1",
    parameters: ["{{parameter}}"],
  });
  let queries = 0;
  const result = await runPlan(
    {
      steps: [
        rows([
          http("body", {
            before: Array.from({ length: 5 }, () => operation),
            after: Array.from({ length: 5 }, () => operation),
          }),
        ]),
      ],
    },
    { parameter: "bound" },
    async () => response(),
    {
      allowRuntimeRows: true,
      variableScopes: { runtime: { items: [{}] } },
      databasePreflight: async () => {},
      databaseQuery: async (query) => {
        queries++;
        assert.equal(query.sql, "SELECT 1");
        assert.deepEqual(query.parameters, ["bound"]);
        return {};
      },
    },
  );
  assert.equal(result.status, "passed", result.results[0]?.error);
  assert.equal(queries, 10);
});

test("unexecuted declarations preserve whitespace names and do not evaluate SQL or parameter templates", async () => {
  let grants = 0,
    effects = 0;
  const result = await runPlan(
    {
      steps: [
        rows([
          http("body", {
            before: [
              db({
                name: " ",
                sql: "{{unknown SQL}}",
                parameters: ["{{unknown parameter}}"],
              }),
            ],
          }),
        ]),
      ],
    },
    {},
    async () => {
      effects++;
      return response();
    },
    {
      allowRuntimeRows: true,
      variableScopes: { runtime: { items: [] } },
      databasePreflight: async () => {
        grants++;
      },
      databaseQuery: async () => {
        effects++;
      },
    },
  );
  assert.equal(result.status, "passed");
  assert.equal(grants, 1);
  assert.equal(effects, 0);
});
