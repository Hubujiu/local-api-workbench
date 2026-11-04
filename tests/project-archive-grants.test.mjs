import test from "node:test";
import assert from "node:assert/strict";
import { saveProjectArchive } from "../src/project-archive-grants.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

// Only the save-outcome coordinator and Error class are imported, not Store,
// application, MCP, VM or database modules.
test("archive revocation waits for a successful save and uses current grants", async () => {
  let finish;
  let grants = ["p", "old"];
  const saved = { id: "p", archived: true, revision: 2 };
  const pending = saveProjectArchive(
    { id: "p", archived: true },
    () => new Promise((resolve) => (finish = resolve)),
    (id) => {
      grants = grants.filter((item) => item !== id);
    },
  );
  assert.deepEqual(grants, ["p", "old"]);
  grants = ["p", "new"];
  finish(saved);
  assert.equal(await pending, saved);
  assert.deepEqual(grants, ["new"]);
});

test("definite and foreign failures preserve grants and exact thrown identity without retry", async () => {
  for (const error of [
    Error("validation"),
    Error("configuration conflict"),
    Object.assign(Error("before journal"), { code: "EIO" }),
    Object.assign(Error("untrusted code"), {
      code: "PROJECT_COMMIT_UNCERTAIN",
      projectId: "p",
    }),
    new ProjectCommitUncertain("other", Error("foreign")),
    undefined,
  ]) {
    let saves = 0,
      revocations = 0;
    await assert.rejects(
      saveProjectArchive(
        { id: "p", archived: true },
        () => {
          saves++;
          throw error;
        },
        () => revocations++,
      ),
      (caught) => caught === error,
    );
    assert.equal(saves, 1);
    assert.equal(revocations, 0);
  }
});

test("same-project uncertain archive stays fail-closed and preserves its primary outcome", async () => {
  for (const observerThrows of [false, true]) {
    const error = new ProjectCommitUncertain("p", Error("after journal"));
    let saves = 0,
      ids = [];
    await assert.rejects(
      saveProjectArchive(
        { id: "p", archived: true },
        () => {
          saves++;
          throw error;
        },
        (id) => {
          ids.push(id);
          if (observerThrows) throw Error("secondary revocation failure");
        },
      ),
      (caught) => caught === error,
    );
    assert.equal(saves, 1);
    assert.deepEqual(ids, ["p"]);
  }
});

test("ordinary save and unarchive never grant or revoke authority on success or uncertainty", async () => {
  for (const archived of [undefined, false]) {
    let revocations = 0;
    const p = { id: "p", archived };
    assert.equal(
      await saveProjectArchive(
        p,
        () => p,
        () => revocations++,
      ),
      p,
    );
    const error = new ProjectCommitUncertain("p");
    await assert.rejects(
      saveProjectArchive(
        p,
        () => {
          throw error;
        },
        () => revocations++,
      ),
      (caught) => caught === error,
    );
    assert.equal(revocations, 0);
  }
});
