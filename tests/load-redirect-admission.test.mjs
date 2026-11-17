import test from "node:test";
import assert from "node:assert/strict";
import {
  admitLoadRedirects,
  createLoadNetworkBudget,
  loadNetworkBudget,
  isLoadNetworkBudgetFailure,
} from "../src/load-network-budget.mjs";

const redirect = { mode: "same-origin", maxHops: 1 };
const base = () => ({ url: "http://127.0.0.1/fixture", redirect });

test("redirect admission rejects every active executable dynamic source without evaluating it", () => {
  const specs = [
    { source: "fixed", value: "fixture", functions: ["custom"] },
    { source: "variable", value: "fixture", functions: ["custom"] },
    { source: "mock", type: "string", value: "fixture" },
    ...[
      "apipost-function",
      "apipost-header-function",
      "apipost-form-function",
      "apipost-body-function",
    ].map((source) => ({ source, value: "fixture" })),
  ];
  for (const group of ["query", "headers", "path", "cookies", "form"])
    for (const dynamic of specs)
      assert.throws(
        () =>
          admitLoadRedirects(
            [{ ...base(), [group]: [{ key: "x", value: "fixture", dynamic }] }],
            1,
          ),
        /动态函数|Mock/,
      );
  for (const spec of specs)
    assert.throws(
      () =>
        admitLoadRedirects(
          [
            {
              ...base(),
              bodyDynamic: { value: { ...spec, format: "text" } },
              body: "{{@value:value}}",
            },
          ],
          1,
        ),
      /动态函数|Mock/,
    );
});

test("redirect admission permits fixed/variable values without processing chains", () => {
  for (const source of ["fixed", "variable"])
    for (const functions of [undefined, []]) {
      const spec = {
        source,
        value: "fixture",
        ...(functions ? { functions } : {}),
      };
      for (const group of ["query", "headers", "path", "cookies", "form"])
        assert.equal(
          admitLoadRedirects(
            [
              {
                ...base(),
                [group]: [{ key: "x", value: "fixture", dynamic: spec }],
              },
            ],
            1,
          ),
          true,
        );
      assert.equal(
        admitLoadRedirects(
          [{ ...base(), bodyDynamic: { value: { ...spec, format: "text" } } }],
          1,
        ),
        true,
      );
    }
});

test("redirect admission checks nonredirect leaves in a mixed plan and never evaluates script text", () => {
  for (const definition of [
    { beforeScript: "throw new Error('must not execute')" },
    { afterScript: "throw new Error('must not execute')" },
    {
      sharedBeforeScripts: [
        { name: "shared", code: "throw new Error('must not execute')" },
      ],
    },
    {
      sharedAfterScripts: [
        { name: "shared", code: "throw new Error('must not execute')" },
      ],
    },
    { before: [{ type: "set", name: "v", value: "fixture" }] },
    { after: [{ type: "set", name: "v", value: "fixture" }] },
    { nativeTasks: { before: [{}], after: [] } },
    { nativeTasks: { before: [], after: [{}] } },
  ])
    assert.throws(
      () =>
        admitLoadRedirects(
          [base(), { url: "http://127.0.0.1/plain", ...definition }],
          2,
        ),
      /脚本|任务/,
    );
  assert.throws(
    () =>
      admitLoadRedirects(
        [
          base(),
          {
            query: [
              {
                key: "x",
                value: "fixture",
                dynamic: {
                  source: "fixed",
                  value: "fixture",
                  functions: ["custom"],
                },
              },
            ],
          },
        ],
        2,
      ),
    /动态函数/,
  );
  for (const type of [
    "digest",
    "ntlm",
    "aws",
    "oauth1",
    "hawk",
    "edgegrid",
    "jwt",
    "asap",
  ])
    assert.throws(
      () => admitLoadRedirects([base(), { auth: { type } }], 2),
      /认证/,
    );
});

test("no-redirect admission retains the old execution contract and adds no dynamic restrictions", () => {
  assert.equal(
    admitLoadRedirects(
      [
        {
          beforeScript: "throw new Error('must not execute during admission')",
          auth: { type: "digest" },
          query: [
            {
              key: "x",
              value: "fixture",
              dynamic: {
                source: "fixed",
                value: "fixture",
                functions: ["custom"],
              },
            },
          ],
          bodyDynamic: { x: { source: "mock", value: "fixture" } },
        },
      ],
      100,
    ),
    false,
  );
  assert.equal(
    admitLoadRedirects(
      [
        {
          ...base(),
          query: [
            {
              key: "x",
              enabled: false,
              dynamic: { source: "mock", value: "fixture" },
            },
          ],
        },
      ],
      1,
    ),
    true,
  );
});

test("mixed redirect worst-hop admission is conservative and exact at its 100-operation bound", () => {
  assert.equal(admitLoadRedirects([base()], 50), true);
  assert.throws(() => admitLoadRedirects([base()], 51), /100/);
  const slow = { ...base(), redirect: { mode: "same-origin", maxHops: 5 } };
  assert.equal(admitLoadRedirects([slow, {}], 16), true);
  assert.throws(() => admitLoadRedirects([slow, {}], 17), /100/);
});

test("load network capability cannot be reconstructed from JSON and exhausted reservations cannot start new work", () => {
  let stopped = 0;
  const budget = createLoadNetworkBudget(() => stopped++);
  assert.equal(loadNetworkBudget(budget), budget);
  assert.equal(loadNetworkBudget(undefined), undefined);
  assert.throws(() => loadNetworkBudget({ reserve() {}, start() {} }), /无效/);
  assert.throws(
    () => loadNetworkBudget(JSON.parse(JSON.stringify(budget))),
    /无效/,
  );
  for (let i = 0; i < 100; i++) {
    budget.reserve();
    budget.start(i % 2);
  }
  assert.deepEqual(budget.snapshot(), {
    limit: 100,
    reservations: 100,
    started: 100,
    redirectHops: 50,
  });
  assert.throws(
    () => budget.reserve(),
    (error) => isLoadNetworkBudgetFailure(error),
  );
  assert.equal(
    isLoadNetworkBudgetFailure(Error("压测主链网络预算已耗尽")),
    false,
  );
  assert.equal(stopped, 1);
  assert.deepEqual(budget.snapshot(), {
    limit: 100,
    reservations: 100,
    started: 100,
    redirectHops: 50,
  });
});
