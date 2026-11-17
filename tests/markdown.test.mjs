import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown-renderer.mjs";
import { renderMarkdown as bundled } from "../public/vendor/markdown-renderer.js";
test("Markdown source and offline browser bundle render headings, tables, lists and fences identically", () => {
  const source =
    "# 文档\n\n**加粗**\n\n- 一个\n- 两个\n\n| 字段 | 类型 |\n| --- | --- |\n| id | number |\n\n```js\nconst x = 1;\n```";
  const html = renderMarkdown(source);
  for (const tag of ["<h1>", "<strong>", "<ul>", "<table>", "<pre><code"])
    assert(html.includes(tag));
  assert.equal(bundled(source), html);
});
test("Markdown disables HTML, active links, remote image loading and oversized previews", () => {
  const text =
    "<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n[x](file:///tmp/private)\n\n![tracker](https://example.test/track)\n\n[ok](https://example.test)";
  const html = renderMarkdown(text);
  assert(!html.includes("<script>"));
  assert(!html.includes('href="javascript:'));
  assert(!html.includes('href="file:'));
  assert(!html.includes("<img"));
  assert(html.includes('href="https://example.test"'));
  assert(renderMarkdown("a".repeat(256 * 1024 + 1)).includes("预览限制"));
  assert.equal(bundled(text), html);
});
