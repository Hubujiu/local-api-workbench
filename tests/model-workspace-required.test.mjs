import assert from "node:assert/strict";
import test from "node:test";
import { setWorkspaceModelFieldRequired } from "../public/model-workspace-required.js";

test("required changes only the owning nested parent's array and keeps sibling order", () => {
  const source = {
    type: "object",
    required: ["group"],
    properties: {
      group: {
        type: "object",
        properties: {
          before: { type: "boolean" },
          value: { type: "number", example: 42, description: "kept" },
          after: { type: "null", default: null },
        },
        required: ["after", "before"],
      },
    },
  };
  assert.equal(setWorkspaceModelFieldRequired(source, 2, false), source);
  const on = setWorkspaceModelFieldRequired(source, 2, true);
  assert.deepEqual(on.properties.group.required, ["after", "before", "value"]);
  assert.deepEqual(
    on.properties.group.properties,
    source.properties.group.properties,
  );
  assert.deepEqual(on.required, ["group"]);
  assert.deepEqual(setWorkspaceModelFieldRequired(on, 2, false), source);
});

test("adding then removing the sole required name leaves no empty required array", () => {
  const source = { type: "object", properties: { value: { type: "string" } } };
  const on = setWorkspaceModelFieldRequired(source, 0, true);
  assert.deepEqual(on.required, ["value"]);
  assert.deepEqual(setWorkspaceModelFieldRequired(on, 0, false), source);
  assert.throws(
    () => setWorkspaceModelFieldRequired(source, 0, "true"),
    /不能/,
  );
  assert.throws(() => setWorkspaceModelFieldRequired(source, -1, true), /不能/);
  for (const property of [false, { $ref: "#/properties/value" }]) {
    assert.throws(
      () =>
        setWorkspaceModelFieldRequired(
          { properties: { value: property } },
          0,
          true,
        ),
      /不能/,
    );
  }
});
