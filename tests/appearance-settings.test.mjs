import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAppearanceTheme,
  appearanceTheme,
  applyAppearanceTheme,
} from "../public/appearance-settings.js";

test("appearance uses the existing theme preference and defaults to light", () => {
  const state = new Map();
  const classes = new Set();
  const storage = { setItem: (key, value) => state.set(key, value) };
  const body = {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, present) =>
        present ? classes.add(name) : classes.delete(name),
    },
  };
  assert.equal(appearanceTheme(null), "light");
  assert.equal(appearanceTheme("future-unrecognized"), "light");
  assert.equal(activeAppearanceTheme(body), "light");
  applyAppearanceTheme(body, storage, "dark");
  assert.equal(activeAppearanceTheme(body), "dark");
  assert.deepEqual([...state], [["theme", "dark"]]);
  applyAppearanceTheme(body, storage, "light");
  assert.equal(activeAppearanceTheme(body), "light");
  assert.deepEqual([...state], [["theme", "light"]]);
});
