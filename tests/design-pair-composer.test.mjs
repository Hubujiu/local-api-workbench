import assert from "node:assert/strict";
import test from "node:test";
import {
  canComposeDesignPair,
  designPairComposer,
} from "../public/design-pair-composer.js";

test("a Design composer is owned only by the visible Header or Query tab", () => {
  assert.equal(
    canComposeDesignPair("headers", "apis", "design", "headers"),
    true,
  );
  assert.equal(canComposeDesignPair("query", "apis", "design", "query"), true);
  for (const args of [
    ["headers", "apis", "debug", "headers"],
    ["headers", "settings", "design", "headers"],
    ["headers", "apis", "design", "query"],
    ["path", "apis", "design", "path"],
  ]) {
    assert.equal(canComposeDesignPair(...args), false);
  }
});

test("the synthetic input row contains no stored row controls", () => {
  for (const [kind, label] of [
    ["headers", "Header"],
    ["query", "Query"],
  ]) {
    const body = designPairComposer(kind, true);
    assert.match(body, new RegExp('aria-label="新' + label + '参数名"'));
    assert.match(body, new RegExp('data-add-pair="' + kind + '"'));
    assert.equal(body.match(/<td\b/g).length, 4);
    assert.equal(designPairComposer(kind, false).match(/<td\b/g).length, 5);
    assert.doesNotMatch(body, /data-pair=|type="checkbox"|必填/);
  }
});
