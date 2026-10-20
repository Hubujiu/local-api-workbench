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
    () =>
      removeSchemaProperty(
        { ...source, $defs: { encoded: { $ref: "#%2Fproperties%2Fa" } } },
        ["properties", "a"],
      ),
    /引用/,
  );
  assert.throws(
    () =>
      removeSchemaProperty(
        { properties: { a: { type: "object", $anchor: "anchor" } } },
        ["properties", "a"],
      ),
    /锚点/,
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

test("visual response definitions retain media examples headers and unrelated responses", async () => {
  const { editResponseDefinition } = await import("../public/schema-editor.js");
  const original = [
    {
      status: "200",
      description: "old",
      headers: { "x-id": { schema: { type: "string" } } },
      content: {
        "application/json": {
          schema: { type: "object" },
          example: { old: true },
        },
        "text/plain": { schema: { type: "string" } },
      },
    },
    { status: "404", description: "missing" },
  ];
  const next = editResponseDefinition(original, 0, {
    status: "200",
    description: "updated",
    mediaType: "application/json",
    schema: {
      type: "object",
      properties: { flag: { type: "boolean", example: false } },
    },
  });
  assert.deepEqual(next[0].headers, original[0].headers);
  assert.deepEqual(
    next[0].content["text/plain"],
    original[0].content["text/plain"],
  );
  assert.deepEqual(next[0].content["application/json"].example, { old: true });
  assert.equal(
    next[0].content["application/json"].schema.properties.flag.example,
    false,
  );
  assert.equal(original[0].description, "old");
  assert.throws(
    () =>
      editResponseDefinition(original, -1, {
        status: "200",
        mediaType: "application/json",
        schema: {},
      }),
    /已存在/,
  );
  assert.throws(
    () =>
      editResponseDefinition(original, -1, {
        status: "20X",
        mediaType: "application/json",
        schema: {},
      }),
    /状态/,
  );
  assert.throws(
    () =>
      editResponseDefinition(original, -1, {
        status: "201",
        mediaType: "invalid",
        schema: {},
      }),
    /Content-Type/,
  );
  assert.equal(
    editResponseDefinition(original, -1, {
      status: "201",
      description: "created",
      mediaType: "application/json",
      schema: { type: "null" },
    }).length,
    3,
  );
});

test("visual constraint edits preserve advanced keywords and validate atomically", () => {
  const original = {
    type: "string",
    format: "email",
    minLength: 2,
    maxLength: 20,
    "x-custom": { keep: true },
    allOf: [{ type: "string" }],
  };
  const next = editSchemaNode(original, [], {
    constraints: {
      minLength: "3",
      maxLength: "12",
      pattern: "^[a-z]+$",
      format: "",
      enum: '["abc","def"]',
    },
  });
  assert.equal(next.minLength, 3);
  assert.equal(next.maxLength, 12);
  assert.equal(next.pattern, "^[a-z]+$");
  assert.equal(next.format, undefined);
  assert.deepEqual(next.enum, ["abc", "def"]);
  assert.deepEqual(next.allOf, original.allOf);
  assert.equal(original.minLength, 2);
  const number = editSchemaNode({ type: "number", minimum: 0 }, [], {
    constraints: {
      minimum: "-2",
      maximum: "0",
      multipleOf: "0.5",
      enum: "[0,false,null]",
    },
  });
  assert.equal(number.minimum, -2);
  assert.equal(number.maximum, 0);
  assert.deepEqual(number.enum, [0, false, null]);
  for (const constraints of [
    { minLength: "4", maxLength: "3" },
    { minItems: "-1" },
    { maxProperties: "1.5" },
    { minimum: "Infinity" },
    { multipleOf: "0" },
    { enum: "[]" },
    { enum: "{}" },
    { unknown: "1" },
  ])
    assert.throws(
      () => editSchemaNode(original, [], { constraints }),
      /约束|枚举/,
    );
  assert.equal(original.minLength, 2);
});

test("literal reference-shaped examples do not block field edits while nested schema references still do", () => {
  const source = {
    type: "object",
    properties: { a: { type: "string" } },
    example: { $ref: "#/properties/a" },
    default: { nested: { $ref: "#/properties/a" } },
    enum: [{ $ref: "#/properties/a" }],
    "x-data": { $ref: "#/properties/a" },
  };
  const renamed = editSchemaNode(source, ["properties", "a"], { name: "b" });
  assert(renamed.properties.b);
  assert.deepEqual(renamed.example, source.example);
  assert.deepEqual(
    removeSchemaProperty(source, ["properties", "a"]).properties,
    {},
  );
  for (const nested of [
    { $defs: { x: { $ref: "#/properties/a" } } },
    { allOf: [{ $ref: "#/properties/a" }] },
    { dependentSchemas: { x: { $ref: "#/properties/a" } } },
    { dependencies: { x: { $ref: "#/properties/a" } } },
  ]) {
    assert.throws(
      () => removeSchemaProperty({ ...source, ...nested }, ["properties", "a"]),
      /引用/,
    );
  }
  assert(source.properties.a);
});
