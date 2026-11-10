import test from "node:test";
import assert from "node:assert/strict";
import { importOpenAPIHeaderCookieValue as select } from "../src/openapi-header-cookie-values.mjs";

test("Header/Cookie object admission checks delegated fallbacks as well as selected examples", () => {
  const value = { role: "admin" };
  const parameter = {
    in: "cookie",
    schema: { type: "array", items: { type: "string" }, default: value },
    examples: { only: { value: ["ok"] } },
  };
  assert.throws(() => select(parameter, value), /Cookie.*复合/);
  for (const example of [value, [value], [[value]]])
    assert.throws(
      () =>
        select({ in: "header", schema: { type: "array", items: {} }, example }),
      /Header.*复合/,
    );
});

test("non-object schemas, unselected defaults and literal annotations retain precedence", () => {
  for (const schema of [
    { type: "string", default: { unused: true }, example: { unused: true } },
    { type: "string", properties: { unused: { type: "object" } } },
    {
      not: { type: "object" },
      $defs: { Unused: { type: "object" } },
      "x-literal": { type: "object" },
    },
    { if: { type: "object" }, then: { not: {} }, else: { type: "string" } },
    { then: { type: "object" }, else: { type: "object" } },
    { type: "string", enum: ['{"literal":true}', { unused: true }] },
    true,
  ])
    assert.equal(
      select({ in: "header", schema, example: '{"literal":true}' }),
      '{"literal":true}',
    );
});

test("Header/Cookie content serialization refuses distinctly even for scalar media", () => {
  for (const location of ["header", "cookie"])
    for (const example of ["scalar", 0, false, { role: "admin" }])
      assert.throws(
        () =>
          select({
            in: location,
            content: { "application/json": { example } },
          }),
        /content参数序列化尚不支持/,
      );
});

test("schema and array traversal is cycle-safe without walking literal object annotations", () => {
  const schema = { allOf: [] };
  schema.allOf.push(schema);
  assert.equal(
    select(
      { in: "header", schema, example: "ignored by legacy compound selection" },
      "fallback",
    ),
    "fallback",
  );
  const array = ["legacy"];
  array.push(array);
  assert.equal(
    select({ in: "header", schema: { type: "array" }, example: array }, array),
    array,
  );
  array.push({ nested: true });
  assert.throws(
    () =>
      select(
        { in: "cookie", schema: { type: "array" }, example: array },
        array,
      ),
    /复合/,
  );
});
