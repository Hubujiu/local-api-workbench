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
