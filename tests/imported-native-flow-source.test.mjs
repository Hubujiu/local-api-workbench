import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeImportedNativeFlowSource as normalize } from "../src/imported-native-flow-source.mjs";
import { snapshotPlan, restoreProject, runPlan } from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { snapshotCase } from "../src/cases.mjs";
import { Store } from "../src/runtime.mjs";
const fixture = () => ({
  version: 1,
  source: "mcp",
  sourceProjectId: "source",
  sourceFlowId: "flow",
  mcp_name: "{{never_interpolate}}",
  mcp_description: "Old AI proposal",
  mcp_environment_id: "old-env",
  steps: [
    {
      sourceStepId: "native-step",
      importedStepId: "imported-step",
      mcp_input: {
        body: {
          message: "{{never_interpolate}}",
          literal: "throw Error('not code')",
        },
      },
      mcp_deleted_body_keys: ["message", "a.b", "../outside"],
    },
  ],
});
const plan = (source = fixture()) =>
  snapshotPlan({
    id: "plan",
    steps: [
      { id: "imported-step", request: { url: "http://fixture.invalid" } },
    ],
    importedNativeFlowSource: source,
  });

test("native flow provenance is detached, bounded history rather than current step bindings", () => {
  const input = fixture(),
    frozen = normalize(input);
  input.steps[0].mcp_input.body.message = "changed";
  assert.equal(frozen.steps[0].mcp_input.body.message, "{{never_interpolate}}");
  const old = plan(frozen);
  const changed = versionPlan(old, {
    id: old.id,
    name: "edited",
    steps: [{ ...old.steps[0], id: "new-clone-step" }],
  });
  assert.deepEqual(changed.importedNativeFlowSource, frozen);
  const deleted = versionPlan(changed, { id: old.id, steps: [] });
  assert.deepEqual(deleted.importedNativeFlowSource, frozen);
  const sourceOnly = versionPlan(old, {
    ...old,
    importedNativeFlowSource: {
      ...frozen,
      mcp_name: "new historical annotation",
    },
  });
  assert.equal(
    sourceOnly.importedNativeFlowSource.mcp_name,
    "new historical annotation",
  );
  assert.deepEqual(versionPlan(sourceOnly, sourceOnly), sourceOnly);
  assert.throws(() =>
    versionPlan(old, { ...old, importedNativeFlowSource: null }),
  );
  assert.equal(
    snapshotCase({
      name: "case",
      sourceRequestId: "api",
      request: old.steps[0].request,
    }).importedNativeFlowSource,
    undefined,
  );
});

test("native flow provenance rejects getters without invoking them through snapshot, version, restore and run", async () => {
  let reads = 0;
  for (const makeBad of [
    (x) =>
      Object.defineProperty(x, "mcp_name", {
        enumerable: true,
        get() {
          reads++;
          return "x";
        },
      }),
    (x) =>
      Object.defineProperty(x.steps, "0", {
        enumerable: true,
        get() {
          reads++;
          return {};
        },
      }),
    (x) =>
      Object.defineProperty(x.steps[0].mcp_input.body, "message", {
        enumerable: true,
        get() {
          reads++;
          return "x";
        },
      }),
    (x) => Object.defineProperty(x, "hidden", { value: true }),
  ]) {
    const source = fixture();
    makeBad(source);
    const p = { steps: [], importedNativeFlowSource: source };
    assert.throws(() => normalize(source));
    assert.throws(() => snapshotPlan(p));
    assert.throws(() => versionPlan(null, p));
    assert.throws(() =>
      restoreProject({
        version: 1,
        requests: [],
        environments: [],
        plans: [p],
      }),
    );
    assert.throws(() =>
      restoreProject({
        version: 1,
        requests: [],
        environments: [],
        runs: [{ id: "run", results: [], snapshot: p }],
      }),
    );
    await assert.rejects(
      runPlan(p, {}, async () => {
        throw Error("not reached");
      }),
    );
  }
  const p = { steps: [] };
  Object.defineProperty(p, "importedNativeFlowSource", {
    enumerable: true,
    get() {
      reads++;
      return fixture();
    },
  });
  assert.throws(() => snapshotPlan(p));
  assert.equal(reads, 0);
});

test("native flow source has a closed input envelope with explicit authentication restrictions and strict JSON/UTF16/ID budgets", () => {
  for (const mutate of [
    (x) => (x.extra = true),
    (x) => delete x.sourceFlowId,
    (x) => delete x.steps[0].sourceStepId,
    (x) => (x.source = "execute"),
    (x) => (x.sourceFlowId = "../flow"),
    (x) => (x.mcp_name = "\ud800"),
    (x) => (x.mcp_description = "x".repeat(40001)),
    (x) => (x.mcp_environment_id = null),
    (x) => x.steps.push(structuredClone(x.steps[0])),
    (x) => (x.steps[0].mcp_input = []),
    (x) =>
      (x.steps[0].mcp_input.auth = {
        type: "basic",
        basic: { password: "discarded" },
      }),
    (x) =>
      (x.steps[0].mcp_input.auth = {
        type: "noauth",
        bearer: { key: "discarded" },
      }),
    (x) => (x.steps[0].mcp_input.session = "not-a-grant"),
    (x) => (x.steps[0].mcp_input.file = "/not-read"),
    (x) => (x.steps[0].mcp_input.connectionId = "not-a-grant"),
    (x) => (x.steps[0].mcp_input.query = []),
    (x) => (x.steps[0].mcp_input.body = { value: Infinity }),
    (x) => (x.steps[0].mcp_input.body = { value: undefined }),
    (x) => (x.steps[0].mcp_input.body = { value: new Date() }),
    (x) => (x.steps[0].mcp_input.body = JSON.parse('{"__proto__":{}}')),
    (x) => (x.steps[0].mcp_input.body = "x".repeat(65536)),
    (x) =>
      (x.steps[0].mcp_input.body = Array.from({ length: 1001 }, () => null)),
    (x) =>
      (x.steps[0].mcp_input.body = Array.from({ length: 6 }, () =>
        Array(1000).fill(null),
      )),
    (x) => {
      let v = {};
      x.steps[0].mcp_input.body = v;
      for (let i = 0; i < 21; i++) {
        v.nested = {};
        v = v.nested;
      }
    },
    (x) => (x.steps[0].mcp_deleted_body_keys = [false]),
    (x) => (x.steps[0].mcp_deleted_body_keys = new Array(1)),
    (x) => (x.steps[0].mcp_deleted_body_keys = ["\udc00"]),
    (x) => (x.steps[0].mcp_deleted_body_keys = Array(1001).fill("a")),
    (x) =>
      (x.steps[0].mcp_deleted_body_keys = Array(100).fill("x".repeat(1000))),
  ]) {
    const source = fixture();
    mutate(source);
    assert.throws(() => normalize(source));
  }
  for (const type of ["none", "noauth"]) {
    const x = fixture();
    x.steps[0].mcp_input.auth = { type };
    assert.deepEqual(normalize(x), x);
  }
  const empty = fixture();
  empty.steps[0].mcp_deleted_body_keys = [];
  assert.deepEqual(normalize(empty).steps[0].mcp_deleted_body_keys, []);
  delete empty.steps[0].mcp_deleted_body_keys;
  assert.equal(
    Object.hasOwn(normalize(empty).steps[0], "mcp_deleted_body_keys"),
    false,
  );
});

test("native flow source shares the existing 4MiB cumulative plan provenance budget", () => {
  const x = fixture();
  x.steps = Array.from({ length: 65 }, (_, i) => ({
    sourceStepId: `native-${i}`,
    importedStepId: `step-${i}`,
    mcp_input: { body: "x".repeat(65000) },
  }));
  assert.throws(() => normalize(x), /4MiB/);
  x.steps.pop();
  normalize(x);
  const request = {
    importedNativeTaskSource: {
      version: 1,
      before: [{ type: "customScript", enabled: 1, data: "x".repeat(65536) }],
      after: [],
    },
  };
  assert.throws(
    () => snapshotPlan({ importedNativeFlowSource: x, steps: [{ request }] }),
    /4MiB/,
  );
});

test("Store rejects invalid plan and run-snapshot provenance before any disk write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flow-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("flow source");
  p.plans = [plan()];
  await store.save(p);
  const saved = await store.get(p.id);
  for (const field of ["plans", "runs"]) {
    const bad = structuredClone(saved);
    const invalid = plan();
    invalid.importedNativeFlowSource.steps[0].mcp_input.tls = {
      rejectUnauthorized: false,
    };
    if (field === "plans") bad.plans = [invalid];
    else bad.runs = [{ id: "bad-run", results: [], snapshot: invalid }];
    await assert.rejects(store.save(bad));
    assert.deepEqual(await store.get(p.id), saved);
  }
  const restarted = await new Store(root).get(p.id);
  const restored = restoreProject(restarted);
  await store.save(restored);
  assert.deepEqual(
    (await store.get(restored.id)).plans[0].importedNativeFlowSource,
    fixture(),
  );
});

test("history-only edits change the plan hash but never affect the executed request", async () => {
  const first = plan(),
    next = versionPlan(first, {
      ...first,
      importedNativeFlowSource: { ...fixture(), mcp_name: "history-only" },
    });
  const requests = [];
  const execute = async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: "{}", duration: 1 };
  };
  const a = await runPlan(first, {}, execute),
    b = await runPlan(next, {}, execute);
  assert.notEqual(a.planHash, b.planHash);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(
    a.snapshot.importedNativeFlowSource.mcp_name,
    "{{never_interpolate}}",
  );
  assert.equal(b.snapshot.importedNativeFlowSource.mcp_name, "history-only");
});
