import assert from "node:assert/strict";
import test from "node:test";
import {
  recentSavedTrashAvailable,
  recentSavedTrashTargets,
} from "../public/recent-saved-trash.js";

const state = { dirty: false, busy: false, saving: false };
const fixture = () => {
  const rows = ["first", "second"].map((id) => ({
    requestId: id,
    name: id,
    method: "GET",
    currentCreatedAt: "2026-11-22T02:00:00.000Z",
    version: 2,
  }));
  const project = {
    id: "owner",
    configRevision: 3,
    requests: [
      ...rows.map(({ requestId, name, method }) => ({
        id: requestId,
        name,
        method,
      })),
      { id: "unseen" },
    ],
  };
  const visible = {
    projectId: project.id,
    configRevision: 3,
    tracked: 2,
    untracked: 1,
    rows,
  };
  return { project, visible, latest: structuredClone(visible) };
};

test("eligible current results return only uniquely selected active draft rows, without touching other fields", () => {
  const { project, visible, latest } = fixture();
  const before = structuredClone(project);
  assert.deepEqual(
    recentSavedTrashTargets(
      project,
      ["second", "first"],
      visible,
      latest,
      state,
    ),
    [project.requests[1], project.requests[0]],
  );
  assert.deepEqual(project, before);
});

test("rejects dirty/archived/native/other-owner or stale receipts and non-visible or altered requests", () => {
  const checks = [
    ({ project }) => {
      project.archived = true;
    },
    ({ project }) => {
      project.settings = { nativeInheritance: true };
    },
    ({ visible }) => {
      visible.projectId = "another owner";
    },
    ({ latest }) => {
      latest.configRevision++;
    },
    ({ latest }) => {
      latest.rows[1].version++;
    },
    ({ latest }) => {
      latest.rows[1].currentCreatedAt = "2026-11-22T03:00:00.000Z";
    },
    ({ latest }) => {
      latest.rows[1].requestId = "unseen";
    },
    ({ project }) => {
      project.requests[1].deletedAt = "already deleted";
    },
    ({ project }) => {
      project.requests[1].name = "unexpected local name";
    },
    ({ project }) => {
      project.requests.push({ ...project.requests[1] });
    },
  ];
  for (const change of checks) {
    const data = fixture();
    change(data);
    const { project, visible, latest } = data;
    const before = structuredClone(project);
    assert.throws(() =>
      recentSavedTrashTargets(
        project,
        ["first", "second"],
        visible,
        latest,
        state,
      ),
    );
    assert.deepEqual(project, before);
  }
  const { project, visible, latest } = fixture();
  for (const flag of Object.keys(state)) {
    const inactive = { ...state, [flag]: true };
    assert.equal(recentSavedTrashAvailable(project, visible, inactive), false);
    assert.throws(() =>
      recentSavedTrashTargets(project, ["first"], visible, latest, inactive),
    );
  }
  for (const ids of [[], ["unseen"], ["first", "first"]])
    assert.throws(() =>
      recentSavedTrashTargets(project, ids, visible, latest, state),
    );
});
