import test from "node:test";
import assert from "node:assert/strict";
import {
  captureDebugPublication as capture,
  writeDebugVariables as write,
  publishDebugVariables as publish,
  clearDebugVariables as clear,
} from "../src/debug-publication.mjs";
const entry = (value) => ({ fingerprint: "persisted", variables: { value } });
test("manual edits including same-value edits defeat stale publication", () => {
  const cache = new Map();
  write(cache, "a", "a:e", entry("old"));
  for (const value of ["old", "new"]) {
    const ticket = capture(cache, "a", "a:e");
    write(cache, "a", "a:e", entry(value));
    assert.equal(publish(cache, ticket, entry("stale")), false);
    assert.deepEqual(cache.get("a:e"), entry(value));
  }
});
test("clear invalidates absent-entry and existing-entry publishers without ABA", () => {
  const cache = new Map();
  for (const present of [false, true]) {
    if (present) write(cache, "a", "a:e", entry("old"));
    const ticket = capture(cache, "a", "a:e");
    clear(cache, "a");
    assert.equal(publish(cache, ticket, entry("stale")), false);
    assert.equal(cache.has("a:e"), false);
    assert.equal(
      publish(cache, capture(cache, "a", "a:e"), entry("fresh")),
      true,
    );
  }
});
test("first accepted publication wins; projects environments and cache instances isolate", () => {
  const cache = new Map(),
    other = new Map();
  const old = capture(cache, "a", "a:e"),
    current = capture(cache, "a", "a:e");
  const sibling = capture(cache, "a", "a:f"),
    project = capture(cache, "b", "b:e");
  assert.equal(publish(cache, current, entry("new")), true);
  assert.equal(publish(cache, old, entry("old")), false);
  assert.equal(publish(cache, sibling, entry("sibling")), true);
  clear(cache, "a");
  assert.equal(publish(cache, project, entry("project")), true);
  assert.equal(publish(other, old, entry("foreign")), false);
  assert.equal(other.size, 0);
  assert.equal(
    publish(other, capture(other, "a", "a:e"), entry("restart")),
    true,
  );
});
