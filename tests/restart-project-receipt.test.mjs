import test from "node:test";
import assert from "node:assert/strict";
import { assertRestartedProject } from "./helpers/restart-project-receipt.mjs";
const before = {
  id: "original",
  name: "fixture",
  configRevision: 3,
  requests: [{ id: "r", url: "http://127.0.0.1/never-called" }],
  folders: ["group"],
  plans: [{ id: "p", steps: [{ requestId: "r" }] }],
  envs: [{ id: "e", variables: { saved: "value" } }],
  settings: { flag: true },
  runs: [{ id: "run", status: "passed" }],
  history: [{ requestId: "r" }],
};
test("original persisted project readback matches without restoring external backup", () => {
  assert.doesNotThrow(() =>
    assertRestartedProject(before, structuredClone(before)),
  );
});
for (const field of Object.keys(before))
  test(`restart readback rejects lost ${field}`, () => {
    const after = structuredClone(before);
    delete after[field];
    assert.throws(() => assertRestartedProject(before, after));
  });
test("unchanged historical receipt cannot mask request or frozen-plan loss", () => {
  for (const field of ["plans", "requests"]) {
    const after = structuredClone(before);
    after[field] = [];
    assert.throws(() => assertRestartedProject(before, after));
  }
});
