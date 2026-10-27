import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

test(
  "native graph Store save retains queued cancellation, unchanged disk and subsequent restore",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "graph-store-cancel-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root);
    const project = await store.create("graph"),
      other = await store.create("other");
    importIntoProject(project, nativeInheritanceFixture(), {
      inheritanceMode: "preserve",
    });
    await store.save(project);
    const before = await store.get(project.id),
      otherBefore = await store.get(other.id);
    const candidate = structuredClone(before);
    candidate.settings.nativeInheritance.projectLayer.headers[0].value =
      "candidate";
    const controller = new AbortController();
    const release = await acquireFileLock(store.lockFile(project.id));
    let settled = false;
    try {
      // save has already passed its synchronous entry check. The real project
      // lock prevents a write; cancellation must also be checked before commit.
      const pending = store.save(candidate, { signal: controller.signal });
      const outcome = pending.then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      controller.abort();
      await release();
      const error = await outcome;
      assert.equal(error?.code, "STORE_SAVE_ABORTED");
    } finally {
      await release();
    }
    const reopened = new Store(root);
    assert.deepEqual(await reopened.get(project.id), before);
    assert.deepEqual(await reopened.get(other.id), otherBefore);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      reopened.save(structuredClone(candidate), { signal: aborted.signal }),
      { code: "STORE_SAVE_ABORTED" },
    );
    assert.deepEqual(await reopened.get(project.id), before);
    // Cancellation must not poison the queue or turn a later explicit save into
    // an automatic retry of the cancelled candidate.
    const accepted = await reopened.get(project.id);
    accepted.settings.nativeInheritance.projectLayer.headers[0].value =
      "explicit-save";
    await reopened.save(accepted);
    const persisted = await reopened.get(project.id);
    assert.equal(
      persisted.settings.nativeInheritance.projectLayer.headers[0].value,
      "explicit-save",
    );
    const copy = restoreProject(persisted);
    await reopened.save(copy);
    const restarted = new Store(root);
    assert.deepEqual(
      (await restarted.get(copy.id)).settings.nativeInheritance,
      persisted.settings.nativeInheritance,
    );
    assert.deepEqual(await restarted.get(other.id), otherBefore);
  },
);
