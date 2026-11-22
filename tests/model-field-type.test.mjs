import assert from "node:assert/strict";
import test from "node:test";
import {
  changeWorkspaceModelFieldType,
  isModelTypeProperty,
} from "../public/model-workspace-type.js";

const withField = (field) => ({
  type: "object",
  properties: {
    value: field,
    untouched: { type: "null" },
  },
  required: ["value"],
});

test("changing a concrete field type keeps its name, required marker, metadata and siblings", () => {
  const source = withField({
    type: "string",
    title: "Neutral",
    description: "Fixture description",
    readOnly: true,
  });
  assert.equal(changeWorkspaceModelFieldType(source, 0, "string"), source);
  const result = changeWorkspaceModelFieldType(source, 0, "number");
  assert.deepEqual(
    result,
    withField({
      type: "number",
      title: "Neutral",
      description: "Fixture description",
      readOnly: true,
    }),
  );
  assert.equal(source.properties.value.type, "string");
  assert.throws(
    () => changeWorkspaceModelFieldType(source, -1, "number"),
    /不能/,
  );
  assert.throws(
    () => changeWorkspaceModelFieldType(source, 0, "anyOf"),
    /不能/,
  );
});

test("inapplicable constraints, conflicting values and nonconcrete schema stay with Raw", () => {
  const transitions = [
    [{ type: "string", minLength: 2 }, "number"],
    [{ type: "string", example: "kept" }, "number"],
    [{ type: "array", items: { type: "null" } }, "number"],
    [{ type: "number", enum: [1, 2.5] }, "integer"],
    [{ type: "object", properties: { name: { type: "string" } } }, "string"],
    [{ type: "string", arbitrary: 1 }, "number"],
  ];
  for (const [field, target] of transitions) {
    const source = withField(field);
    const before = structuredClone(source);
    assert.throws(
      () => changeWorkspaceModelFieldType(source, 0, target),
      /与现有字段约束或值冲突/,
    );
    assert.deepEqual(source, before);
  }
  for (const field of [
    false,
    { type: ["string", "null"] },
    { type: "object", $ref: "#/properties/value" },
    { type: "string", not: { type: "number" } },
  ]) {
    assert.equal(
      isModelTypeProperty({ path: ["properties", "value"], schema: field }),
      false,
    );
  }
  const source = withField({
    type: "number",
    default: 1,
    minimum: 0,
    enum: [1, 2],
  });
  assert.deepEqual(
    changeWorkspaceModelFieldType(source, 0, "integer").properties.value,
    { ...source.properties.value, type: "integer" },
  );
});
