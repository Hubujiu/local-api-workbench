import test from "node:test";
import assert from "node:assert/strict";
import { replaceExactApipostTemplate } from "../src/apipost-template-replacement.mjs";
test("exact-field replacement matches native String replacement tokens without a second pass", () => {
  for (const expression of [
    "{{$function.fn_f(x)}}",
    '{{quoted"中}}',
    "{{$function.fn_f($&)}}",
  ])
    for (const replacement of [
      "plain",
      "$5",
      "$1",
      "$<name>",
      "$$",
      "$&",
      "$`",
      "$'",
      "a$$b$&c",
      "$$&$`$'",
      "{{untouched}}",
      '\n"\\中',
    ])
      assert.equal(
        replaceExactApipostTemplate(expression, replacement),
        expression.replace(expression, replacement),
      );
});
test("replacement expansion is bounded before constructing a large result", () => {
  const expression = "x".repeat(100);
  assert.equal(
    replaceExactApipostTemplate(expression, "$&".repeat(655)).length,
    65500,
  );
  assert.throws(
    () => replaceExactApipostTemplate(expression, "$&".repeat(656)),
    /64KiB/,
  );
  assert.throws(
    () => replaceExactApipostTemplate("x".repeat(60000), "$&".repeat(20000)),
    /64KiB/,
  );
  assert.throws(
    () => replaceExactApipostTemplate('"'.repeat(20000), "$&$&"),
    /64KiB/,
  );
  assert.throws(
    () => replaceExactApipostTemplate("x", "中".repeat(30000)),
    /64KiB/,
  );
});
