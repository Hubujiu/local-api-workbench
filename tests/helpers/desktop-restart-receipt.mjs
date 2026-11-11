import assert from "node:assert/strict";
// A killed/uncertain process must never satisfy the successful restart boundary.
export function assertCleanDesktopExit({
  code,
  signal,
  closed,
  saved,
  forced,
}) {
  assert.equal(forced, false);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(closed, true);
  assert.equal(saved, true);
}
