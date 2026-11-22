import assert from "node:assert/strict";
import test from "node:test";
import {
  modelRawDecoration,
  modelRawEditorMarkup,
} from "../public/model-raw-editor.js";

test("Model Raw decoration mirrors invalid or partial input without normalizing it", () => {
  const source = '\n{\n\t"description": "<plain> 中文 & literal",\n';
  const result = modelRawDecoration(source);
  assert.equal(result.gutter, "1\n2\n3\n4");
  assert.match(result.ink, /^\n\{\n\t<span class="syntax-key">/);
  assert.match(result.ink, /&lt;plain&gt; 中文 &amp; literal/);
  assert.doesNotMatch(result.ink, /<plain>/);
  assert(result.ink.endsWith(",\n\n"));
});

test("Model Raw can fall back to plain text without imposing an edit limit", () => {
  assert.equal(modelRawDecoration("").gutter, "1");
  assert.equal(modelRawDecoration(" ").gutter, "1");
  assert.equal(modelRawDecoration("a".repeat(65537)), null);
  assert.equal(modelRawDecoration("\n".repeat(2048)), null);
  assert(modelRawDecoration("x".repeat(65536)));
  const markup = modelRawEditorMarkup();
  assert.equal(markup.match(/<textarea\b/g)?.length, 1);
  assert.match(
    markup,
    /<textarea id="model-workspace-json"[^>]+wrap="off"[^>]+autofocus/,
  );
  assert.match(markup, /data-model-raw-ink aria-hidden="true"/);
  assert.doesNotMatch(markup, /contenteditable/);
});
