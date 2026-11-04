import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { prepareStagedLoad, runStagedLoad } from "../src/staged-load-plan.mjs";
const leaf = { id: "leaf", request: { url: "http://example.test" } };
const condition = (name, op, right) => ({
  op,
  left: { scope: "iterationData", name },
  right,
});
const gate = (condition) => ({
  id: "gate",
  type: "if",
  condition,
  steps: [leaf],
});
const rows = (data, condition) => ({
  steps: [
    {
      id: "rows",
      type: "repeat",
      count: data.length,
      rows: data,
      steps: [gate(condition)],
    },
  ],
});
const response = async () => ({ status: 200, headers: {}, body: "ok" });

test("row IF preserves falsy primitives and uses dotted and template-like keys literally", async () => {
  for (const v of [false, 0, null]) {
    const p = snapshotPlan(rows([{ v }], condition("v", "eq", { literal: v })));
    assert.equal(
      (await runPlan(p, {}, response)).conditionResults[0].matched,
      true,
    );
  }
  for (const [name, data, value] of [
    ["a.b", { "a.b": 7, a: { b: 8 } }, 7],
    ["{{x}}", { "{{x}}": "literal", x: "expanded" }, "literal"],
  ]) {
    const p = snapshotPlan(
      rows([data], condition(name, "eq", { literal: value })),
    );
    assert.equal(
      (await runPlan(p, {}, response)).conditionResults[0].matched,
      true,
    );
  }
  assert.throws(
    () =>
      snapshotPlan(
        rows([{ a: { b: 7 } }], condition("a.b", "eq", { literal: 7 })),
      ),
    /字段不存在/,
  );
});

test("row IF mixed operands preflight primitive and numeric domains without coercion", () => {
  assert.throws(
    () =>
      snapshotPlan(
        rows(
          [{ v: "2" }],
          condition("v", "gt", { scope: "runtime", name: "x" }),
        ),
      ),
    /顺序比较/,
  );
  assert.throws(
    () =>
      snapshotPlan(
        rows([{ v: "true" }], condition("v", "eq", { literal: true })),
      ),
    /类型不匹配/,
  );
  for (const v of ["", {}, [], "x".repeat(8193)])
    assert.throws(
      () =>
        snapshotPlan(
          rows([{ v }], condition("v", "eq", { scope: "runtime", name: "x" })),
        ),
      /比较值/,
    );
});

test("row IF rejects all bad rows before earlier effects, including disabled and false branches", async () => {
  let hits = 0;
  const invalid = rows(
    [{ v: true }, {}],
    condition("v", "eq", { literal: true }),
  );
  invalid.steps.unshift({
    id: "first",
    request: { url: "http://example.test" },
  });
  await assert.rejects(
    runPlan(invalid, {}, async () => {
      hits++;
      return response();
    }),
    /字段不存在/,
  );
  assert.equal(hits, 0);
  const inner = gate(condition("v", "eq", { literal: true }));
  const parent = {
    id: "parent",
    type: "if",
    condition: { op: "eq", left: { literal: 1 }, right: { literal: 2 } },
    steps: [inner],
  };
  assert.throws(
    () =>
      snapshotPlan({
        steps: [
          { id: "rows", type: "repeat", count: 1, rows: [{}], steps: [parent] },
        ],
      }),
    /字段不存在/,
  );
  inner.enabled = false;
  assert.throws(
    () =>
      snapshotPlan({
        steps: [
          { id: "rows", type: "repeat", count: 1, rows: [{}], steps: [inner] },
        ],
      }),
    /字段不存在/,
  );
});

test("external executionContext cannot supply or override canonical row IF data", async () => {
  const c = condition("v", "eq", { literal: true });
  await assert.rejects(
    runPlan({ steps: [gate(c)] }, {}, response, {
      executionContext: { iterationData: { v: true } },
    }),
    /数据行循环/,
  );
  await assert.rejects(
    runPlan(rows([{}], c), {}, response, {
      executionContext: { iterationData: { v: true } },
    }),
    /字段不存在/,
  );
  const p = snapshotPlan(rows([{ v: false }], c));
  let hits = 0;
  const result = await runPlan(
    p,
    {},
    async () => {
      hits++;
      return response();
    },
    { executionContext: { iterationData: { v: true } } },
  );
  assert.equal(hits, 0);
  assert.equal(result.conditionResults[0].matched, false);
  const after = rows([{ v: true }], c);
  after.steps.push({
    ...gate(c),
    id: "outside",
    steps: [{ ...leaf, id: "outside-leaf" }],
  });
  assert.throws(() => snapshotPlan(after), /数据行循环/);
});

test("staged load honors canonical row IF and keeps row fields out of reports", async (t) => {
  let hits = 0;
  const peer = http.createServer((req, res) => {
    hits++;
    res.end("ok");
  });
  const directory = await mkdtemp(join(tmpdir(), "if-data-review-"));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const store = new Store(directory);
  await store.init();
  const project = await store.create("review");
  const p = rows(
    [{ take: false }, { take: true }],
    condition("take", "eq", { literal: true }),
  );
  p.steps[0].steps[0].steps = [
    {
      id: "leaf",
      request: { url: `http://127.0.0.1:${peer.address().port}/` },
    },
  ];
  const prepared = prepareStagedLoad(project, p, {
    initialVUs: 1,
    stages: [{ durationSeconds: 1, targetVUs: 1 }],
    maxIterations: 1,
  });
  const reports = [];
  const result = await runStagedLoad(project, prepared, {
    onProgress: (value) => reports.push(value),
  });
  assert.equal(hits, 1);
  assert.equal(result.mainRequests, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.steps[0].count, 1);
  assert(!JSON.stringify(reports).includes("take"));
});
