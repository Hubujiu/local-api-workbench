import test from "node:test";
import assert from "node:assert/strict";
import { inferSchemaFromJSON } from "../public/schema-inference.js";
import { sampleFromSchema } from "../src/core.mjs";

test("JSON example inference preserves structure and example without inventing required fields", () => {
  const example = {
    id: 7,
    ratio: 1.5,
    name: "text",
    active: true,
    child: null,
    rows: [{ a: 1 }, { a: 2 }],
    empty: [],
  };
  const schema = inferSchemaFromJSON(JSON.stringify(example));
  assert.equal(schema.properties.id.type, "integer");
  assert.equal(schema.properties.ratio.type, "number");
  assert.equal(schema.properties.child.type, "null");
  assert.deepEqual(schema.properties.rows.items, {
    type: "object",
    properties: { a: { type: "integer" } },
  });
  assert.deepEqual(schema.properties.empty.items, {});
  assert.equal(schema.required, undefined);
  assert.deepEqual(sampleFromSchema(schema), example);
});
test("JSON inference retains heterogeneous array alternatives and safe literal property names", () => {
  const schema = inferSchemaFromJSON('[1,"text",null,true,1]');
  assert.deepEqual(
    schema.items.anyOf.map((x) => x.type),
    ["integer", "string", "null", "boolean"],
  );
  const special = inferSchemaFromJSON(
    '{"__proto__":{"polluted":true},"constructor":1}',
  );
  assert.equal(Object.hasOwn(special.properties, "__proto__"), true);
  assert.equal(special.properties.__proto__.type, "object");
  assert.equal({}.polluted, undefined);
  assert.deepEqual(inferSchemaFromJSON("null"), {
    type: "null",
    example: null,
  });
});
test("JSON inference rejects unsafe numbers and bounded-input violations without truncation", () => {
  for (const source of [
    "{",
    "9007199254740993",
    "1e400",
    '"' + "中".repeat(22000) + '"',
    "[".repeat(22) + "0" + "]".repeat(22),
    JSON.stringify(Array(2001).fill(0)),
  ])
    assert.throws(() => inferSchemaFromJSON(source));
  assert.throws(() => inferSchemaFromJSON({}), /文本/);
  assert.equal(
    inferSchemaFromJSON("9007199254740991").example,
    Number.MAX_SAFE_INTEGER,
  );
});
