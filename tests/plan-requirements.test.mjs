import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { analyzePlanRequirements } from "../src/plan-requirements.mjs";

const http = (id, request = {}) => ({
  id,
  request: { url: "https://example.invalid", ...request },
});
const rows = (steps, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const database = (connectionId, extra = {}) => ({
  type: "database",
  connectionId,
  ...extra,
});
const nativeDatabase = (connectionId, enabled = 1) => ({
  type: "database",
  enabled,
  data: {
    connectionId,
    query: "SELECT 1",
    variables: [],
    isConsoleOutput: 0,
  },
});
const analyze = (steps) =>
  analyzePlanRequirements({ steps }, { allowRuntimeRows: true });

test("requirements include false IF and potential runtime rows without reading a source", () => {
  const result = analyze([
    rows([
      {
        id: "false",
        type: "if",
        condition: { op: "eq", left: { literal: 1 }, right: { literal: 2 } },
        steps: [
          http("db", { before: [database("first"), database("first")] }),
          http("second", { after: [database("second")] }),
        ],
      },
    ]),
  ]);
  assert.deepEqual(result, {
    executorTypes: ["http", "database"],
    databaseConnectionIds: ["first", "second"],
    potentialSteps: 6,
    activeLeafCount: 2,
  });
  assert.throws(
    () => analyzePlanRequirements({ steps: [rows([http("a")])] }),
    /尚未启用/,
  );
});

test("disabled ancestry and disabled operations cannot add requirements", () => {
  const result = analyze([
    rows([http("hidden", { before: [database("hidden")] })], {
      enabled: false,
    }),
    http("visible", { before: [database("off", { enabled: false })] }),
    { ...http("off", { before: [database("off-leaf")] }), enabled: false },
  ]);
  assert.deepEqual(result, {
    executorTypes: ["http"],
    databaseConnectionIds: [],
    potentialSteps: 1,
    activeLeafCount: 1,
  });
});

test("native database tasks reuse canonical parsing and exact enabled semantics", () => {
  const request = {
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [nativeDatabase("first"), nativeDatabase("off", 0)],
      after: [nativeDatabase("first"), nativeDatabase("minus", -1)],
    },
  };
  assert.deepEqual(
    analyze([rows([http("native", request)])]).databaseConnectionIds,
    ["first"],
  );
  assert.throws(
    () => analyze([http("mixed", { ...request, beforeScript: "1" })]),
    /不能与旧操作/,
  );
  const invalid = structuredClone(request);
  invalid.nativeTasks.before[0].data.query = "{{sql}}";
  assert.throws(() => analyze([http("bad", invalid)]), /静态只读SQL/);
});

test("scripts are opaque and requirements do not claim to enumerate their DB access", () => {
  const result = analyze([
    http("script", {
      beforeScript: 'throw new Error("must not run"); apt.db.query("hidden")',
    }),
    http("native-script", {
      inheritSharedScripts: false,
      nativeTasks: {
        version: 1,
        before: [
          {
            type: "customScript",
            enabled: 1,
            data: 'apt.db.query("also-hidden")',
          },
        ],
        after: [],
      },
    }),
  ]);
  assert.deepEqual(result.executorTypes, ["http"]);
  assert.deepEqual(result.databaseConnectionIds, []);
});

test("executor types are unique and map to the existing protocol executor families", () => {
  const result = analyze([
    http("http"),
    { id: "grpc", type: "grpc" },
    { id: "socket", type: "socketio" },
    { id: "wire", type: "protocol" },
    { id: "wire2", type: "protocol" },
  ]);
  assert.deepEqual(result.executorTypes, [
    "http",
    "grpc",
    "socketio",
    "protocol",
  ]);
  assert.equal(result.potentialSteps, 5);
  assert.equal(result.activeLeafCount, 5);
});

test("requirements are immutable minimal metadata and do not freeze or mutate input", () => {
  const plan = { steps: [http("one", { before: [database("db")] })] };
  const before = structuredClone(plan);
  const result = analyzePlanRequirements(plan);
  assert.deepEqual(plan, before);
  assert.equal(Object.isFrozen(plan), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.executorTypes), true);
  assert.equal(Object.isFrozen(result.databaseConnectionIds), true);
  assert.throws(() => result.databaseConnectionIds.push("other"), TypeError);
  plan.steps[0].request.before[0].connectionId = "changed";
  assert.deepEqual(result.databaseConnectionIds, ["db"]);
  assert.equal(Object.hasOwn(result, "leaves"), false);
});

test("unknown types and data hooks fail closed before any inspection", () => {
  assert.throws(() => analyze([{ id: "bad", type: "other" }]), /未知/);
  let called = 0;
  const request = {
    get before() {
      called++;
      return [];
    },
    url: "https://example.invalid",
  };
  assert.throws(() => analyze([rows([{ id: "getter", request }])]), /访问器/);
  assert.equal(called, 0);
});

test("potentialSteps multiplies maxRows and fixed counts but never counts controls", () => {
  const result = analyze([
    {
      id: "outer",
      type: "repeat",
      count: 2,
      intervalMs: 5,
      untilCondition: { op: "eq", left: { literal: 1 }, right: { literal: 2 } },
      steps: [rows([http("a"), http("b")])],
    },
  ]);
  assert.equal(result.potentialSteps, 12);
  assert.equal(result.activeLeafCount, 2);
  assert.deepEqual(result.executorTypes, ["http"]);
});

test("analysis has no runtime input and cannot skip declarations for an empty source", () => {
  const plan = {
    steps: [rows([http("a", { before: [database("literal {{id}}")] })])],
  };
  let reads = 0;
  const result = analyzePlanRequirements(plan, {
    allowRuntimeRows: true,
    get runtime() {
      reads++;
      return { items: [] };
    },
  });
  assert.equal(reads, 0);
  assert.equal(result.potentialSteps, 3);
  assert.deepEqual(result.databaseConnectionIds, ["literal {{id}}"]);
});

test("legacy linear unused metadata keeps snapshot and run compatibility", async () => {
  let schema = { type: "string" };
  for (let i = 0; i < 34; i++) schema = { properties: { child: schema } };
  for (const metadata of [schema, new Date("2026-01-01T00:00:00Z"), NaN]) {
    const plan = {
      steps: [
        http("legacy", {
          unusedMetadata: metadata,
          extract: [],
          assertions: [],
        }),
      ],
    };
    const snapshot = snapshotPlan(plan);
    assert.equal(snapshot.steps.length, 1);
    let requests = 0;
    const result = await runPlan(plan, {}, async () => {
      requests++;
      return { status: 200, headers: {}, body: "{}", duration: 0 };
    });
    assert.equal(result.status, "passed");
    assert.equal(requests, 1);
    for (const allowRuntimeRows of [false, true]) {
      const requirements = analyzePlanRequirements(plan, { allowRuntimeRows });
      assert.equal(requirements.potentialSteps, 1);
      assert.deepEqual(requirements.executorTypes, ["http"]);
    }
    // The compatibility branch must never weaken control-graph admission.
    assert.throws(() => analyze([rows(plan.steps)]));
    assert.throws(() => analyze([rows(plan.steps, { enabled: false })]));
  }
});

for (const controlGraph of [false, true])
  test(`read dependency hooks never execute (${controlGraph ? "runtime graph" : "linear"})`, () => {
    const exercise = (make) => {
      let calls = 0;
      const hit = () => ++calls;
      const step = make(hit);
      assert.throws(() => analyze(controlGraph ? [rows([step])] : [step]));
      assert.equal(calls, 0);
    };
    exercise((hit) => ({
      ...http("enabled"),
      get enabled() {
        hit();
        return false;
      },
    }));
    exercise((hit) => ({
      id: "request",
      get request() {
        hit();
        return { url: "https://example.invalid" };
      },
    }));
    exercise((hit) => ({
      id: "before",
      request: {
        url: "https://example.invalid",
        get before() {
          return hit() === 1 ? [] : [database("hidden")];
        },
      },
    }));
    exercise((hit) =>
      http("proxy", {
        before: [
          new Proxy(database("hidden"), {
            get: hit,
            ownKeys: hit,
            getOwnPropertyDescriptor: hit,
            getPrototypeOf: hit,
          }),
        ],
      }),
    );
    exercise((hit) => {
      const operations = [];
      Object.defineProperty(operations, "0", {
        enumerable: true,
        get() {
          hit();
          return database("hidden");
        },
      });
      return http("slot", { before: operations });
    });
    exercise((hit) =>
      http("connection", {
        before: [
          {
            type: "database",
            get connectionId() {
              hit();
              return "hidden";
            },
          },
        ],
      }),
    );
    exercise((hit) =>
      http("native", {
        inheritSharedScripts: false,
        nativeTasks: {
          version: 1,
          before: [nativeDatabase("db")],
          after: new Proxy([], { get: hit, ownKeys: hit, getPrototypeOf: hit }),
        },
      }),
    );
    exercise((hit) => ({
      id: "shared",
      request: {
        url: "https://example.invalid",
        inheritSharedScripts: false,
        nativeTasks: { version: 1, before: [], after: [] },
        get sharedBeforeScripts() {
          hit();
          return [];
        },
      },
    }));
  });

test("linear analysis does not inspect unrelated legacy metadata hooks", () => {
  let calls = 0;
  const step = http("legacy");
  Object.defineProperty(step.request, "unusedMetadata", {
    enumerable: true,
    get() {
      calls++;
      return new Date();
    },
  });
  assert.equal(analyze([step]).potentialSteps, 1);
  assert.equal(calls, 0);
});

test("native parser cannot encounter inherited hooks on an empty object", () => {
  let calls = 0;
  const nativeTasks = Object.create({
    get version() {
      calls++;
      return 1;
    },
  });
  assert.throws(() =>
    analyze([http("inherited", { inheritSharedScripts: false, nativeTasks })]),
  );
  assert.equal(calls, 0);
});
