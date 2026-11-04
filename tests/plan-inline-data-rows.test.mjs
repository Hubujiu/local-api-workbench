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

test("row templates are ephemeral, take precedence only inside the group and never enter persisted scopes", async (t) => {
  const seen = [];
  const peer = createServer((req, res) => {
    seen.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const url = `http://127.0.0.1:${peer.address().port}/`;
  const plan = snapshotPlan({
    steps: [
      {
        type: "repeat",
        id: "r",
        count: 2,
        rows: [{ name: "alice" }, { name: "bob" }],
        steps: [{ id: "x", request: { url: url + "?q={{$data.name}}" } }],
      },
      { id: "tail", request: { url: url + "?q={{$data.name}}" } },
    ],
  });
  const run = await runPlan(plan, { "$data.name": "outer" }, executeRequest);
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, ["/?q=alice", "/?q=bob", "/?q=outer"]);
  assert.equal(run.variables["$data.name"], "outer");
});

test("missing or non-scalar row template fields fail rather than falling back to an unrelated variable", async () => {
  for (const row of [{}, { name: { nested: true } }]) {
    const plan = snapshotPlan({
      steps: [
        {
          type: "repeat",
          id: "r",
          count: 1,
          rows: [row],
          steps: [
            {
              id: "x",
              request: { url: "http://127.0.0.1:1/?q={{$data.name}}" },
            },
          ],
        },
      ],
    });
    let dispatched = 0;
    const run = await runPlan(
      plan,
      { "$data.name": "must-not-use" },
      async () => {
        dispatched++;
        throw Error("must not dispatch");
      },
    );
    assert.equal(run.status, "failed");
    assert.equal(dispatched, 0);
  }
});

test("row bindings reach typed path, declarative operations and protocol variable templates", async (t) => {
  const seen = [];
  const peer = createServer((req, res) => {
    seen.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  const make = (row, step) =>
    snapshotPlan({
      steps: [
        { id: "r", type: "repeat", count: 1, rows: [row], steps: [step] },
      ],
    });
  const url = `http://127.0.0.1:${peer.address().port}/items/{id}`;
  const path = {
    id: "http",
    request: {
      url,
      path: [
        {
          key: "id",
          required: true,
          enabled: true,
          schema: { type: "integer" },
          value: "{{$data.id}}",
          pathSerialization: { version: 1, style: "simple", explode: false },
        },
      ],
      before: [{ type: "set", name: "selected", value: "{{$data.name}}" }],
    },
  };
  const http = await runPlan(
    make({ id: 7, name: "row" }, path),
    { "$data.id": 999, "$data.name": "outer" },
    executeRequest,
  );
  assert.equal(http.status, "passed");
  assert.equal(http.variables.selected, "row");
  assert.deepEqual(seen, ["/items/7"]);
  for (const row of [{ name: "row" }, { id: { bad: true }, name: "row" }]) {
    const result = await runPlan(
      make(row, path),
      { "$data.id": 999 },
      executeRequest,
    );
    assert.equal(result.status, "failed");
    assert.equal(seen.length, 1);
  }
  const wire = {
    id: "tcp",
    type: "protocol",
    protocol: {
      definition: {
        type: "tcp",
        url: "127.0.0.1",
        port: 1234,
        templateMode: "variables",
      },
      message: "{{$data.name}}",
    },
  };
  for (const row of [{ name: "row" }, {}, { name: { bad: true } }]) {
    let sent;
    const result = await runPlan(
      make(row, wire),
      { "$data.name": "outer" },
      async () => {
        throw Error("not HTTP");
      },
      {
        executeProtocol: async (request) => {
          sent = request.message;
          return { status: "completed", durationMs: 1, result: { body: "ok" } };
        },
      },
    );
    assert.equal(
      result.status,
      typeof row.name === "string" ? "passed" : "failed",
    );
    assert.equal(sent, typeof row.name === "string" ? "row" : undefined);
  }
});
