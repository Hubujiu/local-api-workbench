import test from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from '../src/scripts.mjs';
test('script can set variables and record deterministic assertions', async () => {
  const result = await runScript('apt.setVar("token", pm.response.json().token); pm.test("status", () => pm.expect(pm.response.code).to.equal(200)); console.log("done");', { variables: {}, response: { status: 200, body: '{"token":"abc"}' } });
  assert.equal(result.variables.token, 'abc');
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.logs[0], 'done');
});
test('script VM does not expose process, filesystem or network', async () => {
  const result = await runScript('apt.setVar("types", [typeof process,typeof require,typeof fetch]);', { variables: {} });
  assert.deepEqual(result.variables.types, ['undefined', 'undefined', 'undefined']);
});
test('infinite scripts are interrupted without hanging the runner', async () => {
  await assert.rejects(runScript('while(true) {}', { variables: {} }), /interrupt|超时|终止/i);
});
