import test from "node:test";
import assert from "node:assert/strict";
import { createScriptMockFacade } from "../src/script-mock-template.mjs";
import {
  createScriptMockBudget,
  validateScriptMockUsage,
} from "../src/script-mock-budget.mjs";

// Only native builtins and the adapter/ledger are imported. No actual Mock
// package, generated asset, engine, application, worker, transport or SQL.
const limits = {
  mockCallLimit: 1000,
  mockNodeLimit: 10000,
  mockByteLimit: 1048576,
};
function fixture(result) {
  const budget = createScriptMockBudget(limits),
    received = [];
  const facade = createScriptMockFacade((value) => {
    received.push(value);
    return result;
  }, budget.reserve);
  return { facade, budget, received };
}
test("Mock pure adapter clones own JSON data without evaluating getter or toJSON", () => {
  const { facade, received } = fixture({ a: [true, null, "x"] });
  const source = Object.freeze({ a: Object.freeze([true, null, "x"]) });
  assert.deepEqual(facade.mock(source), { a: [true, null, "x"] });
  assert.notEqual(received[0], source);
  assert.equal(Object.getPrototypeOf(received[0]), null);
  assert.notEqual(received[0].a, source.a);
  let called = 0;
  for (const value of [
    {
      get a() {
        called++;
        return 1;
      },
    },
    {
      toJSON() {
        called++;
        return {};
      },
    },
  ])
    assert.throws(() => facade.mock(value), /^Error: Mock模板: /);
  assert.equal(called, 0);
});
test("Mock pure admission rejects unsupported graph and rules before generator", () => {
  const { facade, received } = fixture(null);
  const alias = {},
    cycle = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    /x/,
    new Date(0),
    new Map(),
    new Set(),
    new Uint8Array(1),
    new Number(1),
    [, 1],
    { a: alias, b: alias },
    cycle,
    Object.create({ inherited: 1 }),
    { [Symbol("x")]: 1 },
    JSON.parse('{"__proto__":1}'),
    { "constructor|1": 0 },
    { prototype: 1 },
    { a: 1, "a|2": 1 },
    { "a|+1": 1 },
    { "a|1.2": 1 },
    { "a|2tail": 1 },
    { "a|2": "x" },
    { "a|2": true },
    { "a|2": {} },
    { "a|-1": [1] },
    { "a|2-1": 0 },
    { "a|9007199254740992": 0 },
    { "a|-9007199254740991-9007199254740991": 0 },
    { "a|1001": [1] },
    { "a\n|2": [1] },
    { "a|-0": 0 },
    "@missing(globalThis.marker=1)",
    "a@b.test",
    "\\@literal",
    { nested: "@name" },
  ])
    assert.throws(() => facade.mock(value), /^Error: Mock模板: /);
  assert.equal(received.length, 0);
  assert.throws(() => facade.mock(), /仅支持单个JSON模板参数/);
  assert.throws(() => facade.mock({}, {}), /仅支持单个JSON模板参数/);
  assert.throws(() => new facade.mock(1), /不支持构造调用/);
});
test("Mock pure bounds charge array selection candidate work rather than selected output", () => {
  const { facade, budget, received } = fixture({ value: 1 });
  facade.mock({ "value|1": [1, 2, 3] });
  assert.equal(received.length, 1);
  assert.deepEqual(budget.usage(), {
    mockCalls: 1,
    mockNodes: 6,
    mockBytes: 17,
  });
  const repeated = fixture({ rows: [1, 2, 1, 2] });
  repeated.facade.mock({ "rows|2": [1, 2] });
  assert.deepEqual(repeated.budget.usage(), {
    mockCalls: 1,
    mockNodes: 6,
    mockBytes: 18,
  });
});
test("Mock pure preflight rejects multiplicative expansion before any generator allocation", () => {
  const { facade, received } = fixture(null);
  for (const value of [
    { "a|100": [{ "b|100": [1] }] },
    { "a|999": [1, 2] },
    { "a|3": ["x".repeat(30000)] },
    { "a|1": Array.from({ length: 999 }, () => 0) },
  ])
    assert.throws(() => facade.mock(value), /额度超限/);
  assert.equal(received.length, 0);
});
test("Mock pure exact UTF-8 JSON sizing covers escaping and lone surrogates", () => {
  for (const value of [
    '"\\\b\t\n\f\r\u0000',
    "中文😀",
    "\ud800",
    "\udfff",
    "x",
  ]) {
    const { facade, budget } = fixture(value);
    assert.equal(facade.mock(value), value);
    assert.equal(
      budget.usage().mockBytes,
      Buffer.byteLength(JSON.stringify(value)),
    );
  }
  const { facade, received } = fixture(null);
  for (const value of [
    "x".repeat(65535),
    "\u0000".repeat(10923),
    "中".repeat(21845),
  ])
    assert.throws(() => facade.mock(value), /64KiB/);
  assert.equal(received.length, 0);
});
test("Mock pure descriptor graph detects transitive native function changes", () => {
  const { facade, received } = fixture(1);
  const own = Object.getOwnPropertyDescriptor(
    Object.prototype.toString,
    "call",
  );
  let invoked = 0,
    error;
  try {
    Object.defineProperty(Object.prototype.toString, "call", {
      configurable: true,
      value() {
        invoked++;
        return "[object Number]";
      },
    });
    try {
      facade.mock(1);
    } catch (caught) {
      error = caught;
    }
  } finally {
    if (own) Object.defineProperty(Object.prototype.toString, "call", own);
    else delete Object.prototype.toString.call;
  }
  assert.match(error?.message, /^Mock模板: 内建对象已修改$/);
  assert.equal(invoked, 0);
  assert.equal(received.length, 0);
  assert.equal(facade.mock(1), 1);
});
test("Mock pure post-traversal guard rejects Proxy-induced inherited pollution without getter execution", () => {
  const { facade, received } = fixture({ a: 1 });
  let invoked = 0,
    error;
  const own = Object.getOwnPropertyDescriptor(Object.prototype, "get");
  const source = new Proxy(
    { a: 1 },
    {
      getOwnPropertyDescriptor(target, key) {
        const description = Reflect.getOwnPropertyDescriptor(target, key);
        Object.setPrototypeOf(description, null);
        Object.defineProperty(Object.prototype, "get", {
          configurable: true,
          get() {
            invoked++;
            return () => 1;
          },
        });
        return description;
      },
    },
  );
  try {
    try {
      facade.mock(source);
    } catch (caught) {
      error = caught;
    }
  } finally {
    if (own) Object.defineProperty(Object.prototype, "get", own);
    else delete Object.prototype.get;
  }
  assert.match(error?.message, /^Mock模板: 内建对象已修改$/);
  assert.equal(invoked, 0);
  assert.equal(received.length, 0);
});
test("Mock pure host ledger debits rejected inputs and saturates caught exhaustion", () => {
  const bounded = { mockCallLimit: 2, mockNodeLimit: 2, mockByteLimit: 4 };
  const budget = createScriptMockBudget(bounded);
  const facade = createScriptMockFacade(() => 1, budget.reserve);
  assert.throws(() => facade.mock("@bad"), /暂不支持/);
  assert.equal(facade.mock(1), 1);
  assert.deepEqual(budget.usage(), {
    mockCalls: 2,
    mockNodes: 1,
    mockBytes: 1,
  });
  assert.throws(() => facade.mock(1), /^Error: Mock模板额度已用尽$/);
  assert.deepEqual(budget.usage(), {
    mockCalls: 2,
    mockNodes: 2,
    mockBytes: 4,
  });
  assert.throws(() => facade.mock(1), /^Error: Mock模板额度已用尽$/);
  validateScriptMockUsage(budget.usage(), bounded);
  for (const usage of [
    null,
    {},
    { mockCalls: -1, mockNodes: 0, mockBytes: 0 },
    { mockCalls: 3, mockNodes: 0, mockBytes: 0 },
    { mockCalls: 1, mockNodes: 0.5, mockBytes: 0 },
  ])
    assert.throws(
      () => validateScriptMockUsage(usage, bounded),
      /计费结果无效/,
    );
});

test("Mock pure final checkpoint rejects publication without replenishing work credits", () => {
  const budget = createScriptMockBudget(limits),
    operations = [];
  let generated = 0;
  const facade = createScriptMockFacade(
    () => {
      generated++;
      return 1;
    },
    (kind, nodes, bytes) => {
      operations.push([kind, nodes, bytes]);
      budget.reserve(kind, nodes, bytes);
      if (kind === 2) throw Error("test-only checkpoint refusal");
    },
  );
  assert.throws(() => facade.mock(1), /^Error: test-only checkpoint refusal$/);
  assert.equal(generated, 1);
  assert.deepEqual(operations, [
    [0, 0, 0],
    [1, 1, 1],
    [2, 0, 0],
  ]);
  assert.deepEqual(budget.usage(), {
    mockCalls: 1,
    mockNodes: 1,
    mockBytes: 1,
  });
  assert.throws(() => budget.reserve(2, 1, 0), /内部计费无效/);
});
