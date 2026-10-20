import test from "node:test";
import assert from "node:assert/strict";
import { prepareApipostModels } from "../src/apipost-models.mjs";
const prepare = (schema) =>
  prepareApipostModels(
    [{ model_id: "one", model_type: "model", name: "One", schema }],
    (kind, id) => `${kind}-${id}`,
    "Project",
  );
test("model rewriting distinguishes literal instance data and property names from schema references", () => {
  const literal = {
    $ref: "https://example.invalid/not-a-schema",
    ref: "one",
    APIPOST_REFS: { value: 1 },
  };
  const schema = {
    type: "object",
    properties: {
      $ref: { type: "string" },
      ref: { const: literal },
      examples: { default: literal },
    },
    example: literal,
    examples: [literal],
    enum: [literal],
    default: literal,
    "x-data": literal,
  };
  const result = prepare(schema).schemas["model-one"];
  assert.deepEqual(result, schema);
  assert.notEqual(result.example, schema.example);
});
test("real nested schema references are rebased while schema maps preserve their names", () => {
  const schema = {
    $defs: { $ref: { type: "integer" } },
    properties: { child: { $ref: "#/$defs/$ref" } },
    allOf: [{ $ref: "one" }],
    additionalProperties: { $ref: "one" },
    dependentSchemas: { ref: { $ref: "one" } },
    dependencies: { names: ["ref"], rule: { $ref: "one" } },
    items: [{ $ref: "one" }],
    prefixItems: [{ $ref: "one" }],
  };
  const result = prepare(schema).schemas["model-one"];
  assert.equal(
    result.properties.child.$ref,
    "#/components/schemas/model-one/$defs/$ref",
  );
  for (const value of [
    result.allOf[0],
    result.additionalProperties,
    result.dependentSchemas.ref,
    result.dependencies.rule,
    result.items[0],
    result.prefixItems[0],
  ])
    assert.equal(value.$ref, "#/components/schemas/model-one");
  assert.deepEqual(result.dependencies.names, ["ref"]);
  assert.throws(
    () =>
      prepare({
        properties: { bad: { $ref: "https://example.invalid/schema" } },
      }),
    /远程/,
  );
  assert.throws(
    () => prepare({ properties: { bad: { APIPOST_REFS: { id: "one" } } } }),
    /自定义/,
  );
});
test("literal data remains subject to the same total node and depth budgets", () => {
  let nested = {};
  for (let i = 0; i < 42; i++) nested = { child: nested };
  assert.throws(() => prepare({ example: nested }), /上限/);
  assert.throws(() => prepare({ examples: Array(50001).fill(null) }), /上限/);
});
