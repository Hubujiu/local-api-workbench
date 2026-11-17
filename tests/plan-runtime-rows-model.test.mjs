import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  validateRuntimeRows,
  hasRuntimeRows,
  planOccurrences,
  potentialPlanStepCount,
  activePlanStepCount,
  activePlanLeaves,
  runtimeRowsMaxRowBytes,
} from "../src/plan-repeat.mjs";

const leaf = (id = "http") => ({
  id,
  request: { url: "https://example.invalid" },
});
const rows = (overrides = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 2,
  steps: [leaf()],
  ...overrides,
});
const fixed = (id, steps, count = 2) => ({ id, type: "repeat", count, steps });
const condition = (overrides = {}) => ({
  op: "eq",
  left: { scope: "iterationData", name: "ok" },
  right: { literal: true },
  ...overrides,
});
const check = (steps) =>
  validateRepeatGraph(steps, { requireIds: true, allowRuntimeRows: true });
const compile = (steps) =>
  planOccurrences(steps, { controls: true, runtimeRows: true });

test("runtime rows are opt-in and old eager consumers fail closed", () => {
  const steps = [rows()];
  assert.throws(() => validateRepeatGraph(steps), /尚未启用/);
  assert.throws(() => activePlanStepCount({ steps }), /尚未启用/);
  assert.throws(() => planOccurrences(steps), /显式启用/);
  assert.throws(
    () => planOccurrences(steps, { runtimeRows: true }),
    /显式启用/,
  );
  assert.equal(check(steps), true);
  assert.throws(() => activePlanLeaves(steps), /尚未启用/);
  assert.deepEqual(
    activePlanLeaves(steps, { allowRuntimeRows: true }),
    steps[0].steps,
  );
  assert.equal(
    potentialPlanStepCount({ steps }, { allowRuntimeRows: true }),
    2,
  );
  assert.equal(hasRuntimeRows(steps), true);
  steps[0].enabled = false;
  assert.equal(hasRuntimeRows(steps, { activeOnly: true }), false);
  assert.equal(
    potentialPlanStepCount({ steps }, { allowRuntimeRows: true }),
    0,
  );
  assert.deepEqual(compile(steps), []);
});

test("canonical runtime source, max bounds and mutually exclusive fields are strict", () => {
  for (const change of [
    { rowsFrom: { name: "items" } },
    { rowsFrom: { scope: "environment", name: "items" } },
    { rowsFrom: { scope: "runtime", name: "constructor" } },
    { rowsFrom: { scope: "runtime", name: "items", path: "x" } },
    { rowsFrom: { scope: "runtime", name: "\ud800" } },
    { maxRows: 0 },
    { maxRows: 101 },
    { maxRows: 1.5 },
    { maxRows: undefined },
    { maxRowBytes: 0 },
    { maxRowBytes: 524289 },
    { maxRowBytes: null },
    { count: undefined },
    { rows: undefined },
    { untilCondition: undefined },
  ])
    assert.throws(() => check([rows(change)]));
  assert.throws(
    () =>
      check([
        fixed("fixed", [leaf()], 2),
        { ...fixed("other", [leaf("b")]), maxRows: 2 },
      ]),
    /maxRows/,
  );
  assert.equal(runtimeRowsMaxRowBytes(rows()), 16384);
});

test("all data-repeat ancestry combinations reject, canonical subtree restriction includes disabled leaves", () => {
  const inline = { ...fixed("inline", [leaf()]), rows: [{}, {}] };
  for (const steps of [
    [rows({ steps: [inline] })],
    [rows({ steps: [rows({ id: "inner" })] })],
    [{ ...inline, steps: [rows()] }],
  ])
    assert.throws(() => check(steps), /嵌套数据行/);
  for (const type of ["protocol", "database"])
    assert.throws(
      () => check([rows({ steps: [{ id: "other", type, enabled: false }] })]),
      /仅支持HTTP/,
    );
  assert.equal(
    check([fixed("outer", [rows({ steps: [fixed("inner", [leaf()])] })])]),
    true,
  );
});

test("independent control, request, logical-byte and wait budgets include disabled definitions", () => {
  assert.throws(
    () => check([fixed("outer", [rows({ maxRows: 100 })])]),
    /控制预算/,
  );
  assert.throws(
    () => check([rows({ maxRows: 100, steps: [fixed("inner", [leaf()], 3)] })]),
    /200个请求/,
  );
  assert.throws(
    () =>
      check([rows({ maxRows: 10, maxRowBytes: 512 * 1024, enabled: false })]),
    /4MiB/,
  );
  assert.throws(
    () => check([rows({ maxRows: 8, maxRowBytes: 512 * 1024 })]),
    /4MiB/,
  );
  assert.throws(
    () => check([rows({ maxRows: 100, intervalMs: 1000 })]),
    /60000/,
  );
  assert.throws(
    () =>
      check([
        rows({ maxRows: 4, maxRowBytes: 512 * 1024 }),
        rows({
          id: "second",
          maxRows: 4,
          maxRowBytes: 512 * 1024,
          steps: [leaf("second-http")],
        }),
      ]),
    /4MiB/,
  );
});

test("fixed runtime program gates dominate bodies and waits, exits and if/until jumps are absolute", () => {
  const inner = fixed("inner", [leaf()], 2);
  inner.untilCondition = condition();
  inner.intervalMs = 1;
  const steps = [
    fixed("outer", [rows({ intervalMs: 2, steps: [inner] })]),
    leaf("tail"),
  ];
  const program = compile(steps);
  const entries = program.filter((x) => x.kind === "runtime-rows-enter");
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].frameId, entries[1].frameId);
  const identities = program.flatMap(
    (x) => x.occurrenceId || x.repeat?.occurrenceId || [],
  );
  assert.equal(new Set(identities).size, identities.length);
  for (const entry of entries) {
    assert.equal(program[entry.exitTo].kind, "runtime-rows-exit");
    assert.equal(program[entry.exitTo].frameId, entry.frameId);
    let iteration = -1;
    for (const op of program.slice(program.indexOf(entry) + 1, entry.exitTo)) {
      if (op.kind === "runtime-rows-gate") {
        iteration++;
        assert.equal(op.iteration, iteration);
        assert.equal(op.exitTo, entry.exitTo);
      }
      assert.equal(op.runtimeFrameId, entry.frameId);
      assert.equal(op.runtimeIteration, iteration);
      assert.equal(op.dataContext, undefined);
      if (op.skipTo !== undefined)
        assert(op.skipTo <= entry.exitTo && op.skipTo > program.indexOf(op));
    }
  }
  assert.equal(program.at(-1).step.id, "tail");
  assert.equal(program.at(-1).runtimeFrameId, undefined);
  const nestedIf = [
    {
      id: "if",
      type: "if",
      condition: {
        op: "eq",
        left: { literal: true },
        right: { literal: true },
      },
      steps: [rows()],
    },
  ];
  const conditional = compile(nestedIf);
  assert.equal(conditional[0].skipTo, conditional.length);
});

test("runtime rows validate the entire array and deep freeze an independent snapshot", () => {
  const source = [{ ok: true, nested: { values: [1, null] } }, { ok: false }];
  const snapshot = validateRuntimeRows(rows(), source);
  assert.deepEqual(snapshot, source);
  source[0].nested.values[0] = 9;
  assert.equal(snapshot[0].nested.values[0], 1);
  assert(
    Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0].nested.values),
  );
  assert.deepEqual(validateRuntimeRows(rows(), []), []);
  assert.throws(() => validateRuntimeRows(rows(), [{}, {}, {}]), /maxRows/);
  assert.throws(
    () => validateRuntimeRows(rows({ maxRowBytes: 2 }), [{ value: true }]),
    /maxRowBytes/,
  );
  const branch = {
    id: "if",
    type: "if",
    enabled: false,
    condition: condition(),
    steps: [leaf()],
  };
  assert.throws(
    () =>
      validateRuntimeRows(rows({ steps: [branch] }), [
        { ok: true },
        { missing: true },
      ]),
    /字段不存在/,
  );
  assert.throws(
    () =>
      validateRuntimeRows(rows({ steps: [branch] }), [{ ok: true }, { ok: 1 }]),
    /类型不匹配/,
  );
});

test("strict JSON rejects hooks, proxies, holes and unsafe values without executing user behavior", () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps++;
        throw Error("trap");
      },
      ownKeys() {
        traps++;
        throw Error("trap");
      },
    },
  );
  const getter = {};
  Object.defineProperty(getter, "x", {
    enumerable: true,
    get() {
      traps++;
      throw Error("getter");
    },
  });
  const extra = [];
  extra.x = true;
  const cycle = {};
  cycle.self = cycle;
  const hook = {
    toJSON() {
      traps++;
      throw Error("hook");
    },
  };
  for (const value of [
    proxy,
    [proxy],
    [getter],
    [hook],
    [{ x: proxy }],
    [{ x: new Date() }],
    [{ x: -0 }],
    [{ x: NaN }],
    [{ x: Infinity }],
    [{ x: undefined }],
    [{ x: 1n }],
    [{ x: Symbol() }],
    [{ x: extra }],
    [{ x: Array(1) }],
    [cycle],
    Array(1),
    [JSON.parse('{"__proto__":1}')],
    [JSON.parse('{"constructor":1}')],
  ])
    assert.throws(() => validateRuntimeRows(rows(), value));
  assert.equal(traps, 0);
});

test("control budget is exact at the boundary and empty enabled bodies remain gated", () => {
  const bounded = [fixed("outer", [rows({ maxRows: 98 })])];
  assert.equal(check(bounded), true);
  assert.equal(compile(bounded).filter((op) => op.runtimeRows).length, 200);
  bounded[0].steps[0].maxRows = 99;
  assert.throws(() => check(bounded), /控制预算/);
  const disabledBody = [
    rows({ intervalMs: 10, steps: [{ ...leaf(), enabled: false }] }),
  ];
  const program = compile(disabledBody);
  assert.deepEqual(
    program.map((op) => op.kind),
    [
      "runtime-rows-enter",
      "runtime-rows-gate",
      "runtime-rows-gate",
      "runtime-rows-exit",
    ],
  );
  assert.equal(program[0].exitTo, 3);
});

test("new graph entry points never invoke getters or proxy traps before validation", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw Error("must not execute");
  };
  const proxiedArray = new Proxy([], {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
  });
  const proxiedStep = new Proxy(
    {},
    {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    },
  );
  const getterSteps = { id: "outer", type: "repeat", count: 1 };
  Object.defineProperty(getterSteps, "steps", { enumerable: true, get: trap });
  const getterType = { id: "x", steps: [] };
  Object.defineProperty(getterType, "type", { enumerable: true, get: trap });
  const getterEnabled = rows();
  Object.defineProperty(getterEnabled, "enabled", {
    enumerable: true,
    get: trap,
  });
  const getterElement = [];
  Object.defineProperty(getterElement, "0", { enumerable: true, get: trap });
  const inherited = Object.create({
    get type() {
      return trap();
    },
  });
  for (const steps of [
    proxiedArray,
    [proxiedStep],
    [getterSteps],
    [getterType],
    [getterEnabled],
    getterElement,
    [inherited],
    [rows({ steps: [proxiedStep] })],
    [rows({ steps: proxiedArray })],
  ]) {
    assert.throws(() => hasRuntimeRows(steps));
    assert.throws(() => planOccurrences(steps));
    assert.throws(() => compile(steps));
    assert.throws(() => check(steps));
    assert.throws(() =>
      potentialPlanStepCount({ steps }, { allowRuntimeRows: true }),
    );
  }
  const plan = {};
  Object.defineProperty(plan, "steps", { enumerable: true, get: trap });
  assert.throws(() => potentialPlanStepCount(plan));
  assert.equal(calls, 0);
});
