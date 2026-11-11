import test from "node:test";
import assert from "node:assert/strict";
import { assertCleanDesktopExit } from "./helpers/desktop-restart-receipt.mjs";
const clean = {
  code: 0,
  signal: null,
  closed: true,
  saved: true,
  forced: false,
};
test("desktop restart accepts only clean closed saved receipts", () => {
  assert.doesNotThrow(() => assertCleanDesktopExit(clean));
});
for (const change of [
  { code: 2 },
  { signal: "SIGKILL" },
  { closed: false },
  { saved: false },
  { forced: true },
])
  test(`desktop restart rejects ${Object.keys(change)[0]} mismatch`, () => {
    assert.throws(() => assertCleanDesktopExit({ ...clean, ...change }));
  });
