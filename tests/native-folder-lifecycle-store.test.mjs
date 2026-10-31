import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { resolveNativeInheritance } from "../src/native-inheritance.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

// Definitions for ordinary CI only. Real files, Store locks and owner operations;
// barriers do not replace validation, journal writes or recovery. No server/VM.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "folder-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("Folder transaction");
  const source = nativeInheritanceFixture(),
    beforeSource = structuredClone(source);
  importIntoProject(p, source, { inheritanceMode: "preserve" });
  p.plans.push(
    versionPlan(
      undefined,
      {
        name: "Frozen before recycle",
        environmentId: p.environments[0].id,
        steps: [{ request: p.requests[0] }],
      },
      "manual",
      p,
    ),
  );
  await store.save(p);
  const foreign = await store.create("Foreign unchanged");
  assert.deepEqual(source, beforeSource);
  return {
    root,
    store,
    p: await store.get(p.id),
    foreign: await store.get(foreign.id),
  };
}
const recycle = { type: "recycle-folder", sourceId: "folder" };
const metadata = (p) => p.settings.nativeInheritance.folderLifecycle;
function checkFrozen(before, after) {
  for (const key of ["plans", "cases", "history", "runs"])
    assert.deepEqual(after[key], before[key], key + " remains unchanged");
  const frozen = after.plans[0].steps[0].request;
  assert.deepEqual(
    resolveNativeInheritance(after, frozen),
    frozen,
    "exact stored frozen request is still admitted without transport",
  );
}

async function race(root, id, configRevision, operation) {
  let release,
    arrivals = 0;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  class RacingStore extends Store {
    reads = 0;
    async get(key) {
      const result = await super.get(key);
      if (key === id) {
        this.reads++;
        assert.equal(result.configRevision, configRevision);
        if (++arrivals === 2) release();
        await ready;
      }
      return result;
    }
  }
  const a = new RacingStore(root),
    b = new RacingStore(root);
  const answers = await Promise.allSettled(
    [a, b].map((store) =>
      store.editNativeInheritance(id, {
        configRevision,
        operation: structuredClone(operation),
      }),
    ),
  );
  assert.equal(
    answers.filter((answer) => answer.status === "fulfilled").length,
    1,
  );
  assert.equal(
    answers.filter((answer) => answer.status === "rejected").length,
    1,
  );
  assert.equal(a.reads, 1, "loser must not reload and implicitly retry");
  assert.equal(b.reads, 1, "loser must not reload and implicitly retry");
  return new Store(root).get(id);
}

test(
  "two independent Stores serialize same-revision folder recycle and restore without replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      before = f.p;
    const deleted = await race(
      f.root,
      before.id,
      before.configRevision,
      recycle,
    );
    assert.equal(deleted.configRevision, before.configRevision + 1);
    assert.equal(deleted.revision, before.revision + 1);
    assert.equal(metadata(deleted).records.length, 1);
    assert.equal(deleted.apiResourceTrash.batches.length, 1);
    const entry = metadata(deleted).records[0];
    assert.equal(entry.state, "recycled");
    assert.ok(deleted.requests.every((request) => request.deletedAt));
    checkFrozen(before, deleted);
    assert.throws(
      () => resolveNativeInheritance(deleted, before.requests[0]),
      /回收/,
    );
    const restored = await race(f.root, before.id, deleted.configRevision, {
      type: "restore-folder",
      batchId: entry.batchId,
    });
    assert.equal(restored.configRevision, deleted.configRevision + 1);
    assert.equal(restored.revision, deleted.revision + 1);
    assert.equal(metadata(restored).records[0].state, "restored");
    assert.deepEqual(restored.apiResourceTrash, deleted.apiResourceTrash);
    assert.deepEqual(restored.requests, before.requests);
    checkFrozen(before, restored);
    assert.deepEqual(await new Store(f.root).get(f.foreign.id), f.foreign);
    await assert.rejects(
      f.store.editNativeInheritance(before.id, {
        configRevision: before.configRevision,
        operation: recycle,
      }),
      /修改|加载/,
    );
    assert.deepEqual(await new Store(f.root).get(before.id), restored);
  },
);

for (const phase of ["recycle", "restore"])
  test(
    `folder ${phase} real post-journal disk failure recovers one owner transaction without replay`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      if (phase === "restore")
        await f.store.editNativeInheritance(f.p.id, {
          configRevision: f.p.configRevision,
          operation: recycle,
        });
      const before = await f.store.get(f.p.id);
      const operation =
        phase === "recycle"
          ? recycle
          : {
              type: "restore-folder",
              batchId: metadata(before).records[0].batchId,
            };
      const directory = f.store.directory(before.id);
      const apis = path.join(directory, "apis"),
        held = path.join(directory, "apis-kept");
      const originalRead = f.store.readUnlocked.bind(f.store);
      let reads = 0,
        injected = false;
      // First read is owner admission; second is real lock-held commit validation.
      // Keep the original API files, then block apply's mkdir after journal publish.
      f.store.readUnlocked = async (...args) => {
        const value = await originalRead(...args);
        if (args[0] === before.id && ++reads === 2) {
          await rename(apis, held);
          await writeFile(apis, "fixture blocks API directory");
          injected = true;
        }
        return value;
      };
      try {
        await assert.rejects(
          f.store.editNativeInheritance(before.id, {
            configRevision: before.configRevision,
            operation,
          }),
        );
        assert.equal(injected, true);
        assert.equal(
          reads,
          2,
          "owner error must not trigger another read/write attempt",
        );
        const journal = JSON.parse(
          await readFile(path.join(directory, ".transaction.json"), "utf8"),
        );
        assert.equal(journal.configRevision, before.configRevision + 1);
        assert.equal(journal.revision, before.revision + 1);
        assert.equal(
          metadata(journal).records.at(-1).state,
          phase === "recycle" ? "recycled" : "restored",
        );
        checkFrozen(before, journal);
      } finally {
        f.store.readUnlocked = originalRead;
        if (injected) {
          await rm(apis);
          await rename(held, apis);
        }
      }
      // Reconcile by reading, never call the uncertain owner mutation again.
      const reopened = new Store(f.root),
        recovered = await reopened.get(before.id);
      assert.equal(recovered.configRevision, before.configRevision + 1);
      assert.equal(recovered.revision, before.revision + 1);
      assert.equal(recovered.apiResourceTrash.batches.length, 1);
      assert.equal(metadata(recovered).records.length, 1);
      assert.equal(
        metadata(recovered).records[0].state,
        phase === "recycle" ? "recycled" : "restored",
      );
      checkFrozen(before, recovered);
      assert.deepEqual(await reopened.get(before.id), recovered);
      await assert.rejects(
        readFile(path.join(directory, ".transaction.json")),
        { code: "ENOENT" },
      );
      assert.deepEqual(await reopened.get(f.foreign.id), f.foreign);
      if (phase === "recycle") {
        await reopened.editNativeInheritance(before.id, {
          configRevision: recovered.configRevision,
          operation: {
            type: "restore-folder",
            batchId: metadata(recovered).records[0].batchId,
          },
        });
        const restored = await new Store(f.root).get(before.id);
        assert.deepEqual(restored.requests, before.requests);
        assert.deepEqual(restored.apiResourceTrash, recovered.apiResourceTrash);
        checkFrozen(before, restored);
      }
    },
  );
