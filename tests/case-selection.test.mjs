import test from "node:test";
import assert from "node:assert/strict";
import {
  moveSelectedCases,
  deleteSelectedCases,
} from "../public/case-selection.js";
function fixture() {
  return {
    requests: [{ id: "api" }, { id: "other" }],
    caseFolders: [
      { id: "group", name: "Group", sourceRequestId: "api" },
      { id: "other-group", name: "Other", sourceRequestId: "other" },
    ],
    cases: [
      { id: "a", name: "A", sourceRequestId: "api", request: { body: "one" } },
      { id: "b", name: "B", sourceRequestId: "api", request: { body: "two" } },
      {
        id: "c",
        name: "Other",
        sourceRequestId: "other",
        request: { body: "other" },
      },
    ],
    history: [{ caseId: "a", response: "evidence" }],
  };
}
test("batch case moves preserve snapshots and unrelated cases", () => {
  const p = fixture(),
    before = structuredClone(p);
  moveSelectedCases(p, "api", ["a", "b"], "group");
  assert.deepEqual(
    p.cases.slice(0, 2).map((c) => c.folderId),
    ["group", "group"],
  );
  assert.deepEqual(
    p.cases.map((c) => c.request),
    before.cases.map((c) => c.request),
  );
  assert.deepEqual(p.cases[2], before.cases[2]);
  moveSelectedCases(p, "api", ["a"], "");
  assert.equal(p.cases[0].folderId, "");
  assert.equal(p.cases[1].folderId, "group");
});
test("batch deletion keeps folders, other APIs and historical evidence", () => {
  const p = fixture(),
    before = structuredClone(p);
  deleteSelectedCases(p, "api", ["b", "a"]);
  assert.deepEqual(p.cases, [before.cases[2]]);
  assert.deepEqual(p.caseFolders, before.caseFolders);
  assert.deepEqual(p.history, before.history);
});
test("invalid selections and cross-interface moves do not partially change cases", () => {
  for (const [ids, folder] of [
    [[], "group"],
    [["a", "a"], "group"],
    [["a", "missing"], "group"],
    [["a", "c"], "group"],
    [["a"], "other-group"],
    [["a"], "missing"],
  ]) {
    const p = fixture(),
      before = structuredClone(p);
    assert.throws(() => moveSelectedCases(p, "api", ids, folder));
    assert.deepEqual(p, before);
  }
  for (const ids of [["a", "missing"], ["c"], []]) {
    const p = fixture(),
      before = structuredClone(p);
    assert.throws(() => deleteSelectedCases(p, "api", ids));
    assert.deepEqual(p, before);
  }
});
