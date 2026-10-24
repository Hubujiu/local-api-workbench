import test from "node:test";
import assert from "node:assert/strict";
import { snapshotInterfaceForPlan } from "../public/plan-snapshots.js";
test("creating a plan step does not inherit interface-page scripts", () => {
  const source = {
    url: "http://localhost",
    before: [{ type: "set", name: "a", value: 1 }],
    after: [],
    beforeScript: 'throw Error("must not run")',
    afterScript: 'console.log("interface")',
    headers: [{ key: "x", value: "a" }],
  };
  const snapshot = snapshotInterfaceForPlan(source);
  assert.deepEqual(snapshot.before, []);
  assert.equal(snapshot.beforeScript, "");
  assert.equal(snapshot.afterScript, "");
  source.headers[0].value = "changed";
  assert.equal(snapshot.headers[0].value, "a");
});
