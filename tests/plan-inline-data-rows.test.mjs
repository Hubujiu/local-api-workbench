import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { planOccurrences } from "../src/plan-repeat.mjs";

const rowStep = (url) => ({
  id: "row",
  request: {
    url,
    beforeScript:
      "pm.environment.set('rowName',pm.iterationData.get('name'));pm.environment.set('rowIndex',pm.info.iteration);",
  },
});
const group = (url) => ({
  type: "repeat",
  id: "rows",
  count: 2,
  rows: [{ name: "alice" }, { name: "bob" }],
  steps: [rowStep(url)],
});

test("inline rows give each repeat occurrence a read-only script context and restore the outer context", async (t) => {
  const seen = [];
  const peer = createServer((req, res) => {
    seen.push(req.headers["x-row"]);
    res.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const url = `http://127.0.0.1:${peer.address().port}/`;
  const source = {
    steps: [
      group(url),
      {
        id: "tail",
        request: {
          url,
          beforeScript:
            "pm.environment.set('tailData',pm.iterationData.get('outer'));pm.environment.set('tailIndex',pm.info.iteration);",
        },
      },
    ],
  };
  source.steps[0].steps[0].request.afterScript =
    "pm.test('row',()=>pm.expect(pm.environment.get('rowName')).to.equal(pm.iterationData.get('name')));";
  source.steps[0].steps[0].request.headers = [
    { key: "x-row", value: "{{rowName}}" },
  ];
  const plan = snapshotPlan(source);
  source.steps[0].rows[0].name = "mutated";
  const outer = {
    iteration: 3,
    iterationCount: 5,
    iterationData: { outer: "outside" },
  };
  const run = await runPlan(plan, {}, executeRequest, {
    executionContext: outer,
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, ["alice", "bob", undefined]);
  assert.equal(run.variables.tailData, "outside");
  assert.equal(run.variables.tailIndex, 3);
  assert.equal(run.snapshot.steps[0].rows[0].name, "alice");
  assert.deepEqual(
    run.results.slice(0, 2).map((x) => JSON.parse(x.repeat.occurrenceId)),
    [
      ["rows", "row", 0],
      ["rows", "row", 1],
    ],
  );
  assert(!JSON.stringify(run.results.map((x) => x.repeat)).includes("alice"));
});

test("rows reject malformed, mismatched, non-JSON and nested data before execution", () => {
  const make = (rows, count = 2) => ({
    steps: [{ ...group("http://127.0.0.1:1"), rows, count }],
  });
  for (const plan of [
    make([{ name: "one" }]),
    make([{ name: "one" }, { x: undefined }]),
    make([{ name: "one" }, ["not object"]]),
    make([{ name: "x".repeat(512 * 1024) }, {}]),
  ])
    assert.throws(() => snapshotPlan(plan));
  assert.throws(() => snapshotPlan(make([{ value: -0 }, {}])), /严格 JSON/);
  const arrayWithProperty = ["x"];
  arrayWithProperty.label = "must-not-disappear";
  assert.throws(
    () => snapshotPlan(make([{ value: arrayWithProperty }, {}])),
    /额外属性/,
  );
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => snapshotPlan(make([{ value: sparse }, {}])), /稠密/);
  const largeExpanded = {
    steps: [
      {
        type: "repeat",
        id: "outer",
        count: 1,
        rows: [{ value: "x".repeat(500000) }],
        steps: [
          {
            type: "repeat",
            id: "inner-repeat",
            count: 10,
            steps: [rowStep("http://127.0.0.1:1")],
          },
        ],
      },
    ],
  };
  assert.throws(() => snapshotPlan(largeExpanded), /逻辑展开配置/);
  const nested = make([{ name: "one" }, { name: "two" }]);
  nested.steps[0].steps = [{ ...group("http://127.0.0.1:1"), id: "inner" }];
  assert.throws(() => snapshotPlan(nested), /嵌套数据行/);
});

test("fixed repeat occurrence identities stay unchanged", () => {
  const plan = snapshotPlan({
    steps: [
      {
        type: "repeat",
        id: "r",
        count: 2,
        steps: [{ id: "x", request: { url: "http://example.test" } }],
      },
    ],
  });
  assert.deepEqual(
    planOccurrences(plan.steps).map((x) => x.repeat.occurrenceId),
    ['["r","x",0]', '["r","x",1]'],
  );
});

test("staged load keeps data rows isolated per iteration and out of progress reports", async (t) => {
  const { prepareStagedLoad, runStagedLoad } = await import(
    "../src/staged-load-plan.mjs"
  );
  const { Store } = await import("../src/runtime.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const seen = [];
  const peer = createServer((req, res) => {
    seen.push(req.headers["x-row"]);
    res.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "staged-rows-"));
  const store = new Store(root);
  await store.init();
  const project = await store.create("rows");
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const g = group(`http://127.0.0.1:${peer.address().port}/`);
  g.rows = [{ name: "unique-alice" }, { name: "unique-bob" }];
  g.steps[0].request.headers = [{ key: "x-row", value: "{{rowName}}" }];
  const prepared = prepareStagedLoad(
    project,
    { steps: [g] },
    {
      initialVUs: 2,
      stages: [{ durationSeconds: 2, targetVUs: 2 }],
      maxIterations: 2,
    },
  );
  const reports = [];
  const result = await runStagedLoad(project, prepared, {
    onProgress: (report) => reports.push(report),
  });
  assert.equal(result.failed, 0);
  assert.equal(result.mainRequests, 4);
  assert.equal(seen.filter((x) => x === "unique-alice").length, 2);
  assert.equal(seen.filter((x) => x === "unique-bob").length, 2);
  assert(!JSON.stringify(reports).includes("unique-alice"));
  assert(!JSON.stringify(reports).includes("unique-bob"));
  assert.equal(project.environments[0].variables.rowName, undefined);
});
