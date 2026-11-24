import assert from "node:assert/strict";
import test from "node:test";
import { markdownEdit, markdownTools } from "../public/design-markdown.js";

function apply(tool, text, start, end) {
  const edit = markdownEdit(tool, text, start, end);
  const result =
    text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return [result, result.slice(edit.anchor, edit.anchor + edit.length)];
}

test("inline actions preserve surrounding text and select only the payload", () => {
  assert.deepEqual(apply("bold", "before文字after", 6, 8), [
    "before**文字**after",
    "文字",
  ]);
  assert.deepEqual(apply("italic", "", 0, 0), ["*文字*", "文字"]);
});

test("inline and block code delimiters account for literal backticks", () => {
  assert.deepEqual(apply("code", "`a`", 0, 3), ["`` `a` ``", "`a`"]);
  const code = "```literal";
  assert.deepEqual(apply("block", code, 0, code.length), [
    "````\n" + code + "\n````",
    code,
  ]);
});

test("line actions keep an unselected line outside a trailing selection", () => {
  assert.equal(
    apply("number", "one\ntwo\nthird", 0, 8)[0],
    "1. one\n2. two\nthird",
  );
  assert.equal(apply("heading", "x\ny", 2, 2)[0], "x\n## y");
});

test("every visible tool has an implementation and table keeps selected text", () => {
  for (const [tool] of markdownTools) assert.ok(markdownEdit(tool, "", 0, 0));
  assert.match(apply("table", "keep", 0, 4)[0], /^keep\n\n\| 列 A/);
  assert.equal(markdownEdit("toString", "", 0, 0), null);
  assert.equal(markdownEdit("bold", "", 1, 1), null);
});
