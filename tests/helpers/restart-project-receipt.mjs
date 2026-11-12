import assert from "node:assert/strict";
// Compare the complete export, not a restored copy or a subset of its history.
export function assertRestartedProject(before, after) {
  assert.ok(before && before.id);
  assert.deepEqual(
    after,
    before,
    "Restart must preserve the original persisted project before restore or further mutation",
  );
}
