import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { materializeLivePlan } from "../src/live-plan-materialize.mjs";

const source = (id, url) => ({ id, name: id, url, method: "GET" });
const project = () => ({
  id: "project",
  requests: [source("api", "http://example.test/v2")],
  environments: [{ id: "env", name: "env", variables: {} }],
  settings: {},
});
const plan = () =>
  snapshotPlan({
    id: "p",
    steps: [
      {
        id: "step",
        liveRequestId: "api",
        request: {
          ...source("api", "http://example.test/v1"),
          beforeScript: "pm.environment.set('planTask', 'ran');",
        },
      },
    ],
  });

test("live references are persisted but cannot execute without explicit materialization", async () => {
  const definition = plan();
  assert.equal(definition.steps[0].liveRequestId, "api");
  let calls = 0;
  await assert.rejects(
    () =>
      runPlan(definition, {}, async () => {
        calls++;
      }),
    /冻结引用/,
  );
  assert.equal(calls, 0);
  const result = materializeLivePlan(project(), definition);
  assert.equal(result.plan.steps[0].liveRequestId, undefined);
  assert.equal(result.plan.steps[0].request.url, "http://example.test/v2");
  assert.equal(
    result.plan.steps[0].request.beforeScript,
    "pm.environment.set('planTask', 'ran');",
  );
  assert.deepEqual(result.bindings, [{ stepId: "step", requestId: "api" }]);
  assert.equal(definition.steps[0].request.url, "http://example.test/v1");
});

test("a missing, deleted, duplicate or unsupported reference fails before any plan can run", () => {
  for (const requests of [
    [],
    [{ ...source("api", "http://example.test"), deletedAt: "now" }],
    [source("api", "http://a.test"), source("api", "http://b.test")],
    [
      source("api", "http://a.test"),
      { ...source("api", "http://b.test"), deletedAt: "now" },
    ],
    [
      {
        ...source("api", "http://example.test"),
        postmanCollectionId: "collection",
      },
    ],
  ]) {
    const p = project();
    p.requests = requests;
    assert.throws(() => materializeLivePlan(p, plan()));
  }
});

test("API tasks do not leak into the plan's frozen task definition", () => {
  const p = project();
  Object.assign(p.requests[0], {
    beforeScript: "throw Error('must not execute');",
    assertions: [{ target: "status", op: "eq", value: 500 }],
  });
  const materialized = materializeLivePlan(p, plan()).plan;
  assert.equal(
    materialized.steps[0].request.beforeScript,
    "pm.environment.set('planTask', 'ran');",
  );
  assert.deepEqual(materialized.steps[0].request.assertions, []);
});

test("legacy frozen plans remain byte-for-byte unchanged", () => {
  const frozen = snapshotPlan({
    id: "old",
    steps: [{ id: "step", request: source("api", "http://example.test/v1") }],
  });
  const before = JSON.stringify(frozen);
  const prepared = materializeLivePlan(project(), frozen);
  assert.equal(prepared.plan, frozen);
  assert.equal(JSON.stringify(prepared.plan), before);
  assert.deepEqual(prepared.bindings, []);
});

test("manual import graph treats live request IDs as typed API dependencies", async () => {
  const { manualImportCanonicalFixture } = await import(
    "./fixtures/manual-import-source.mjs"
  );
  const { buildManualImportSourceGraph } = await import(
    "../src/manual-import-source.mjs"
  );
  const p = manualImportCanonicalFixture();
  p.plans[0].steps[0].liveRequestId = "generated-api";
  const graph = buildManualImportSourceGraph(p, {
    nonce: Buffer.alloc(32, 7).toString("base64url"),
    issuedAt: 1700000000000,
    expiresAt: 1700000060000,
  });
  const planNode = graph.nodes.find((node) => node.kind === "plan-bundle");
  const apiNode = graph.nodes.find((node) => node.kind === "api");
  assert(
    apiNode,
    JSON.stringify(graph.nodes.filter((node) => node.kind === "api")),
  );
  assert(planNode.dependencies.includes(apiNode.key));
});

test("live requests retain the plan's SDK script mode without reusing stale URL runtime", async () => {
  const p = project();
  const definition = snapshotPlan({
    steps: [
      {
        id: "s",
        liveRequestId: "api",
        request: {
          id: "api",
          url: "http://example.test/old",
          scriptURLMode: "sdk",
          beforeScript: "pm.request.url.query.add({key:'from',value:'plan'});",
        },
      },
    ],
  });
  const materialized = materializeLivePlan(p, definition).plan;
  assert.equal(materialized.steps[0].request.scriptURLMode, "sdk");
  let url;
  const run = await runPlan(materialized, {}, async (request) => {
    url = request.url;
    return { status: 200, body: "ok", headers: {}, duration: 1 };
  });
  assert.equal(run.status, "passed");
  assert.equal(url, "http://example.test/v2?from=plan");
});

test("live materialization rejects a plan task that depends on collection scope", () => {
  const definition = snapshotPlan({
    steps: [
      {
        id: "s",
        liveRequestId: "api",
        request: {
          id: "old",
          url: "http://example.test/old",
          postmanCollectionId: "collection",
          beforeScript: "pm.collectionVariables.get('token');",
        },
      },
    ],
  });
  assert.throws(() => materializeLivePlan(project(), definition), /collection/);
});

test("restore rejects live reference accessors and hidden descriptors before cloning", () => {
  for (const kind of ["getter", "hidden"]) {
    const step = { id: "step", request: source("api", "http://example.test") };
    let calls = 0;
    Object.defineProperty(
      step,
      "liveRequestId",
      kind === "getter"
        ? {
            enumerable: true,
            get() {
              calls++;
              return "api";
            },
          }
        : { value: "api" },
    );
    const backup = {
      version: 1,
      requests: [],
      environments: [],
      plans: [{ id: "p", steps: [step] }],
    };
    assert.throws(() => restoreProject(backup), /实时计划引用/);
    assert.equal(calls, 0);
  }
});

test("live expansion is bounded before accumulating repeated large request snapshots", () => {
  const p = project();
  p.requests[0].body = "x".repeat(64 * 1024);
  const definition = snapshotPlan({
    steps: Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      liveRequestId: "api",
      request: source("api", "http://example.test"),
    })),
  });
  assert.throws(() => materializeLivePlan(p, definition), /超过 4 MiB/);
});

test("budget counts UTF-8 and frozen siblings, and does not change oversized legacy plans", () => {
  const p = project();
  p.requests[0].body = "😀".repeat(16384);
  const repeated = snapshotPlan({
    steps: Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      liveRequestId: "api",
      request: source("api", "http://example.test"),
    })),
  });
  assert.throws(() => materializeLivePlan(p, repeated), /4 MiB/);
  const mixed = plan();
  mixed.steps.push({
    id: "frozen",
    request: {
      ...source("f", "http://example.test"),
      body: "x".repeat(4 * 1024 * 1024),
    },
  });
  assert.throws(() => materializeLivePlan(project(), mixed), /4 MiB/);
  const legacy = snapshotPlan({
    steps: [
      {
        id: "old",
        request: {
          ...source("f", "http://example.test"),
          body: "x".repeat(5 * 1024 * 1024),
        },
      },
    ],
  });
  assert.equal(materializeLivePlan(project(), legacy).plan, legacy);
});

function boundFixture() {
  const p = project(),
    definition = plan();
  p.postmanCollections = {
    version: 1,
    items: ["a", "b"].map((id) => ({
      id,
      name: id,
      variables: {},
      definitions: {},
    })),
  };
  p.requests[0].postmanCollectionId = "a";
  definition.steps[0].request.postmanCollectionId = "a";
  return { p, definition };
}

test("live collections require exact unchanged identity including disabled nested leaves", () => {
  for (const [sourceId, templateId] of [
    ["a", "b"],
    ["a", undefined],
    [undefined, "a"],
    [null, null],
    ["", ""],
    ["missing", "missing"],
  ]) {
    const { p, definition } = boundFixture();
    p.requests[0].postmanCollectionId = sourceId;
    definition.steps[0].request.postmanCollectionId = templateId;
    definition.steps = [
      {
        id: "group",
        type: "repeat",
        count: 1,
        enabled: false,
        steps: definition.steps,
      },
    ];
    assert.throws(() => materializeLivePlan(p, definition), /collection/);
  }
});

test("live collections validate frozen disabled siblings and malformed registries", () => {
  for (const corrupt of [
    (p, plan) =>
      plan.steps.push({
        id: "disabled",
        enabled: false,
        request: { url: "http://example.test", postmanCollectionId: "missing" },
      }),
    (p) =>
      p.postmanCollections.items.push(
        structuredClone(p.postmanCollections.items[0]),
      ),
    (p) => (p.postmanCollections.items[0].variables.bad = 1),
    (p) => (p.postmanCollections.items = []),
  ]) {
    const { p, definition } = boundFixture();
    corrupt(p, definition);
    assert.throws(() => materializeLivePlan(p, definition), /collection/);
  }
});

test("matching collections refresh HTTP configuration but preserve template task ownership and detached output", () => {
  const { p, definition } = boundFixture();
  Object.assign(p.requests[0], {
    method: "POST",
    body: "current",
    headers: [{ key: "x-current", value: "yes" }],
    beforeScript: 'throw Error("source");',
  });
  const original = structuredClone({ p, definition });
  const result = materializeLivePlan(p, definition);
  const request = result.plan.steps[0].request;
  assert.equal(request.postmanCollectionId, "a");
  assert.equal(request.method, "POST");
  assert.equal(request.body, "current");
  assert.equal(request.headers[0].value, "yes");
  assert.equal(request.beforeScript, definition.steps[0].request.beforeScript);
  p.requests[0].headers[0].value = "changed";
  definition.steps[0].request.beforeScript = "changed";
  assert.equal(request.headers[0].value, "yes");
  assert.equal(
    request.beforeScript,
    original.definition.steps[0].request.beforeScript,
  );
});
