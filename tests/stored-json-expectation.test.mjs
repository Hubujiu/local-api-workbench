import test from "node:test";
import assert from "node:assert/strict";
import { storedJSON } from "./helpers/stored-json.mjs";

const memoryRecord = () => ({
  id: "run-identity",
  status: "cancelled",
  planHash: "frozen-plan-hash",
  conditionResults: [{ stepId: "outer", matched: true }],
  results: [
    {
      stepId: "completed",
      status: "passed",
      repeat: { iteration: 0, occurrenceId: '["repeat","completed",0]' },
      response: {
        status: 200,
        body: "completed response",
        codecError: undefined,
        rawBodyBase64: undefined,
      },
    },
  ],
  snapshot: { steps: [{ id: "leaf", expectedStatus: undefined }] },
  retainedValues: { zero: 0, no: false, nil: null, empty: "" },
});

test("JSON storage expectation omits undefined object members without changing the captured input", () => {
  const input = memoryRecord(),
    before = structuredClone(input);
  const expected = storedJSON(input);
  assert.deepEqual(input, before);
  assert.equal(Object.hasOwn(input.results[0].response, "codecError"), true);
  assert.equal(
    Object.hasOwn(expected.results[0].response, "codecError"),
    false,
  );
  assert.equal(
    Object.hasOwn(expected.results[0].response, "rawBodyBase64"),
    false,
  );
  assert.equal(
    Object.hasOwn(expected.snapshot.steps[0], "expectedStatus"),
    false,
  );
  assert.deepEqual(expected.retainedValues, {
    zero: 0,
    no: false,
    nil: null,
    empty: "",
  });
  assert.equal(expected.id, input.id);
  assert.equal(
    expected.results[0].response.body,
    input.results[0].response.body,
  );
});

test("whole-record comparisons still detect defined evidence loss, changed identities, statuses and added undefined keys", () => {
  const input = memoryRecord();
  input.results[0].response.codecError = "defined codec failure";
  input.results[0].response.rawBodyBase64 = "AA==";
  input.snapshot.steps[0].expectedStatus = 201;
  const exact = storedJSON(input);
  assert.deepEqual(exact, storedJSON(input));
  for (const mutate of [
    (v) => {
      delete v.results[0].response.codecError;
    },
    (v) => {
      delete v.results[0].response.rawBodyBase64;
    },
    (v) => {
      delete v.snapshot.steps[0].expectedStatus;
    },
    (v) => {
      v.results[0].response.body = "lost completed response";
    },
    (v) => {
      v.results[0].response.status = 500;
    },
    (v) => {
      v.results[0].repeat.occurrenceId = "different occurrence";
    },
    (v) => {
      v.id = "different-run";
    },
    (v) => {
      v.planHash = "different-plan";
    },
    (v) => {
      v.status = "passed";
    },
    (v) => {
      v.conditionResults[0].matched = false;
    },
    (v) => {
      v.results = [];
    },
    (v) => {
      v.retainedValues.zero = null;
    },
    (v) => {
      v.retainedValues.no = true;
    },
    (v) => {
      v.unexpected = undefined;
    },
  ]) {
    const actual = structuredClone(exact);
    mutate(actual);
    assert.throws(() => assert.deepEqual(actual, storedJSON(input)), {
      code: "ERR_ASSERTION",
    });
  }
});
