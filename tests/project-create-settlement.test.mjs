import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectCreationFlow,
  projectCreateCheckpoint,
  validateCreatedProject,
  validateProjectRegistry,
} from "../public/project-create-settlement.js";

test("ambiguous create survives reload and never starts another attempt implicitly", () => {
  const state = new Map();
  const storage = {
    getItem: (key) => state.get(key),
    setItem: (key, value) => state.set(key, value),
    removeItem: (key) => state.delete(key),
  };
  const first = createProjectCreationFlow(storage);
  const attempt = first.begin();
  assert.deepEqual([...state], [[projectCreateCheckpoint, "1"]]);
  assert.equal(first.begin(), null);
  first.phase(attempt, "checking");
  assert.equal(first.current.phase, "checking");
  const afterReload = createProjectCreationFlow(storage);
  assert.equal(afterReload.current.phase, "review");
  assert.equal(afterReload.begin(), null);
  assert.equal(afterReload.release(attempt), false);
  assert.equal(afterReload.release(afterReload.current), true);
  assert.equal(state.size, 0);
  assert(afterReload.begin());
});

test("creation requires a new identified receipt and a healthy registry match", () => {
  const value = {
    id: "created-id",
    name: "新项目",
    requests: [],
    environments: [{}],
    configRevision: 1,
    _diskFingerprint: "fingerprint",
  };
  const registered = new Set(["prior-id"]);
  assert.deepEqual(validateCreatedProject(value, { name: "" }, registered), {
    id: value.id,
    name: value.name,
  });
  for (const patch of [
    { id: "prior-id" },
    { id: "bad/id" },
    { name: "other" },
    { requests: [{}] },
    { archived: true },
    { description: "unexpected" },
    { configRevision: 0 },
    { _diskFingerprint: "" },
  ]) {
    assert.throws(
      () =>
        validateCreatedProject(
          { ...value, ...patch },
          { name: "" },
          registered,
        ),
      /回执/,
    );
  }
  const row = { id: value.id, name: value.name };
  assert.deepEqual(validateProjectRegistry([row], value), [row]);
  for (const invalid of [
    [row, row],
    [],
    [{ ...row, error: "unavailable" }],
    [{ ...row, archived: true }],
  ]) {
    assert.throws(() => validateProjectRegistry(invalid, value), /项目列表/);
  }
});
