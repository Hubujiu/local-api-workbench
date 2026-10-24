import test from "node:test";
import assert from "node:assert/strict";
import { removeSchemaProperty } from "../public/schema-editor.js";

test("literal identifier-shaped annotations do not prevent deleting a schema property", () => {
  const literal = {
    $id: "payload-id",
    $anchor: "payload-anchor",
    $dynamicAnchor: "payload-dynamic",
  };
  const node = {
    type: "object",
    example: literal,
    examples: [literal],
    default: literal,
    enum: [literal],
    const: literal,
    "x-data": literal,
  };
  const source = {
    type: "object",
    properties: { remove: node, keep: { $id: "urn:kept", type: "string" } },
    required: ["remove", "keep"],
  };
  const snapshot = structuredClone(source);
  const result = removeSchemaProperty(source, ["properties", "remove"]);
  assert.deepEqual(result.properties, { keep: source.properties.keep });
  assert.deepEqual(result.required, ["keep"]);
  assert.deepEqual(source, snapshot);
});

test("identifier-shaped property names are not schema identifiers", () => {
  const source = {
    properties: {
      remove: {
        type: "object",
        properties: {
          $id: { type: "string" },
          $anchor: { type: "string" },
          $dynamicAnchor: { type: "string" },
        },
        dependencies: { $id: ["$anchor"] },
      },
    },
  };
  assert.deepEqual(
    removeSchemaProperty(source, ["properties", "remove"]).properties,
    {},
  );
});

test("actual identifiers in typed schema positions still block deletion atomically", () => {
  for (const key of ["$id", "$anchor", "$dynamicAnchor"]) {
    const id = { [key]: "identifier", type: "string" };
    for (const node of [
      id,
      { properties: { x: id } },
      { $defs: { x: id } },
      { definitions: { x: id } },
      { allOf: [id] },
      { anyOf: [id] },
      { oneOf: [id] },
      { if: id },
      { then: id },
      { else: id },
      { not: id },
      { additionalProperties: id },
      { items: id },
      { items: [id] },
      { prefixItems: [id] },
      { dependencies: { x: id } },
      { dependentSchemas: { x: id } },
      { contentSchema: id },
    ]) {
      const source = { properties: { remove: node } },
        snapshot = structuredClone(source);
      assert.throws(
        () => removeSchemaProperty(source, ["properties", "remove"]),
        /标识或锚点/,
      );
      assert.deepEqual(source, snapshot);
    }
  }
});
