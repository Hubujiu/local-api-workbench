import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript } from "../src/scripts.mjs";
import { runLoad } from "../src/load-runner.mjs";

test("script info reports actual phase/request identity and immutable iteration metadata", async () => {
  const before = await runScript(
    'apt.setVar("info",apt.info); apt.setVar("pmInfo",pm.info); apt.info.iteration=99; apt.setVar("iteration",apt.info.iteration);',
    { variables: {}, request: { id: "request-id", name: "Request" } },
  );
  assert.equal(before.variables.info.eventName, "pre_script");
  assert.equal(before.variables.pmInfo.eventName, "prerequest");
  assert.equal(before.variables.info.requestId, "request-id");
  assert.equal(before.variables.pmInfo.requestName, "Request");
  assert.equal(before.variables.iteration, 0);
  assert.equal(before.variables.info.iterationCount, 1);
  const after = await runScript('apt.setVar("phase",apt.info.eventName);', {
    variables: {},
    response: { body: "{}" },
  });
  assert.equal(after.variables.phase, "test");
});

test("iteration data is independently read-only and bounded rather than a mutable environment alias", async () => {
  const result = await runScript(
    'const copy=apt.iterationData.get("item");copy.value="changed"; apt.setVar("original",apt.iterationData.get("item").value); apt.setVar("text",pm.iterationData.replaceIn("{{id}}")); apt.setVar("all",apt.iterationData.toObject()); apt.setVar("has",apt.iterationData.has("id")); apt.setVar("setter",typeof apt.iterationData.set);',
    {
      variables: { id: "environment" },
      executionContext: {
        iteration: 1,
        iterationCount: 3,
        iterationData: { id: "row", item: { value: "original" } },
      },
    },
  );
  assert.equal(result.variables.original, "original");
  assert.equal(result.variables.text, "row");
  assert.equal(result.variables.has, true);
  assert.equal(result.variables.setter, "undefined");
  assert.equal(result.variables.all.id, "row");
  await assert.rejects(
    runScript('apt.iterationData.replaceIn("{{environmentOnly}}");', {
      variables: { environmentOnly: "hidden" },
    }),
    /未定义/,
  );
});

test("concurrent CSV load scripts receive their own real iteration and row, in both phases", async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({
      index: Number(req.headers["x-iteration"]),
      row: req.headers["x-row"],
    });
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const project = {
    id: "p",
    environments: [{ id: "e", variables: { id: "saved" } }],
    globalVariables: {},
    settings: {},
  };
  const result = await runLoad(
    project,
    {
      id: "r",
      url: `http://127.0.0.1:${server.address().port}/`,
      beforeScript:
        'pm.test("count",()=>pm.expect(apt.info.iterationCount).to.equal(4)); apt.setRequestHeader("X-Iteration",apt.info.iteration);apt.setRequestHeader("X-Row",apt.iterationData.get("id"));',
      afterScript:
        'pm.test("context",()=>{pm.expect(apt.info.eventName).to.equal("test");pm.expect(pm.iterationData.get("id")).to.equal(apt.info.iteration%2===0?"a":"b");});',
    },
    { count: 4, concurrency: 2, dataCSV: "id\na\nb" },
  );
  assert.equal(result.passed, 4, JSON.stringify(result));
  assert.deepEqual(
    received.sort((a, b) => a.index - b.index),
    [
      { index: 0, row: "a" },
      { index: 1, row: "b" },
      { index: 2, row: "a" },
      { index: 3, row: "b" },
    ],
  );
  assert.equal(project.environments[0].variables.id, "saved");
});

test("execution context rejects invalid counts, unsafe keys and unbounded JSON before starting a worker", async () => {
  const { normalizeExecutionContext } = await import(
    "../src/script-context.mjs"
  );
  for (const value of [
    { iteration: 2, iterationCount: 2 },
    { iterationCount: 101 },
    { iteration: -1 },
    { iterationData: [] },
    { iterationData: JSON.parse('{"__proto__":"bad"}') },
    { iterationData: { value: "x".repeat(524289) } },
    { iterationData: { value: Infinity } },
  ])
    assert.throws(() => normalizeExecutionContext(value));
  const context = normalizeExecutionContext({
    iterationData: { value: "\u0001".repeat(60000) },
  });
  assert.equal(
    context.iterationData.value.length,
    60000,
    "JSON escaping overhead must not lower the existing64KiB CSV raw-data limit",
  );
});
