import assert from "node:assert/strict";
import test from "node:test";
import { standardUserAcceptance } from "./helpers/installed-product-contract.mjs";
const passed = {
  requested: true,
  preflightPassed: true,
  nativeJourneyPassed: true,
  cleanupErrors: [],
};
test("only opted-in native journey plus preflight and clean shutdown qualify", () =>
  assert.equal(standardUserAcceptance(passed), true));
for (const [field, value] of [
  ["requested", false],
  ["preflightPassed", false],
  ["nativeJourneyPassed", false],
  ["cleanupErrors", ["shutdown failed"]],
  ["cleanupErrors", undefined],
  ["preflightPassed", "true"],
])
  test("no full acceptance for " + field + "=" + JSON.stringify(value), () =>
    assert.equal(standardUserAcceptance({ ...passed, [field]: value }), false),
  );
