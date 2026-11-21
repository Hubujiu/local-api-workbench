import test from "node:test";
import assert from "node:assert/strict";
import {
  debugPairComposer,
  debugPairFromKey,
  ownsDebugPairComposer,
} from "../public/debug-pair-composer.js";

test("composer exists only in the matching Debug Header or Query view", () => {
  assert(ownsDebugPairComposer("headers", "apis", "debug", "headers"));
  assert(ownsDebugPairComposer("query", "apis", "debug", "query"));
  for (const args of [
    ["path", "apis", "debug", "path"],
    ["query", "apis", "design", "query"],
    ["query", "settings", "debug", "query"],
    ["query", "apis", "debug", "headers"],
  ])
    assert.equal(ownsDebugPairComposer(...args), false);
});

test("only a nonblank name yields a real row; literal spelling is retained", () => {
  for (const empty of ["", " \t", undefined, 43])
    assert.equal(debugPairFromKey(empty), null);
  assert.deepEqual(debugPairFromKey("X-Mixed"), {
    key: "X-Mixed",
    value: "",
    enabled: true,
  });
  assert.equal(debugPairFromKey(" a+b ").key, " a+b ");
});

test("composer has a distinct input and real add and dictionary actions", () => {
  const empty = debugPairComposer("headers", true);
  assert.match(empty, /data-add-pair="headers" aria-label="添加Header参数"/);
  assert.match(
    empty,
    /data-debug-pair-name="headers" aria-label="新Header参数名"/,
  );
  assert.match(empty, /data-debug-pair-dictionary="headers"/);
  assert.doesNotMatch(empty, /data-pair=|checked|colspan/);
  assert.equal((empty.match(/<td>/g) || []).length, 3);
  assert.match(debugPairComposer("query", false), /colspan="2"/);
});
