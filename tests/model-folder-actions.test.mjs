import test from "node:test";
import assert from "node:assert/strict";
import {
  saveModelFolder,
  removeEmptyModelFolder,
} from "../public/model-folder-actions.js";
import { modelFolderPath } from "../public/model-folders.js";

test("model folder create/rename/move preserves model identity and resolves paths", () => {
  const p = { dictionary: [], modelFolders: [] };
  saveModelFolder(p, undefined, { name: " Parent " }, "parent");
  saveModelFolder(p, undefined, { name: "Child" }, "child");
  p.dictionary.push({
    id: "model",
    folderId: "child",
    name: "Model",
    schema: {},
  });
  const before = structuredClone(p.dictionary);
  saveModelFolder(p, "child", {
    name: "Renamed",
    parentId: "parent",
    description: "Retained",
  });
  assert.equal(modelFolderPath(p.modelFolders, "child"), "Parent / Renamed");
  assert.deepEqual(p.dictionary, before);
});

test("invalid folder moves/edits and nonempty deletion reject atomically; empty removal is precise", () => {
  const p = {
    modelFolders: [
      { id: "p", name: "Parent" },
      { id: "c", name: "Child", parentId: "p" },
      { id: "e", name: "Empty" },
    ],
    dictionary: [{ id: "m", name: "Model", folderId: "c", schema: {} }],
  };
  for (const act of [
    () => saveModelFolder(p, "p", { name: "Parent", parentId: "c" }),
    () => saveModelFolder(p, "c", { name: "" }),
    () => saveModelFolder(p, "c", { name: "Child", parentId: "missing" }),
    () => removeEmptyModelFolder(p, "p"),
    () => removeEmptyModelFolder(p, "c"),
  ]) {
    const before = structuredClone(p);
    assert.throws(act);
    assert.deepEqual(p, before);
  }
  removeEmptyModelFolder(p, "e");
  assert.deepEqual(
    p.modelFolders.map((f) => f.id),
    ["p", "c"],
  );
  assert.equal(p.dictionary.length, 1);
});
