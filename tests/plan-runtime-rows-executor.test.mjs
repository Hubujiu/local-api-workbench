import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
const leaf = (id, extra = {}) => ({
  id,
  request: { url: `http://example.test/${id}`, ...extra },
});
const group = (steps = [leaf("body")], extra = {}) => ({
  type: "repeat",
  id: "rows",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const response = (value = {}) => ({
  status: 200,
  headers: {},
  body: JSON.stringify(value),
  duration: 0,
});
const options = (runtime = {}, extra = {}) => ({
  allowRuntimeRows: true,
  variableScopes: { runtime },
  ...extra,
});
const produce = leaf("produce", {
  extract: [{ name: "items", source: "json", path: "$.items" }],
});

test("runtime rows core admission stays closed by default and snapshot preserves canonical definition", async () => {
  const plan = { steps: [group()] };
  assert.throws(() => snapshotPlan(plan), /尚未启用/);
  await assert.rejects(
    runPlan(plan, {}, async () => response()),
    /尚未启用/,
  );
  const snapshot = snapshotPlan(plan, { allowRuntimeRows: true });
  assert.deepEqual(snapshot.steps[0].rowsFrom, plan.steps[0].rowsFrom);
  assert.equal(snapshot.steps[0].maxRows, 3);
  assert.equal(Object.hasOwn(snapshot.steps[0], "count"), false);
  assert.equal(Object.hasOwn(snapshot.steps[0], "maxRowBytes"), false);
});

test("response-produced rows use actual count, frozen source and restore outer context", async () => {
  const body = leaf("body", {
    beforeScript:
      "pm.environment.set('name',pm.iterationData.get('name'));pm.environment.set('index',pm.info.iteration);pm.environment.set('count',pm.info.iterationCount);",
    url: "http://example.test/{{name}}/{{index}}/{{count}}",
    extract: [{ name: "items", source: "json", path: "$.items" }],
  });
  const plan = {
    steps: [
      produce,
      group([body]),
      leaf("tail", {
        beforeScript:
          "pm.environment.set('name',pm.iterationData.get('name'));",
        url: "http://example.test/{{name}}",
      }),
    ],
  };
  const seen = [];
  const run = await runPlan(
    plan,
    {},
    async (request) => {
      seen.push(request.url);
      return response({
        items:
          seen.length === 1
            ? [{ name: "a" }, { name: "b" }]
            : [{ name: "changed" }],
      });
    },
    options(
      {},
      {
        executionContext: {
          iteration: 0,
          iterationCount: 1,
          iterationData: { name: "outer" },
        },
      },
    ),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, [
    "http://example.test/produce",
    "http://example.test/a/0/2",
    "http://example.test/b/1/2",
    "http://example.test/outer",
  ]);
  assert.equal(run.results.length, 4);
  assert.equal(run.conditionResults, undefined);
});

test("empty rows skip every wait and body and continue tail", async () => {
  const seen = [];
  const start = performance.now();
  const run = await runPlan(
    { steps: [group(undefined, { intervalMs: 10000 }), leaf("tail")] },
    {},
    async (req) => {
      seen.push(req.url);
      return response();
    },
    options({ items: [] }),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, ["http://example.test/tail"]);
  assert.ok(performance.now() - start < 1000);
});

for (const scopes of [
  { environment: { items: [{}] } },
  { globals: { items: [{}] } },
  { runtime: { items: [{}] }, hidden: ["items"] },
  {},
]) {
  test(`missing or hidden runtime own value fails closed: ${JSON.stringify(scopes)}`, async () => {
    let calls = 0;
    const run = await runPlan(
      { steps: [group(), leaf("tail")] },
      {},
      async () => {
        calls++;
        return response();
      },
      { allowRuntimeRows: true, variableScopes: scopes },
    );
    assert.equal(calls, 0);
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "runtime-rows-error");
    assert.equal(run.runtimeRowsFailure.code, "PLAN_RUNTIME_ROWS_INVALID");
    assert.deepEqual(run.results, []);
    assert.equal(run.conditionResults, undefined);
  });
}

test("every dynamic row and condition is checked before the first body", async () => {
  for (const items of [
    [{ ok: true }, { ok: {} }],
    [{ ok: true }, null],
    Array.from({ length: 4 }, () => ({ ok: true })),
  ]) {
    const nested = {
      type: "if",
      id: "if",
      condition: {
        op: "eq",
        left: { scope: "iterationData", name: "ok" },
        right: { literal: true },
      },
      steps: [leaf("selected")],
    };
    let calls = 0;
    const run = await runPlan(
      { steps: [produce, group([nested]), leaf("tail")] },
      {},
      async () => {
        calls++;
        return response({ items });
      },
      options(),
    );
    assert.equal(calls, 1);
    assert.equal(run.stopReason, "runtime-rows-error");
    assert.equal(run.status, "failed");
    assert.deepEqual(run.conditionResults, []);
  }
});

test("initial unsafe scopes cannot execute getters or silently normalize invalid JSON rows", async () => {
  let touched = 0;
  const getter = Object.defineProperty({}, "items", {
    enumerable: true,
    get() {
      touched++;
      return [{}];
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        return [];
      },
    },
  );
  for (const runtime of [
    getter,
    proxy,
    { items: [{ x: -0 }] },
    { items: [{ x: undefined }] },
    { items: [,] },
  ]) {
    await assert.rejects(
      runPlan(
        { steps: [group()] },
        {},
        async () => {
          touched++;
          return response();
        },
        options(runtime),
      ),
    );
  }
  assert.equal(touched, 0);
});

for (const failurePolicy of [undefined, "continue", "stop"]) {
  test(`unknown scope commit stops globally before dynamic entry (${failurePolicy})`, async () => {
    let calls = 0;
    const first = leaf("first", {
      extract: [
        {
          name: "saved",
          source: "json",
          path: "$.saved",
          scope: "environment",
        },
      ],
    });
    const run = await runPlan(
      {
        ...(failurePolicy ? { failurePolicy } : {}),
        steps: [first, group(), leaf("tail")],
      },
      {},
      async () => {
        calls++;
        return response({ saved: 1 });
      },
      options(
        { items: [{}] },
        {
          onScopeChanges: async () => {
            throw Object.assign(Error("unknown"), {
              code: "PROJECT_COMMIT_UNCERTAIN",
            });
          },
        },
      ),
    );
    assert.equal(calls, 1);
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(run.status, "failed");
    assert.equal(run.runtimeRowsFailure, undefined);
  });
}

test("cancellation after completed response wins before runtime entry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const run = await runPlan(
    { steps: [produce, group()] },
    {},
    async () => {
      calls++;
      return response({ items: [{}] });
    },
    options(
      {},
      { signal: controller.signal, onStep: () => controller.abort() },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "cancelled");
  assert.equal(run.runtimeRowsFailure, undefined);
  assert.equal(run.results[0].response.status, 200);
});

test("evidence limit excludes control instructions from potential requests", async () => {
  let calls = 0;
  const run = await runPlan(
    { steps: [leaf("huge"), group(), leaf("tail")] },
    {},
    async () => {
      calls++;
      return { ...response(), body: "x".repeat(8 * 1024 * 1024) };
    },
    options({ items: [{}] }),
  );
  assert.equal(calls, 1);
  assert.equal(run.stopReason, "evidence-limit");
  assert.equal(run.evidenceBudget.remaining, 4);
  assert.equal(run.evidenceBudget.remainingIsPotential, true);
  assert.equal(run.evidenceBudget.next.kind, "runtime-rows-enter");
  assert.equal(run.runtimeRowsFailure, undefined);
});

test("fixed descendants inherit dynamic row context and row IF skips only its subtree", async () => {
  const selected = {
    type: "if",
    id: "selected",
    condition: {
      op: "eq",
      left: { scope: "iterationData", name: "ok" },
      right: { literal: true },
    },
    steps: [
      {
        type: "repeat",
        id: "fixed",
        count: 2,
        steps: [
          leaf("nested", {
            beforeScript:
              "pm.environment.set('i',pm.info.iteration);pm.environment.set('n',pm.info.iterationCount);",
            url: "http://example.test/{{i}}/{{n}}",
          }),
        ],
      },
    ],
  };
  const seen = [];
  const run = await runPlan(
    { steps: [group([selected]), leaf("tail")] },
    {},
    async (req) => {
      seen.push(req.url);
      return response();
    },
    options({ items: [{ ok: false }, { ok: true }] }),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, [
    "http://example.test/1/2",
    "http://example.test/1/2",
    "http://example.test/tail",
  ]);
  assert.deepEqual(
    run.conditionResults.map((d) => d.matched),
    [false, true],
  );
  assert.deepEqual(run.results[0].repeat.path, [
    { groupId: "rows", iteration: 1 },
    { groupId: "fixed", iteration: 0 },
  ]);
});

test("each enclosing fixed iteration owns a new runtime frame and refreshes its snapshot", async () => {
  let producers = 0;
  const seen = [];
  const plan = {
    steps: [
      { type: "repeat", id: "outer", count: 2, steps: [produce, group()] },
    ],
  };
  const run = await runPlan(
    plan,
    {},
    async (req) => {
      seen.push(req.url);
      return response({
        items: req.url.endsWith("produce")
          ? Array.from({ length: ++producers }, () => ({}))
          : [],
      });
    },
    options(),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, [
    "http://example.test/produce",
    "http://example.test/body",
    "http://example.test/produce",
    "http://example.test/body",
    "http://example.test/body",
  ]);
  assert.equal(new Set(run.results.map((r) => r.repeat.occurrenceId)).size, 5);
});

test("unentered false branch does not resolve missing runtime source", async () => {
  const plan = {
    steps: [
      {
        type: "if",
        id: "skip",
        condition: {
          op: "eq",
          left: { literal: true },
          right: { literal: false },
        },
        steps: [group()],
      },
      leaf("tail"),
    ],
  };
  let calls = 0;
  const run = await runPlan(
    plan,
    {},
    async () => {
      calls++;
      return response();
    },
    options(),
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "passed");
  assert.equal(run.runtimeRowsFailure, undefined);
});

test("cancelling dynamic interval preserves completed row and does not run next body or tail", async () => {
  const controller = new AbortController();
  let calls = 0;
  const run = await runPlan(
    { steps: [group(undefined, { intervalMs: 10000 }), leaf("tail")] },
    {},
    async () => {
      calls++;
      return response();
    },
    options(
      { items: [{}, {}] },
      {
        signal: controller.signal,
        onStep: () => setTimeout(() => controller.abort(), 10),
      },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "cancelled");
  assert.equal(run.results[0].status, "passed");
  assert.equal(run.runtimeRowsFailure, undefined);
});

test("one actual row does not wait for unused reserved iterations", async () => {
  const start = performance.now();
  let calls = 0;
  const run = await runPlan(
    { steps: [group(undefined, { intervalMs: 10000 })] },
    {},
    async () => {
      calls++;
      return response();
    },
    options({ items: [{}] }),
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "passed");
  assert.ok(performance.now() - start < 1000);
});

test("source shape is validated at entry, allowing overwritten or unentered initial values", async () => {
  const skipped = {
    type: "if",
    id: "skip",
    condition: { op: "eq", left: { literal: true }, right: { literal: false } },
    steps: [group()],
  };
  const skip = await runPlan(
    { steps: [skipped, leaf("tail")] },
    {},
    async () => response(),
    options({ items: "not rows" }),
  );
  assert.equal(skip.status, "passed");
  let calls = 0;
  const overwritten = await runPlan(
    { steps: [produce, group()] },
    {},
    async () => {
      calls++;
      return response({ items: [{}] });
    },
    options({ items: "not rows" }),
  );
  assert.equal(overwritten.status, "passed");
  assert.equal(calls, 2);
});

test("progress failure preserves response and outranks later dynamic entry", async () => {
  let calls = 0;
  const run = await runPlan(
    { steps: [produce, group()] },
    {},
    async () => {
      calls++;
      return response({ items: [{}] });
    },
    options(
      {},
      {
        onStep: () => {
          throw Error("observer unavailable");
        },
      },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(run.stopReason, "progress-failure");
  assert.equal(run.results[0].response.status, 200);
  assert.equal(run.runtimeRowsFailure, undefined);
});

test("strict initial runtime JSON admission is bounded and independent of source shape", async () => {
  let deep = {};
  for (let i = 0; i < 40; i++) deep = { value: deep };
  for (const runtime of [
    { unrelated: undefined },
    { unrelated: -0 },
    { unrelated: deep },
  ]) {
    let calls = 0;
    await assert.rejects(
      runPlan(
        { steps: [produce, group()] },
        {},
        async () => {
          calls++;
          return response({ items: [] });
        },
        options(runtime),
      ),
      /变量输入|严格JSON/,
    );
    assert.equal(calls, 0);
  }
});

test("terminal oversized row evidence does not turn administrative gates and exit into work", async () => {
  let calls = 0;
  const run = await runPlan(
    { steps: [group(undefined, { intervalMs: 10000 })] },
    {},
    async () => {
      calls++;
      return { ...response(), body: "x".repeat(8 * 1024 * 1024) };
    },
    options({ items: [{}] }),
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "passed");
  assert.equal(run.stopReason, undefined);
  assert.equal(run.evidenceBudget, undefined);
});

for (const next of ["row", "tail", "enter"]) {
  test(`oversized row evidence still prevents next real boundary: ${next}`, async () => {
    let calls = 0;
    const steps = [group(undefined, { intervalMs: 10000 })];
    if (next === "tail") steps.push(leaf("tail"));
    if (next === "enter")
      steps.push(group([leaf("second-body")], { id: "second" }));
    const run = await runPlan(
      { steps },
      {},
      async () => {
        calls++;
        return { ...response(), body: "x".repeat(8 * 1024 * 1024) };
      },
      options({ items: next === "row" ? [{}, {}] : [{}] }),
    );
    assert.equal(calls, 1);
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "evidence-limit");
    if (next === "row")
      assert.equal(run.evidenceBudget.next.repeat.iteration, 1);
    if (next === "tail") assert.equal(run.evidenceBudget.next.stepId, "tail");
    if (next === "enter")
      assert.equal(run.evidenceBudget.next.kind, "runtime-rows-enter");
  });
}

test("disabled-only runtime definitions do not opt legacy execution into strict runtime admission", async () => {
  const disabled = group(undefined, { enabled: false });
  let calls = 0;
  const run = await runPlan(
    { steps: [disabled, leaf("tail")] },
    {},
    async () => {
      calls++;
      return response();
    },
    options({ unrelated: undefined, number: -0 }),
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "passed");
  assert.equal(run.runtimeRowsFailure, undefined);
  assert.throws(
    () =>
      snapshotPlan(
        { steps: [{ ...disabled, maxRows: 0 }] },
        { allowRuntimeRows: true },
      ),
    /maxRows/,
  );
});

test("disabled-only runtime definitions preserve legacy unknown commit continue behavior", async () => {
  let calls = 0;
  const first = leaf("first", {
    extract: [
      { name: "saved", source: "json", path: "$.saved", scope: "environment" },
    ],
  });
  const run = await runPlan(
    {
      failurePolicy: "continue",
      steps: [first, group(undefined, { enabled: false }), leaf("tail")],
    },
    {},
    async () => {
      calls++;
      return response({ saved: 1 });
    },
    options(
      {},
      {
        onScopeChanges: async () => {
          throw Object.assign(Error("unknown"), {
            code: "PROJECT_COMMIT_UNCERTAIN",
          });
        },
      },
    ),
  );
  assert.equal(calls, 2);
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, undefined);
  assert.equal(run.results[0].scopeCommit.outcome, "unknown");
});
