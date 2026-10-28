import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan, restoreProject } from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";

// Disk-only fixture: no HTTP, scripts, VM, native database, or imported sample.
test("redirect policy persists across restart and backup restore, while malformed writes remain atomic", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "redirect-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const p = await store.create("Redirect storage");
  const definition = {
    id: "api-one",
    name: "Only definition",
    url: "http://127.0.0.1:1/never",
    redirect: { mode: "same-origin", maxHops: 2 },
  };
  p.requests.push(definition);
  p.cases = [
    snapshotCase({
      name: "Frozen",
      sourceRequestId: definition.id,
      request: definition,
    }),
  ];
  p.plans = [
    snapshotPlan({ name: "Frozen plan", steps: [{ request: definition }] }),
  ];
  await store.save(p);
  const reopened = await new Store(root).get(p.id);
  assert.deepEqual(reopened.requests[0].redirect, definition.redirect);
  assert.deepEqual(reopened.cases[0].request.redirect, definition.redirect);
  assert.deepEqual(
    reopened.plans[0].steps[0].request.redirect,
    definition.redirect,
  );
  const before = JSON.stringify(reopened);
  const invalid = await store.get(p.id);
  invalid.requests[0].redirect = { mode: "same-origin", maxHops: 99 };
  await assert.rejects(store.save(invalid), /redirect/);
  assert.equal(JSON.stringify(await new Store(root).get(p.id)), before);
  const restored = restoreProject(JSON.parse(JSON.stringify(reopened)));
  await store.save(restored);
  const restoredRead = await new Store(root).get(restored.id);
  assert.notEqual(restoredRead.id, reopened.id);
  assert.deepEqual(restoredRead.requests[0].redirect, definition.redirect);
  assert.deepEqual(restoredRead.cases[0].request.redirect, definition.redirect);
  assert.deepEqual(
    restoredRead.plans[0].steps[0].request.redirect,
    definition.redirect,
  );
});
