import test from "node:test";
import assert from "node:assert/strict";
import { nativeAutomationBoundaryCases } from "./fixtures/native-automation-boundaries.mjs";
import { nativeAutomationRejectionFixture } from "./fixtures/native-automation-rejection.mjs";
test("semantic boundary matrix is synthetic, distinct and nonempty for every refusal", () => {
  const original = nativeAutomationRejectionFixture("http://127.0.0.1:1");
  const before = structuredClone(original),
    cases = nativeAutomationBoundaryCases(),
    distinct = new Set();
  assert.equal(cases.length, 11);
  assert.equal(new Set(cases.map(([label]) => label)).size, 11);
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.equal(candidate.automated_testings.length, 1, label);
    assert.equal(candidate.automated_testings[0].event_list.length, 7, label);
    distinct.add(JSON.stringify(candidate.automated_testings));
  }
  assert.equal(
    distinct.size,
    11,
    "every variant exercises a different unknown boundary",
  );
  assert.deepEqual(original, before);
});
