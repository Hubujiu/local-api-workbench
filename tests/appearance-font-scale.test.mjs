import assert from "node:assert/strict";
import test from "node:test";
import {
  appearanceFontScaleHTML,
  applyFontScale,
  fontScaleKey,
  readFontScale,
  validatedFontScale,
} from "../public/appearance-font-scale.js";

test("font scale accepts only the locally supported ten-point grid", () => {
  assert.deepEqual(
    [80, 90, 100, 110, 120].map(validatedFontScale),
    [80, 90, 100, 110, 120],
  );
  for (const value of [
    "",
    0,
    130,
    75,
    105,
    "100.5",
    "1e2",
    "-100",
    "90%",
    "Infinity",
    null,
  ]) {
    assert.equal(validatedFontScale(value), null, String(value));
  }
  assert.equal(validatedFontScale(" 110 "), 110);
  assert.match(
    appearanceFontScaleHTML(),
    /type="number" min="80" max="120" step="10"/,
  );
  assert.equal(
    (appearanceFontScaleHTML().match(/data-font-scale-step/g) || []).length,
    2,
  );
});

test("font scale restores the existing CSS baseline for 100 or invalid storage", () => {
  const root = { dataset: {} };
  let stored;
  const storage = {
    getItem(key) {
      assert.equal(key, fontScaleKey);
      return stored;
    },
  };
  for (const input of [undefined, "99", "110", "100", "bad"]) {
    stored = input;
    applyFontScale(root, readFontScale(storage));
    assert.deepEqual(
      root.dataset,
      input === "110" ? { appFontScale: "110" } : {},
    );
  }
});
