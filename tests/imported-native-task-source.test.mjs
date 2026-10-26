import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImportedNativeTaskSource as normalize } from "../src/imported-native-task-source.mjs";
import {
  normalizeRequest,
  snapshotPlan,
  runPlan,
  restoreProject,
} from "../src/core.mjs";
const fixture = () => ({
  version: 1,
  before: [
    {
      type: "customScript",
      enabled: 1,
      data: 'throw Error("must stay inert")',
      origin: { scope: "request", id: "api" },
      id: "script",
      name: "Script",
    },
    {
      type: "database",
      enabled: 1,
      data: {
        connectionId: "safe-id",
        query: "SELECT 1",
        isConsoleOutput: -1,
        variables: [{ name: "v", type: "environment", pattern: "$[0].v" }],
      },
    },
  ],
  after: [],
});
test("canonical task provenance survives request snapshots but never invokes scripts or database tasks", async () => {
  const source = fixture(),
    original = structuredClone(source);
  const request = normalizeRequest({
    url: "http://fixture.invalid",
    importedNativeTaskSource: source,
  });
  assert.deepEqual(request.importedNativeTaskSource, original);
  let calls = 0;
  const result = await runPlan(
    snapshotPlan({ steps: [{ request }] }),
    {},
    async () => {
      calls++;
      return { status: 200, headers: {}, body: "{}", duration: 1 };
    },
  );
  assert.equal(result.status, "passed");
  assert.equal(calls, 1);
  assert.deepEqual(source, original);
  assert.equal(result.variables.v, undefined);
});
test("task provenance rejects hidden accessors, credentials, unknown types and oversized data", () => {
  let invoked = false;
  for (const mutate of [
    (x) =>
      Object.defineProperty(x, "before", {
        get() {
          invoked = true;
          return [];
        },
      }),
    (x) =>
      Object.defineProperty(x.before, "0", {
        get() {
          invoked = true;
          return {};
        },
      }),
    (x) => {
      x.before[1].data.password = "not retained";
    },
    (x) => {
      x.before[1].data.variables[0].unknown = true;
    },
    (x) => {
      x.before[0].type = "shell";
    },
    (x) => {
      x.before[0].data = "x".repeat(65537);
    },
    (x) => {
      x.after = new Array(1);
    },
    (x) => {
      x.before[0].origin.scope = "unknown";
    },
    (x) => {
      x.before[0].origin.password = "not retained";
    },
    (x) => {
      x.extra = true;
    },
  ]) {
    const source = fixture();
    mutate(source);
    assert.throws(() => normalize(source));
    assert.throws(() => normalizeRequest({ importedNativeTaskSource: source }));
  }
  assert.equal(invoked, false);
  const request = normalizeRequest({ importedNativeTaskSource: fixture() });
  request.importedNativeTaskSource.before[1].data.password = "not retained";
  assert.throws(
    () =>
      restoreProject({
        version: 1,
        name: "bad",
        environments: [],
        requests: [request],
      }),
    /未知字段/,
  );
});

test("plan provenance expansion has a cumulative budget", () => {
  const source = fixture();
  source.before[0].data = "x".repeat(65536);
  const request = normalizeRequest({ importedNativeTaskSource: source });
  assert.throws(
    () =>
      snapshotPlan({ steps: Array.from({ length: 65 }, () => ({ request })) }),
    /4MiB/,
  );
});
test("Store rejects invalid provenance before persisting and preserves valid source over restart and restore", async (t) => {
  const { Store } = await import("../src/runtime.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"),
    path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "task-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("source");
  p.requests = [normalizeRequest({ importedNativeTaskSource: fixture() })];
  await store.save(p);
  const saved = await store.get(p.id),
    invalid = structuredClone(saved);
  invalid.requests[0].importedNativeTaskSource.before[1].data.password =
    "discard";
  await assert.rejects(store.save(invalid), /未知字段/);
  assert.deepEqual(await store.get(p.id), saved);
  const restarted = await new Store(root).get(p.id);
  const restored = restoreProject(restarted);
  await store.save(restored);
  assert.deepEqual(
    (await store.get(restored.id)).requests[0].importedNativeTaskSource,
    fixture(),
  );
});

test("snapshot and restore validate source before cloning and reject malformed case provenance", async () => {
  const { snapshotCase } = await import("../src/cases.mjs");
  let reads = 0;
  const request = normalizeRequest({ importedNativeTaskSource: fixture() });
  Object.defineProperty(request.importedNativeTaskSource.before[0], "data", {
    enumerable: true,
    get() {
      reads++;
      return "";
    },
  });
  const backup = { version: 1, requests: [], environments: [] };
  assert.throws(() => snapshotPlan({ steps: [{ request }] }), /访问器/);
  assert.throws(
    () => snapshotCase({ name: "Case", sourceRequestId: "api", request }),
    /访问器/,
  );
  assert.throws(
    () => restoreProject({ ...backup, requests: [request] }),
    /访问器/,
  );
  assert.throws(
    () => restoreProject({ ...backup, plans: [{ steps: [{ request }] }] }),
    /访问器/,
  );
  assert.throws(
    () => restoreProject({ ...backup, cases: [{ request }] }),
    /访问器/,
  );
  assert.equal(reads, 0);
  const invalid = normalizeRequest({ importedNativeTaskSource: fixture() });
  invalid.importedNativeTaskSource.before[1].data.password = "not retained";
  assert.throws(
    () => restoreProject({ ...backup, cases: [{ request: invalid }] }),
    /未知字段/,
  );
});

test("Redis canonical task source remains inert and preserves scalar shape without interpreting commands", async () => {
  const source = fixture();
  source.before[1].data.resultShape = "redis-value";
  source.before[1].data.query = '["GET","literal-key"]';
  const request = normalizeRequest({
    url: "http://fixture.invalid",
    importedNativeTaskSource: source,
  });
  assert.deepEqual(request.importedNativeTaskSource, source);
  const result = await runPlan(
    snapshotPlan({ steps: [{ request }] }),
    {},
    async () => ({ status: 200, headers: {}, body: "", duration: 1 }),
  );
  assert.equal(result.status, "passed");
  assert.deepEqual(result.variables, {});
  source.before[1].data.resultShape = "unknown";
  assert.throws(() => normalize(source));
});

test("Mongo document query provenance is preserved without starting a database task", async () => {
  const source = fixture();
  source.before[1].data.resultShape = "mongodb-document";
  source.before[1].data.query = '{"collection":"items","filter":{},"limit":1}';
  const request = normalizeRequest({
    url: "http://fixture.invalid",
    importedNativeTaskSource: source,
  });
  const plan = snapshotPlan({ steps: [{ request }] });
  assert.deepEqual(plan.steps[0].request.importedNativeTaskSource, source);
  const result = await runPlan(plan, {}, async () => ({
    status: 200,
    headers: {},
    body: "",
    duration: 1,
  }));
  assert.equal(result.status, "passed");
});

test("pickVars provenance remains closed inert data and cannot introduce hidden getters or executable paths", () => {
  const source = {
    version: 1,
    before: [],
    after: [
      {
        type: "pickVars",
        enabled: 1,
        data: {
          source: "responseJson",
          variables: [{ name: "v", expression: "$[?(@.x)]", type: "envVars" }],
        },
      },
    ],
  };
  // An inert source is not compiled, even when its historical enabled flag is 1.
  assert.deepEqual(normalize(source), source);
  let reads = 0;
  for (const alter of [
    (s) => {
      s.after[0].data.password = "not retained";
    },
    (s) => {
      s.after[0].data.source = "responseHeader";
    },
    (s) => {
      s.after[0].data.variables[0].type = "unknown";
    },
    (s) => {
      Object.defineProperty(s.after[0].data.variables[0], "expression", {
        enumerable: true,
        get() {
          reads++;
          return "$.x";
        },
      });
    },
    (s) => {
      s.after[0].data.variables = new Array(1);
    },
  ]) {
    const invalid = structuredClone(source);
    alter(invalid);
    assert.throws(() => normalize(invalid));
    assert.throws(() =>
      snapshotPlan({
        steps: [
          {
            request: {
              url: "http://fixture.invalid",
              importedNativeTaskSource: invalid,
            },
          },
        ],
      }),
    );
  }
  assert.equal(reads, 0);
});

test("assert provenance preserves disabled defaults without compiling templates or accepting hidden fields", () => {
  const source = {
    version: 1,
    before: [],
    after: [
      {
        type: "assert",
        enabled: -1,
        data: {
          type: "responseJson",
          expression: {
            path: "{{unresolved}}",
            compareValue: "{{also_unresolved}}",
          },
        },
      },
    ],
  };
  assert.deepEqual(normalize(source), source);
  let reads = 0;
  for (const alter of [
    (s) => {
      s.after[0].data.expression.compareType = "regexp";
    },
    (s) => {
      s.after[0].data.expression.secret = "not retained";
    },
    (s) => {
      s.after[0].data.type = "responseHeader";
    },
    (s) => {
      Object.defineProperty(s.after[0].data.expression, "path", {
        enumerable: true,
        get() {
          reads++;
          return "$";
        },
      });
    },
  ]) {
    const invalid = structuredClone(source);
    alter(invalid);
    assert.throws(() => normalize(invalid));
    assert.throws(() =>
      normalizeRequest({ importedNativeTaskSource: invalid }),
    );
  }
  assert.equal(reads, 0);
});

test("wait provenance retains enabled history and literal disabled scalars without scheduling or interpolation", async (t) => {
  const { Store } = await import("../src/runtime.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"),
    path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "wait-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = {
    version: 1,
    before: [
      { type: "wait", enabled: 1, data: 1000 },
      { type: "wait", enabled: -1, data: "{{WAIT_LITERAL}}" },
      {
        type: "customScript",
        enabled: 1,
        data: 'throw Error("historical tasks must never execute");',
      },
    ],
    after: [
      { type: "wait", enabled: 1, data: 1000 },
      { type: "wait", enabled: 0, data: "{{MISSING_WAIT_LITERAL}}" },
    ],
  };
  const original = structuredClone(source),
    store = new Store(root),
    project = await store.create("wait source");
  project.requests = [
    normalizeRequest({
      url: "http://fixture.invalid",
      importedNativeTaskSource: source,
    }),
  ];
  project.plans = [snapshotPlan({ steps: [{ request: project.requests[0] }] })];
  await store.save(project);
  const reloaded = await new Store(root).get(project.id),
    restored = restoreProject(reloaded);
  await store.save(restored);
  let calls = 0;
  for (const saved of [reloaded, await new Store(root).get(restored.id)]) {
    assert.equal(saved.requests[0].nativeTasks, undefined);
    assert.deepEqual(saved.requests[0].importedNativeTaskSource, original);
    const result = await runPlan(
      saved.plans[0],
      { WAIT_LITERAL: 7 },
      async () => {
        calls++;
        return {
          status: 200,
          headers: {},
          body: "no source task executes",
          duration: 1,
        };
      },
    );
    assert.equal(result.status, "passed");
    assert.deepEqual(result.variables, { WAIT_LITERAL: 7 });
    assert.equal(result.results[0].request.nativeTasks, undefined);
    assert.deepEqual(
      result.results[0].request.importedNativeTaskSource,
      original,
    );
    assert.deepEqual(
      result.snapshot.steps[0].request.importedNativeTaskSource,
      original,
    );
  }
  assert.equal(calls, 2);
  assert.deepEqual(source, original);
  // Historical source records are data, not active wait declarations: bounded
  // scalars preserve their type even if unsuitable for an enabled live timer.
  for (const enabled of [1, 0, -1])
    for (const data of [0, 1000, 1001, -1, 0.5, null, false, "{{literal}}"])
      assert.deepEqual(
        normalize({
          version: 1,
          before: [{ type: "wait", enabled, data }],
          after: [],
        }).before[0],
        { type: "wait", enabled, data },
      );
});

test("wait provenance rejects objects and hidden accessors atomically without invoking getters or coercion", async (t) => {
  const { Store } = await import("../src/runtime.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"),
    path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "wait-source-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("unchanged wait source");
  const source = {
    version: 1,
    before: [{ type: "wait", enabled: 1, data: 1 }],
    after: [],
  };
  project.requests = [normalizeRequest({ importedNativeTaskSource: source })];
  await store.save(project);
  const saved = await new Store(root).get(project.id);
  let reads = 0;
  for (const alter of [
    ...[{}, [], undefined, NaN, Infinity, "x".repeat(1001), "\ud800"].map(
      (data) => (task) => {
        task.data = data;
      },
    ),
    (task) => {
      task.data = {
        get valueOf() {
          reads++;
          return () => 1;
        },
        get toJSON() {
          reads++;
          return () => 1;
        },
      };
    },
    (task) => {
      Object.defineProperty(task, "data", {
        enumerable: true,
        get() {
          reads++;
          return 1;
        },
      });
    },
    (task) => {
      Object.defineProperty(task, "data", { enumerable: false, value: 1 });
    },
    (task) => {
      Object.defineProperty(task, "enabled", {
        enumerable: true,
        get() {
          reads++;
          return 1;
        },
      });
    },
    (task) => {
      Object.defineProperty(task, "name", {
        enumerable: true,
        get() {
          reads++;
          return "wait";
        },
      });
    },
    (task) => {
      task.secret = "not retained";
    },
  ]) {
    const invalid = structuredClone(saved);
    alter(invalid.requests[0].importedNativeTaskSource.before[0]);
    const request = invalid.requests[0];
    assert.throws(() => normalize(request.importedNativeTaskSource));
    assert.throws(() => normalizeRequest(request));
    assert.throws(() => snapshotPlan({ steps: [{ request }] }));
    assert.throws(() => restoreProject(invalid));
    await assert.rejects(store.save(invalid));
    assert.equal(reads, 0);
    assert.deepEqual(await new Store(root).get(project.id), saved);
  }
  assert.equal(reads, 0);
});
