import test from "node:test";
import assert from "node:assert/strict";
import { sampleFromSchema } from "../src/core.mjs";
test("schema samples honor common lengths, array bounds, numeric ranges and false/null constants", () => {
  assert.equal(
    sampleFromSchema({ type: "string", minLength: 3, maxLength: 5 }),
    "xxx",
  );
  assert.deepEqual(
    sampleFromSchema({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { const: false },
    }),
    [false, false],
  );
  assert.deepEqual(
    sampleFromSchema({ type: "array", maxItems: 0, items: { type: "string" } }),
    [],
  );
  assert.equal(sampleFromSchema({ const: null }), null);
  assert.deepEqual(
    sampleFromSchema({
      type: "object",
      required: ["extra"],
      additionalProperties: { type: "boolean" },
    }),
    { extra: false },
  );
  assert.throws(
    () =>
      sampleFromSchema({
        type: "object",
        required: ["extra"],
        additionalProperties: false,
      }),
    /约束冲突/,
  );
  assert.equal(
    sampleFromSchema({ type: "integer", minimum: 1.2, maximum: 3 }),
    2,
  );
  assert.equal(
    sampleFromSchema({
      type: "integer",
      minimum: 2,
      exclusiveMinimum: true,
      maximum: 4,
    }),
    3,
  );
  const decimal = sampleFromSchema({
    type: "number",
    minimum: 0.2,
    maximum: 0.8,
    multipleOf: 0.1,
  });
  assert(decimal >= 0.2 && decimal <= 0.8);
  assert(Math.abs(decimal / 0.1 - Math.round(decimal / 0.1)) < 1e-9);
  assert.throws(
    () => sampleFromSchema({ type: "integer", minimum: 3, maximum: 2 }),
    /约束/,
  );
  assert.throws(
    () => sampleFromSchema({ type: "string", pattern: "[A-Z]+" }),
    /example/,
  );
});
test("schema references stay local and cycles or unsupported complex constraints fail explicitly", () => {
  const root = {
    components: {
      schemas: { Item: { type: "object", properties: { id: { const: 42 } } } },
    },
  };
  assert.deepEqual(
    sampleFromSchema({ $ref: "#/components/schemas/Item" }, 0, root),
    { id: 42 },
  );
  assert.throws(
    () => sampleFromSchema({ $ref: "https://example.test/schema" }),
    /外部/,
  );
  assert.throws(
    () =>
      sampleFromSchema({ $ref: "#/$defs/Loop" }, 0, {
        $defs: { Loop: { $ref: "#/$defs/Loop" } },
      }),
    /递归/,
  );
  assert.throws(
    () =>
      sampleFromSchema({
        type: "array",
        minItems: 10001,
        items: { type: "string" },
      }),
    /上限/,
  );
  assert.throws(
    () => sampleFromSchema({ allOf: [{ type: "string" }, { type: "number" }] }),
    /example/,
  );
  assert.throws(() => sampleFromSchema(false), /禁止/);
});
test("schema tuple samples cover modern and legacy ordered items with bounded tails", () => {
  const prefix = [
    { const: 42 },
    { type: "string", minLength: 2 },
    { const: false },
  ];
  assert.deepEqual(
    sampleFromSchema({ type: "array", prefixItems: prefix, items: false }),
    [42, "xx", false],
  );
  assert.deepEqual(
    sampleFromSchema({ type: "array", items: prefix, additionalItems: false }),
    [42, "xx", false],
  );
  assert.deepEqual(
    sampleFromSchema({ type: "array", prefixItems: prefix, maxItems: 2 }),
    [42, "xx"],
  );
  assert.deepEqual(
    sampleFromSchema({
      type: "array",
      prefixItems: [{ const: 1 }],
      minItems: 3,
      items: { const: null },
    }),
    [1, null, null],
  );
  assert.deepEqual(
    sampleFromSchema({
      type: "array",
      items: [{ const: 1 }],
      minItems: 2,
      additionalItems: { const: true },
    }),
    [1, true],
  );
  assert.deepEqual(sampleFromSchema({ type: "array", items: false }), []);
  assert.deepEqual(
    sampleFromSchema({
      type: "array",
      prefixItems: [{ const: 1 }, false, { const: 3 }],
    }),
    [1],
  );
});
test("schema tuple failures do not silently ignore conflicting or unsupported constraints", () => {
  for (const schema of [
    { type: "array", prefixItems: [{ const: 1 }], items: false, minItems: 2 },
    {
      type: "array",
      items: [{ const: 1 }],
      additionalItems: false,
      minItems: 2,
    },
    { type: "array", prefixItems: [false], minItems: 1 },
    {
      type: "array",
      prefixItems: [{ const: 1 }, { const: 1 }],
      minItems: 2,
      uniqueItems: true,
    },
    { type: "array", prefixItems: {}, items: {} },
    { type: "array", prefixItems: [], items: [] },
    { type: "array", prefixItems: [{}], unevaluatedItems: false },
  ])
    assert.throws(() => sampleFromSchema(schema));
  assert.deepEqual(
    sampleFromSchema({
      type: "array",
      prefixItems: [{ const: 1 }, { const: 2 }],
      uniqueItems: true,
    }),
    [1, 2],
  );
});
test("schema sample references decode URI fragments once before JSON Pointer tokens", () => {
  const root = {
    $defs: {
      "a/b": { const: 7 },
      "m~n": { const: false },
      "百分号%": { const: null },
      "": { const: "empty" },
    },
  };
  assert.equal(sampleFromSchema({ $ref: "#%2F%24defs%2Fa~1b" }, 0, root), 7);
  assert.equal(sampleFromSchema({ $ref: "#/$defs/m~0n" }, 0, root), false);
  assert.equal(
    sampleFromSchema(
      { $ref: "#/$defs/%E7%99%BE%E5%88%86%E5%8F%B7%25" },
      0,
      root,
    ),
    null,
  );
  assert.equal(sampleFromSchema({ $ref: "#/$defs/" }, 0, root), "empty");
  for (const ref of [
    "#/$defs/%",
    "#/$defs/m~2n",
    "#/constructor",
    "#/$defs/absent",
  ])
    assert.throws(() => sampleFromSchema({ $ref: ref }, 0, root));
  assert.throws(
    () => sampleFromSchema({ $ref: "#/$defs/Bad" }, 0, { $defs: { Bad: 42 } }),
    /Schema/,
  );
  assert.throws(
    () =>
      sampleFromSchema({ $ref: "#/$defs/Loop" }, 0, {
        $defs: { Loop: { $ref: "#/%24defs/Loop" } },
      }),
    /递归/,
  );
});
