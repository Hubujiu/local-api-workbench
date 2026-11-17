import { applyStepEdits } from "../public/step-editor.js";
import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { snapshotInterfaceForPlan } from "../public/plan-snapshots.js";

test("Apipost 8 dialect uses callable response JSON and request-local variables", async () => {
  const result = await runScript(
    `apt.variables.set('private', 'local'); apt.setVar('value', apt.response.json().value); apt.setVar('header', apt.response.headers.get('x-test')); apt.setVar('phase', apt.info.eventName); apt.test('response', () => apt.response.to.have.status(200));`,
    {
      request: { scriptDialect: "apipost8" },
      variables: {},
      response: {
        status: 200,
        body: '{"value":42}',
        headers: { "x-test": "yes" },
      },
    },
  );
  assert.equal(result.variables.value, 42);
  assert.equal(result.variables.header, "yes");
  assert.equal(result.variables.private, undefined);
  assert.equal(result.localVariables.private, "local");
  assert.equal(result.variables.phase, "test");
  assert.equal(result.tests[0].passed, true);
});

test("legacy dialect remains default and keeps property JSON and environment variable scope", async () => {
  const result = await runScript(
    `apt.variables.set('saved', 'value'); apt.setVar('value', apt.response.json.value);`,
    { variables: {}, request: {}, response: { body: '{"value":42}' } },
  );
  assert.equal(result.variables.saved, "value");
  assert.equal(result.variables.value, 42);
  assert.equal(result.localVariables.saved, undefined);
});

test("dialect is validated and frozen in request snapshots", () => {
  assert.equal(normalizeRequest({}).scriptDialect, "legacy");
  const request = normalizeRequest({ scriptDialect: "apipost8" });
  const snapshot = snapshotInterfaceForPlan(request);
  request.scriptDialect = "legacy";
  assert.equal(snapshot.scriptDialect, "apipost8");
  const step = { name: "step", request: snapshot };
  assert.equal(
    applyStepEdits(step, { name: "step", scriptDialect: "legacy" }, {}).request
      .scriptDialect,
    "legacy",
  );
  assert.equal(step.request.scriptDialect, "apipost8");
  assert.throws(
    () => applyStepEdits(step, { name: "step", scriptDialect: "unknown" }, {}),
    /脚本兼容模式/,
  );
  for (const value of ["unknown", null, 1])
    assert.throws(
      () => normalizeRequest({ scriptDialect: value }),
      /脚本兼容模式/,
    );
  assert.throws(
    () => runScript("", { request: { scriptDialect: "unknown" } }),
    /脚本兼容模式/,
  );
});

test("modern pre/post stages preserve local variables without environment persistence", async () => {
  const before = await runScript(
    `apt.variables.set('token','ephemeral'); apt.setVar('phase',apt.info.eventName); apt.setRequestHeader('X-Token', apt.variables.get('token'));`,
    { request: { scriptDialect: "apipost8" }, variables: {} },
  );
  assert.equal(before.variables.phase, "prerequest");
  assert.equal(before.variables.token, undefined);
  assert.equal(before.request.headers[0].value, "ephemeral");
  const after = await runScript(
    `apt.test('local',()=>apt.expect(apt.variables.get('token')).to.equal('ephemeral'));`,
    { ...before, response: { status: 200, body: "{}" } },
  );
  assert.equal(after.tests[0].passed, true);
  assert.equal(after.variables.token, undefined);
});
