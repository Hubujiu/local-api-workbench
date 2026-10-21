import test from "node:test";
import assert from "node:assert/strict";
import { folderTree, moveFolderTree } from "../public/folder-tree.js";
test("nested folders retain exact paths, implicit parents, and prefix isolation", () => {
  const roots = folderTree([
    "Orders/Recent/Today",
    "Orders/Archive",
    "Orders2",
    "Empty",
  ]);
  assert.deepEqual(
    roots.map((x) => x.path),
    ["Orders", "Orders2", "Empty"],
  );
  assert.equal(roots[0].children[0].children[0].path, "Orders/Recent/Today");
  assert.equal(roots[0].children[0].name, "Recent");
});
test("subtree rename moves all resource kinds and settings without changing snapshots", () => {
  const project = {
    folders: ["Orders", "Orders/Child", "Orders2"],
    requests: [{ folder: "Orders/Child" }],
    documents: [{ folder: "Orders" }],
    protocols: [{ folder: "Orders/Child" }],
    settings: {
      folderParameters: { "Orders/Child": { query: [] } },
      folderAuth: { Orders: { type: "none" } },
      folderScripts: { "Orders/Child": { beforeScript: "x" } },
      folderServices: { Orders: "s" },
    },
    plans: [{ steps: [{ request: { folder: "Orders/Child" } }] }],
  };
  const result = moveFolderTree(project, "Orders", "Sales");
  assert.deepEqual(result.folders, ["Sales", "Sales/Child", "Orders2"]);
  assert.equal(result.requests[0].folder, "Sales/Child");
  assert.equal(result.documents[0].folder, "Sales");
  assert.equal(result.protocols[0].folder, "Sales/Child");
  assert(result.settings.folderParameters["Sales/Child"]);
  assert.equal(result.settings.folderServices.Sales, "s");
  assert.equal(result.plans[0].steps[0].request.folder, "Orders/Child");
  assert.equal(project.requests[0].folder, "Orders/Child");
  const removed = moveFolderTree(project, "Orders", null);
  assert.equal(removed.requests[0].folder, "");
  assert.deepEqual(removed.folders, ["Orders2"]);
  assert.deepEqual(removed.settings.folderScripts, {});
});
test("subtree conflicts and invalid moves fail atomically including implicit destinations", () => {
  const p = { folders: ["A/B", "X/B"], requests: [], settings: {} };
  const before = JSON.stringify(p);
  assert.throws(() => moveFolderTree(p, "Missing", "New"), /不存在/);
  for (const next of ["X", "A/B", "../Z", "A//Z", "/Z", "Z/"])
    assert.throws(() => moveFolderTree(p, "A", next));
  assert.equal(JSON.stringify(p), before);
  assert.throws(() =>
    moveFolderTree(
      {
        folders: ["A"],
        settings: { folderAuth: { "Z/Child": { type: "none" } } },
      },
      "A",
      "Z",
    ),
  );
});
