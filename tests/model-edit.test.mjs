import test from "node:test";
import assert from "node:assert/strict";
import { saveModel } from "../public/model-edit.js";
import { sampleProjectSchema } from "../src/mock-fields.mjs";

test("editing an imported model preserves its identity and folder and updates its linked component", () => {
  const p = {
    modelFolders: [{ id: "f", name: "Group" }],
    dictionary: [
      {
        id: "model-x",
        name: "Old",
        folderId: "f",
        sort: 7,
        schema: { const: 1 },
      },
    ],
    openapiComponents: {
      schemas: { "model-x": { const: 1 }, other: { const: 3 } },
    },
  };
  const old = structuredClone(p);
  saveModel(p, 0, { name: "New", schema: { const: 2 } }, "must-not-replace-id");
  assert.equal(p.dictionary[0].id, "model-x");
  assert.equal(p.dictionary[0].folderId, "f");
  assert.equal(p.dictionary[0].sort, 7);
  assert.equal(
    sampleProjectSchema(p, { $ref: "#/components/schemas/model-x" }),
    2,
  );
  assert.deepEqual(
    p.openapiComponents.schemas.other,
    old.openapiComponents.schemas.other,
  );
  assert.equal(old.dictionary[0].schema.const, 1);
});
test("invalid model edits are atomic and new models can explicitly select a valid folder", () => {
  const p = { modelFolders: [{ id: "f", name: "Group" }], dictionary: [] };
  for (const input of [
    { name: "", schema: {} },
    { name: "New", schema: [] },
    { name: "New", schema: {}, folderId: "missing" },
  ]) {
    const before = structuredClone(p);
    assert.throws(() => saveModel(p, undefined, input, "new-id"));
    assert.deepEqual(p, before);
  }
  saveModel(
    p,
    undefined,
    { name: "New", schema: false, folderId: "f" },
    "new-id",
  );
  assert.equal(p.dictionary[0].folderId, "f");
  assert.equal(p.dictionary[0].schema, false);
});
