import test from "node:test";
import assert from "node:assert/strict";
import {
  schemaRows,
  editSchemaNode,
  addSchemaProperty,
  removeSchemaProperty,
  schemaEditor,
} from "../public/schema-editor.js";
test("visual schema edits preserve nested constraints and typed false zero null examples", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["old"],
          properties: {
            old: { type: "integer", minimum: 0, example: 0 },
            keep: { type: "boolean", example: false },
          },
        },
      },
    },
    $defs: { shared: { type: "string" } },
  };
  const path = ["properties", "rows", "items", "properties", "old"];
  const next = editSchemaNode(schema, path, {
    name: "count",
    type: "integer",
    description: "count",
    example: "null",
    required: false,
  });
  assert.equal(next.properties.rows.items.properties.count.example, null);
  assert.equal(next.properties.rows.items.properties.count.minimum, 0);
  assert.deepEqual(next.properties.rows.items.required, []);
  assert.equal(next.properties.rows.items.properties.keep.example, false);
  assert.equal(schema.properties.rows.items.properties.old.example, 0);
  assert.deepEqual(next.$defs, schema.$defs);
  assert.equal(schemaRows(next).length, 5);
});
test("visual schema add remove are atomic and reject dangling local references and duplicate keys", () => {
  const source = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  };
  const added = addSchemaProperty(source, [], "nested");
  assert.equal(added.properties.nested.type, "string");
  assert.equal(source.properties.nested, undefined);
  const special = addSchemaProperty({}, [], "__proto__");
  assert(Object.hasOwn(special.properties, "__proto__"));
  assert.equal(Object.getPrototypeOf(special.properties), Object.prototype);
  assert.throws(() => addSchemaProperty(source, [], "a"), /已存在/);
  const removed = removeSchemaProperty(source, ["properties", "a"]);
  assert.deepEqual(removed.required, []);
  const referenced = {
    ...source,
    $defs: { linked: { $ref: "#/properties/a" } },
  };
  assert.throws(
    () => removeSchemaProperty(referenced, ["properties", "a"]),
    /引用/,
  );
  assert.throws(
    () => editSchemaNode(referenced, ["properties", "a"], { name: "b" }),
    /引用/,
  );
  assert.throws(() => editSchemaNode(source, ["__proto__"], {}), /路径/);
  assert.throws(
    () => editSchemaNode(source, ["properties", "a"], { example: "{" }),
    /示例/,
  );
  assert.throws(
    () => editSchemaNode({ $ref: "#/$defs/shared" }, [], { type: "object" }),
    /引用/,
  );
});
test("visual schema rendering escapes names and descriptions and bounds large trees", () => {
  const schema = {
    type: "object",
    properties: {
      "<img src=x onerror=1>": {
        type: "string",
        description: "<script>x</script>",
      },
    },
  };
  const html = schemaEditor(schema);
  assert(!html.includes("<img"));
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;img"));
  assert.throws(
    () =>
      schemaRows({
        properties: Object.fromEntries(
          Array.from({ length: 501 }, (_, i) => ["k" + i, { type: "string" }]),
        ),
      }),
    /500/,
  );
});
