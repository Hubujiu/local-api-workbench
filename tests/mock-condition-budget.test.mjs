import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectMockResponse, validateMockRules } from "../src/mock.mjs";
import { createApp } from "../src/server.mjs";

const largeValue = "x".repeat(64 * 1024);
function definition() {
  const conditions = Array.from({ length: 49 }, () => ({
    target: "body.value",
    op: "neq",
    value: "never",
  }));
  conditions.push({ target: "body.value", op: "eq", value: "never" });
  return {
    id: "ordinary",
    name: "Bounded ordinary Mock",
    url: "http://example.test",
    mockRules: Array.from({ length: 100 }, (_, index) => ({
      name: "rule-" + index,
      conditions: structuredClone(conditions),
      response: { status: 200, body: "matched" },
    })),
    examples: [{ status: 200, body: "fallback" }],
  };
}
function observeSerialization(t) {
  const original = JSON.stringify;
  let calls = 0;
  const hook = t.mock.method(JSON, "stringify", function (value, ...args) {
    if (value === largeValue) calls++;
    return original.call(this, value, ...args);
  });
  return { count: () => calls, restore: () => hook.mock.restore() };
}

test("ordinary conditions reject cumulative work without lowering rule counts or changing comparison semantics", () => {
  const request = definition();
  validateMockRules(request.mockRules);
  assert.equal(
    selectMockResponse(request, { body: { value: "small" } }).body,
    "fallback",
  );
  assert.throws(
    () => selectMockResponse(request, { body: { value: largeValue } }),
    /Mock.*(预算|总量|budget)/i,
    "admitted repeated comparisons must fail explicitly, not silently return fallback",
  );
  assert.equal(
    selectMockResponse(request, { body: { value: "small" } }).body,
    "fallback",
  );
});

test(
  "owner-saved ordinary Mock rejects expensive HTTP input and preserves later requests, other projects and restart state",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ordinary-mock-budget-"));
    let app = await createApp({ root, port: 0 });
    const close = async () => {
      app.server.closeAllConnections();
      await new Promise((done) => app.server.close(done));
    };
    t.after(async () => {
      await close();
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, method = "GET", body) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert(response.ok, JSON.stringify(value));
      return value;
    };
    const first = await owner("/api/projects", "POST", { name: "Rules owner" });
    first.requests = [definition()];
    await owner("/api/projects/" + first.id, "PUT", first);
    const other = await owner("/api/projects", "POST", {
      name: "Unrelated owner",
    });
    other.requests = [
      {
        id: "healthy",
        name: "healthy",
        url: "http://example.test",
        examples: [{ status: 201, body: "other-project" }],
      },
    ];
    await owner("/api/projects/" + other.id, "PUT", other);
    const before = await app.store.get(first.id);
    const input = JSON.stringify({ value: largeValue });
    const observer = observeSerialization(t);
    let rejected, payload, calls;
    try {
      rejected = await fetch(app.url + "/mock/" + first.id + "/ordinary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: input,
      });
      payload = await rejected.text();
      calls = observer.count();
    } finally {
      observer.restore();
    }
    const small = await fetch(app.url + "/mock/" + first.id + "/ordinary", {
      method: "POST",
      body: JSON.stringify({ value: "small" }),
    });
    assert.equal(small.status, 200);
    assert.equal(await small.text(), "fallback");
    const healthy = await fetch(app.url + "/mock/" + other.id + "/healthy");
    assert.equal(healthy.status, 201);
    assert.equal(await healthy.text(), "other-project");
    assert.deepEqual(await app.store.get(first.id), before);
    await close();
    app = await createApp({ root, port: 0 });
    assert.deepEqual(await app.store.get(first.id), before);
    const restarted = await fetch(app.url + "/mock/" + first.id + "/ordinary", {
      method: "POST",
      body: JSON.stringify({ value: "small" }),
    });
    assert.equal(await restarted.text(), "fallback");
    t.diagnostic("large-value serializations: " + calls);
    // Keep the failure and cleanup observations independent from scheduler speed.
    assert.equal(
      rejected.status,
      400,
      "must not acknowledge exhausted comparison work as fallback success",
    );
    assert.match(payload, /Mock.*(预算|总量|budget)/i);
    assert(
      calls <= 17,
      "large actual value was serialized beyond the 1 MiB logical comparison envelope: " +
        calls,
    );
  },
);

test("ordinary comparison budgets retain JSON key order, scalar distinctions and String contains semantics", () => {
  const selected = (actual, op, value) =>
    selectMockResponse(
      {
        mockRules: [
          {
            conditions: [{ target: "body.value", op, value }],
            response: { status: 201, body: "matched" },
          },
        ],
        examples: [{ status: 200, body: "fallback" }],
      },
      { body: { value: actual } },
    ).status === 201;
  for (const [actual, expected] of [
    [null, null],
    [false, false],
    [0, 0],
    ["", ""],
    [undefined, undefined],
    [
      [1, null, "x"],
      [1, null, "x"],
    ],
    [
      { a: 1, b: 2 },
      { a: 1, b: 2 },
    ],
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
    [NaN, null],
    ["0", 0],
  ]) {
    assert.equal(
      selected(actual, "eq", expected),
      JSON.stringify(actual) === JSON.stringify(expected),
    );
    assert.equal(
      selected(actual, "neq", expected),
      JSON.stringify(actual) !== JSON.stringify(expected),
    );
  }
  for (const [actual, expected] of [
    [null, ""],
    [undefined, "undefined"],
    [false, "false"],
    [0, "0"],
    [[1, null, [2, 3]], ",,2"],
    [{ x: 1 }, "[object Object]"],
    ["雪😀\u0000", "😀"],
  ]) {
    assert.equal(
      selected(actual, "contains", expected),
      String(actual ?? "").includes(String(expected)),
    );
  }
  for (const value of [undefined, null, false, 0, ""])
    assert.equal(
      selected(value, "exists", null),
      value !== undefined && value !== null,
    );
});

test("encoding preflight bounds escaping and arrays before conversion, and getters or conversion callbacks never run", async (t) => {
  const { createMockConditionBudget } = await import(
    "../src/mock-condition-budget.mjs"
  );
  const escaped = "\u0000".repeat(200000);
  const original = JSON.stringify;
  let calls = 0;
  const observer = t.mock.method(JSON, "stringify", function (value, ...args) {
    if (value === escaped) calls++;
    return original.call(this, value, ...args);
  });
  try {
    assert.throws(() => createMockConditionBudget().json(escaped), /预算/);
    assert.equal(calls, 0);
  } finally {
    observer.mock.restore();
  }
  let effects = 0;
  for (const value of [
    {
      toJSON() {
        effects++;
        return 1;
      },
    },
    {
      get x() {
        effects++;
        return 1;
      },
    },
    {
      toString() {
        effects++;
        return "changed";
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          effects++;
          return [];
        },
      },
    ),
  ]) {
    assert.throws(() => createMockConditionBudget().json(value), /JSON数据/);
  }
  assert.equal(effects, 0);
  const hugeArray = Array(100001).fill(null);
  assert.throws(() => createMockConditionBudget().string(hugeArray), /预算/);
  const cycle = [];
  cycle.push(cycle);
  assert.throws(() => createMockConditionBudget().json(cycle), /circular/);
  assert.throws(() => createMockConditionBudget().string(cycle), /JSON数据/);
  let deep = 0;
  for (let i = 0; i < 66; i++) deep = { x: deep };
  assert.throws(() => createMockConditionBudget().json(deep), /预算/);
});

test("primitive caching still charges each comparison and no budget or mutable object cache crosses requests", async (t) => {
  const { createMockConditionBudget } = await import(
    "../src/mock-condition-budget.mjs"
  );
  const budget = createMockConditionBudget(),
    observer = observeSerialization(t);
  try {
    for (let i = 0; i < 15; i++)
      assert.equal(budget.json(largeValue), '"' + largeValue + '"');
    assert.throws(() => budget.json(largeValue), /预算/);
    assert.equal(observer.count(), 1);
  } finally {
    observer.restore();
  }
  const object = { x: 1 },
    fresh = createMockConditionBudget();
  assert.equal(fresh.json(object), '{"x":1}');
  object.x = 2;
  assert.equal(fresh.json(object), '{"x":2}');
  assert.equal(
    createMockConditionBudget().json(largeValue),
    '"' + largeValue + '"',
  );
  const path = "body." + Array(60).fill("x").join(".");
  let body = {};
  let cursor = body;
  for (let i = 0; i < 60; i++) cursor = cursor.x = {};
  const paths = createMockConditionBudget();
  assert.throws(() => {
    for (let i = 0; i < 5000; i++) paths.exists(paths.read({ body }, path));
  }, /预算/);
});

test("UTF-8 logical bytes include JSON escaping and separators while exists and unreachable rules do no unused work", async () => {
  const { createMockConditionBudget } = await import(
    "../src/mock-condition-budget.mjs"
  );
  const exact = "a".repeat(1024 * 1024 - 2);
  const limit = createMockConditionBudget();
  assert.equal(Buffer.byteLength(limit.json(exact)), 1024 * 1024);
  assert.throws(() => limit.json(0), /预算/);
  assert.throws(() => createMockConditionBudget().json(exact + "a"), /预算/);
  for (const value of [
    '雪😀\ud800\u0000\n\\"',
    ["雪", null, ["😀", "\ud800"]],
    { '雪"': [true, null, "\n"] },
  ]) {
    const b = createMockConditionBudget(),
      encoded = JSON.stringify(value);
    b.json(value);
    // Consume exactly the remaining bytes with another JSON string, including quotes.
    const remainder = 1024 * 1024 - Buffer.byteLength(encoded);
    b.json("a".repeat(remainder - 2));
    assert.throws(() => b.json(0), /预算/);
  }
  const rules = [
    {
      conditions: [{ target: "body.value", op: "exists", value: "ignored" }],
      response: { status: 201, body: "exists" },
    },
    ...definition().mockRules,
  ];
  assert.equal(
    selectMockResponse(
      { mockRules: rules.slice(0, 100) },
      { body: { value: largeValue } },
    ).body,
    "exists",
  );
  const missing = {
    conditions: [{ target: "body.missing", op: "exists", value: largeValue }],
    response: { status: 201, body: "wrong" },
  };
  assert.equal(
    selectMockResponse(
      { mockRules: [missing], examples: [{ status: 200, body: "fallback" }] },
      { body: { value: largeValue } },
    ).body,
    "fallback",
  );
});
