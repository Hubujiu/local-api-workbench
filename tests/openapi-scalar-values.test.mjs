import test from "node:test";
import assert from "node:assert/strict";
import { importOpenAPIScalarValue as select } from "../src/openapi-scalar-values.mjs";

test("direct and single named scalar values preserve false zero and empty text by presence", () => {
  for (const value of [
    false,
    0,
    "",
    "001",
    "0",
    "false",
    "a&+/%",
    true,
    -1.5,
  ]) {
    const other =
      typeof value === "string"
        ? "not selected"
        : typeof value === "boolean"
          ? !value
          : value + 1;
    const schema = {
      type: typeof value,
      default: other,
      example: other,
    };
    assert.equal(select({ schema, example: value }), value);
    assert.equal(
      select({ schema, examples: { only: { summary: "fixture", value } } }),
      value,
    );
  }
});

test("default then schema example is an explicit compatible editor policy, not schema generation", () => {
  for (const value of [false, 0, ""]) {
    assert.equal(
      select({ schema: { default: value, example: "later" } }),
      value,
    );
    assert.equal(select({ schema: { example: value } }), value);
  }
  assert.equal(select({ schema: { type: "boolean" } }), "");
  assert.equal(select({ schema: false }), "");
  assert.equal(select({ schema: true }), "");
  assert.equal(select({}, "legacy"), "legacy");
});

test("ambiguous or external named examples reject rather than silently falling back", () => {
  for (const examples of [
    null,
    [],
    {},
    { a: { value: 0 }, b: { value: false } },
    { a: null },
    { a: false },
    { a: {} },
    { a: { externalValue: "https://example.invalid/private" } },
    { a: { value: 0, externalValue: "https://example.invalid/private" } },
    { a: { $ref: "#/components/examples/Recursive" } },
    { a: { value: 0, $ref: "#/components/examples/Recursive" } },
    { a: Object.create({ value: 0 }) },
  ])
    assert.throws(
      () => select({ schema: { default: "fallback" }, examples }),
      /OpenAPI标量参数/,
    );
  assert.throws(
    () => select({ example: false, examples: { one: { value: false } } }),
    /不能同时/,
  );
});

test("explicit null compounds unsafe and nonfinite numeric selections are not coerced or treated as absent", () => {
  for (const value of [
    null,
    undefined,
    [],
    {},
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
  ]) {
    for (const parameter of [
      { example: value, schema: { default: "fallback" } },
      { examples: { one: { value } }, schema: { default: "fallback" } },
      { schema: { default: value, example: "fallback" } },
      { schema: { example: value } },
    ])
      assert.throws(() => select(parameter), /选定值/);
  }
});

test("compound encodings remain owned by their existing import paths", () => {
  for (const parameter of [
    {
      schema: { type: "array", items: { type: "string" } },
      example: ["a", "b"],
    },
    { schema: { type: "object" }, examples: { a: { value: {} } } },
    { schema: { type: ["string", "null"] }, example: null },
    { schema: { oneOf: [{ type: "string" }] }, example: "x" },
    { content: { "application/json": { example: { a: 1 } } } },
  ]) {
    const fallback = { legacy: true };
    assert.equal(select(parameter, fallback), fallback);
  }
});

test("selection leaves source schemas annotations and literal template spellings unchanged", () => {
  const parameter = {
    schema: { type: "string", default: "unused" },
    examples: {
      fixture: {
        value: "{{token}}",
        summary: "example",
        "x-data": { $ref: "literal" },
      },
    },
  };
  const before = structuredClone(parameter);
  assert.equal(select(parameter), "{{token}}");
  assert.deepEqual(parameter, before);
});
