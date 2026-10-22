import test from "node:test";
import assert from "node:assert/strict";
import * as editor from "../public/schema-editor.js";

test("visual composition rows expose nested branches without changing sibling constraints", () => {
  const schema = {
    minLength: 2,
    allOf: [{ type: "string" }, { anyOf: [{ maxLength: 4 }, false] }],
  };
  const snapshot = structuredClone(schema);
  assert.deepEqual(
    editor.schemaRows(schema).map((row) => row.path),
    [
      [],
      ["allOf", 0],
      ["allOf", 1],
      ["allOf", 1, "anyOf", 0],
      ["allOf", 1, "anyOf", 1],
    ],
  );
  const edited = editor.editSchemaNode(schema, ["allOf", 1, "anyOf", 0], {
    constraints: { maxLength: "5" },
  });
  assert.equal(edited.allOf[1].anyOf[0].maxLength, 5);
  assert.equal(edited.minLength, 2);
  assert.equal(edited.allOf[1].anyOf[1], false);
  assert.deepEqual(schema, snapshot);
});

test("adding typed branches is atomic and preserves existing composition and parent constraints", () => {
  const source = {
    type: "object",
    required: ["keep"],
    properties: { keep: { type: "string" } },
    anyOf: [{ properties: { keep: { minLength: 2 } } }],
  };
  const snapshot = structuredClone(source);
  for (const kind of ["allOf", "anyOf", "oneOf"]) {
    const result = editor.addSchemaBranch(source, [], kind, "object");
    assert.deepEqual(result[kind].at(-1), { type: "object" });
    assert.deepEqual(result.required, ["keep"]);
    assert.deepEqual(result.properties, source.properties);
    assert.deepEqual(source, snapshot);
  }
  assert.throws(
    () => editor.addSchemaBranch(source, [], "not", "string"),
    /组合/,
  );
  assert.throws(
    () => editor.addSchemaBranch(source, [], "allOf", "unknown"),
    /类型/,
  );
  assert.throws(
    () => editor.addSchemaBranch({ allOf: [] }, [], "allOf", "string"),
    /组合/,
  );
  assert.throws(
    () =>
      editor.addSchemaBranch(
        { allOf: Array.from({ length: 100 }, () => ({})) },
        [],
        "allOf",
        "string",
      ),
    /100/,
  );
});

test("branch removal cannot shift local reference targets or drop real identifiers", () => {
  const source = {
    allOf: [{ type: "string", example: { $id: "literal" } }, { maxLength: 4 }],
    example: { $ref: "#/allOf/1" },
  };
  const removed = editor.removeSchemaBranch(source, ["allOf", 0]);
  assert.deepEqual(removed.allOf, [{ maxLength: 4 }]);
  assert.deepEqual(removed.example, source.example);
  assert.equal(source.allOf.length, 2);
  assert.throws(
    () => editor.removeSchemaBranch(removed, ["allOf", 0]),
    /至少.*分支/,
  );
  assert.throws(
    () =>
      editor.removeSchemaBranch(
        { ...source, $defs: { use: { $ref: "#/allOf/1" } } },
        ["allOf", 0],
      ),
    /引用/,
  );
  assert.throws(
    () =>
      editor.removeSchemaBranch({ allOf: [{ $anchor: "kept" }, {}] }, [
        "allOf",
        0,
      ]),
    /锚点/,
  );
  assert.throws(
    () => editor.removeSchemaBranch(source, ["allOf", "0"]),
    /路径|索引/,
  );
  for (const reference of [
    { $ref: "urn:root#/allOf/1" },
    { $ref: "#anchor" },
    { $dynamicRef: "#/allOf/1" },
    { $recursiveRef: "#" },
  ]) {
    assert.throws(
      () =>
        editor.removeSchemaBranch(
          { ...source, $id: "urn:root", $defs: { use: reference } },
          ["allOf", 0],
        ),
      /动态引用|Pointer/,
    );
  }
});

test("composition visual editing keeps size and shape limits and permits branch-local fields and references", () => {
  for (const value of [null, {}, [], [null], ["string"], Array(1)])
    assert.throws(() => editor.schemaRows({ oneOf: value }), /组合|分支/);
  const schema = {
    oneOf: [
      { type: "object", properties: { name: { type: "string" } } },
      { type: "number" },
    ],
    $defs: { Name: { type: "string" } },
  };
  const referenced = editor.editSchemaReference(
    schema,
    ["oneOf", 0, "properties", "name"],
    "#/$defs/Name",
  );
  assert.equal(referenced.oneOf[0].properties.name.$ref, "#/$defs/Name");
  const added = editor.addSchemaProperty(schema, ["oneOf", 0], "second");
  assert.equal(added.oneOf[0].properties.second.type, "string");
  const deep = {};
  let node = deep;
  for (let i = 0; i < 17; i++) {
    node.allOf = [{}];
    node = node.allOf[0];
  }
  assert.throws(() => editor.schemaRows(deep), /16层/);
});

test("edited compositions retain JSON Schema conjunction and exact-one semantics", async () => {
  const { default: Ajv } = await import("ajv");
  const ajv = new Ajv({ strict: false });
  const source = { type: "integer", minimum: 0, allOf: [{ maximum: 5 }] };
  const added = editor.addSchemaBranch(source, [], "allOf", "number");
  const edited = editor.editSchemaNode(added, ["allOf", 0], {
    constraints: { maximum: "10" },
  });
  const validate = ajv.compile(edited);
  assert.equal(validate(8), true);
  for (const value of [-1, 11, 3.5, "8"]) assert.equal(validate(value), false);
  const overlapping = editor.addSchemaBranch(
    { oneOf: [{ type: "object" }] },
    [],
    "oneOf",
    "object",
  );
  assert.equal(ajv.compile(overlapping)({}), false);
  assert.equal(
    ajv.compile(editor.removeSchemaBranch(overlapping, ["oneOf", 1]))({}),
    true,
  );
});
