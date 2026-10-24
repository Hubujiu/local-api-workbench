import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelCards, validateModelFolders } from "../public/model-folders.js";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

test("model groups escape names, preserve original action indexes and reject invalid hierarchy", () => {
  const p = {
    modelFolders: [
      { id: "f", name: "<folder>", parentId: "" },
      { id: "empty", name: "Empty", parentId: "f" },
    ],
    dictionary: [
      { id: "a", name: "<model>", folderId: "f", schema: {} },
      { id: "b", name: "Root", schema: {} },
    ],
  };
  const html = modelCards(p);
  assert(html.includes("&lt;folder&gt;"));
  assert(!html.includes("<model>"));
  assert(html.includes("空模型目录"));
  assert(
    html.indexOf('data-edit-dictionary="1"') <
      html.indexOf('data-edit-dictionary="0"'),
  );
  assert.throws(
    () => validateModelFolders({ ...p, modelFolders: [] }),
    /不存在/,
  );
  assert.throws(
    () =>
      validateModelFolders({
        modelFolders: [{ id: "f", name: "x", parentId: "f" }],
      }),
    /循环/,
  );
});

test("modern model folders survive save/reload and backup while conflicting imports remain atomic", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const p = await store.create("Folders"),
    source = modernApipostFixture();
  source.models = [
    { model_id: "f", model_type: "folder", name: "Group" },
    { model_id: "empty", model_type: "folder", name: "Empty", parent_id: "f" },
    {
      model_id: "m",
      model_type: "model",
      name: "Model",
      parent_id: "f",
      schema: { type: "string" },
    },
  ];
  importIntoProject(p, source);
  await store.save(p);
  const loaded = await store.get(p.id);
  assert.deepEqual(loaded.modelFolders, p.modelFolders);
  assert.equal(loaded.dictionary[0].folderId, loaded.modelFolders[0].id);
  assert.deepEqual(restoreProject(loaded).modelFolders, loaded.modelFolders);
  const before = structuredClone(p);
  source.models[0].name = "Conflicting rename";
  assert.throws(() => importIntoProject(p, source), /冲突/);
  assert.deepEqual(p, before);
  source.models[0].name = "Group";
  source.models[0].parent_id = "missing";
  assert.throws(() => importIntoProject(p, source), /父目录/);
  assert.deepEqual(p, before);
});
