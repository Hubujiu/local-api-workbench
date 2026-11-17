import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runScript } from "../src/scripts.mjs";
import { runLoad } from "../src/load-runner.mjs";

test("script environment metadata and collections use selected environment rather than merged variables", async () => {
  const result = await runScript(
    `apt.setVar('name',apt.environment.getName());apt.setVar('id',pm.environment.id);apt.setVar('variableName',pm.variables.getName());apt.setVar('collection',pm.variables.getCollection());const copy=apt.environment.getCollection();copy.nested.value='changed';apt.setVar('unchanged',apt.environment.get('nested').value);pm.environment.name='forged';apt.setVar('stable',pm.environment.getName());`,
    {
      variables: {},
      scopes: {
        globals: { globalOnly: 1 },
        environment: { nested: { value: "original" } },
        runtime: { localOnly: 2 },
      },
      executionContext: { environment: { id: "chosen", name: "Staging" } },
    },
  );
  assert.equal(result.variables.name, "Staging");
  assert.equal(result.variables.id, "chosen");
  assert.equal(result.variables.variableName, "Staging");
  assert.deepEqual(result.variables.collection, {
    nested: { value: "original" },
  });
  assert.equal(result.variables.unchanged, "original");
  assert.equal(result.variables.stable, "Staging");
});

test("real load iterations retain chosen environment identity independently of CSV values", async (t) => {
  const names = [];
  const server = http.createServer((req, res) => {
    names.push(req.headers["x-environment"]);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const project = {
    id: "p",
    settings: {},
    globalVariables: {},
    environments: [
      { id: "a", name: "Production", variables: {} },
      { id: "b", name: "Staging", variables: {} },
    ],
  };
  const result = await runLoad(
    project,
    {
      url: `http://127.0.0.1:${server.address().port}/`,
      beforeScript: `apt.setRequestHeader('X-Environment',apt.environment.getName());`,
      afterScript: `pm.test('identity',()=>pm.expect(pm.environment.id).to.equal('b'));`,
    },
    {
      environmentId: "b",
      count: 2,
      concurrency: 2,
      dataCSV: "name\nspoofed\nother",
    },
  );
  assert.equal(result.passed, 2, JSON.stringify(result));
  assert.deepEqual(names, ["Staging", "Staging"]);
});

test("environment metadata is bounded and absent contexts are not fabricated", async () => {
  for (const environment of [
    null,
    [],
    { id: "x" },
    { id: "x", name: 2 },
    { id: "x", name: "x".repeat(201) },
    { id: "x", name: "ok", secret: "not allowed" },
  ]) {
    assert.throws(
      () => runScript("", { executionContext: { environment } }),
      /脚本环境标识/,
    );
  }
  const result = await runScript(
    `apt.setVar('missing',pm.environment.getName()===undefined && pm.environment.id===undefined);apt.setVar('collection',pm.environment.getCollection());`,
    { variables: { value: 1 } },
  );
  assert.equal(result.variables.missing, true);
  assert.deepEqual(result.variables.collection, { value: 1 });
});
