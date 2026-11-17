import test from "node:test";
import assert from "node:assert/strict";
import { highlightJSON } from "../public/code-format.js";
test("JSON highlight retains escaped text and never creates active markup", () => {
  const result = highlightJSON('{"x":"<img onerror=bad()>","n":2}');
  assert(result.includes("syntax-key"));
  assert(result.includes("syntax-number"));
  assert(!result.includes("<img"));
  assert(result.includes("&lt;img"));
});
