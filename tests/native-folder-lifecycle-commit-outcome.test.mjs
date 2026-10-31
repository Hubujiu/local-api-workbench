import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { validateNativeInheritanceProject } from "../src/native-inheritance.mjs";
import { validateAPIResourceTrash } from "../src/api-resource-lifecycle.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

// Root-combination acceptance only. Real Store, locks, journal, filesystem and
// owner HTTP remain in use; the hook inserts a test-owned path obstruction only
// after the original locked read, as in mcp-project-roundtrip-storage.test.mjs.
// No failure/result is fabricated and no uncertain mutation is replayed.
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const business = (p) => {
  const copy = structuredClone(p);
  delete copy._diskFingerprint;
  return copy;
};
const graph = (p) => p.settings.nativeInheritance;
function installFault(store, projectId, operationType, phase) {
  const save = store.save;
  const directory = store.directory(projectId);
  const journal = path.join(directory, ".transaction.json");
  const history = path.join(directory, "history");
  const keptHistory = path.join(directory, "history-kept");
  const evidence = { attempts: 0, reads: 0, error: undefined, armed: true };
  store.save = async function (value, options) {
    if (
      value.id !== projectId ||
      options?.nativeInheritanceEdit?.type !== operationType
    )
      return save.call(this, value, options);
    evidence.attempts++;
    const originalRead = this.readUnlocked;
    if (evidence.armed) {
      evidence.armed = false;
      this.readUnlocked = async function (...args) {
        const previous = await originalRead.apply(this, args);
        if (args[0] !== projectId) return previous;
        this.readUnlocked = originalRead;
        evidence.reads++;
        evidence.oldRevision = previous.revision;
        if (phase === "before-journal") {
          // writeJSON's read of the destination fails before publishing any
          // transaction. Directory contents make ownership visibly test-only.
          await mkdir(journal);
          await writeFile(
            path.join(journal, "test-owned"),
            "pre-journal obstacle",
          );
        } else {
          await rename(history, keptHistory);
          await writeFile(history, "test-owned ordinary file obstructs apply");
        }
        return previous;
      };
    }
    try {
      return await save.call(this, value, options);
    } catch (error) {
      evidence.error = error;
      throw error;
    } finally {
      this.readUnlocked = originalRead;
    }
  };
  return {
    evidence,
    directory,
    journal,
    history,
    keptHistory,
    uninstall() {
      store.save = save;
    },
    async repair() {
      if (phase === "before-journal") await rm(journal, { recursive: true });
      else {
        await rm(history);
        await rename(keptHistory, history);
      }
    },
  };
}

for (const phase of ["before-journal", "after-journal"])
  for (const type of ["recycle-folder", "restore-folder"])
    test(`owner ${type} ${phase} filesystem failure reconciles folder state without replay`, async (t) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "folder-commit-outcome-"),
      );
      let app = await createApp({ root, port: 0 });
      let fault;
      t.after(async () => {
        fault?.uninstall();
        app.server.closeAllConnections();
        await new Promise((resolve) => app.server.close(resolve));
        await rm(root, { recursive: true, force: true });
      });
      const call = async (route, body, expected = 200) => {
        const response = await fetch(app.url + "/api/" + route, {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify(result));
        return result;
      };
      const target = await app.store.create("Folder boundary target");
      const foreign = await app.store.create("Foreign unchanged");
      const source = nativeInheritanceFixture();
      source.apis[0].name = "A";
      source.apis.push({
        target_id: "child",
        target_type: "folder",
        name: "Child",
        parent_id: "folder",
        request: { auth: { type: "inherit" } },
      });
      source.apis.push({
        target_id: "sibling",
        target_type: "folder",
        name: "AB",
        parent_id: "0",
        request: { auth: { type: "inherit" } },
      });
      source.apis[1].parent_id = "child";
      const sourceBefore = structuredClone(source);
      let p = await call(`projects/${target.id}/import`, {
        document: source,
        inheritanceMode: "preserve",
      });
      assert.deepEqual(source, sourceBefore);
      const requestId = p.requests[0].id;
      await call(`projects/${p.id}/cases`, {
        name: "Frozen evidence",
        sourceRequestId: requestId,
        request: p.requests[0],
      });
      await call(`projects/${p.id}/plans`, {
        name: "Frozen plan",
        environmentId: p.environments[0].id,
        steps: [{ request: p.requests[0] }],
      });
      p = await app.store.get(p.id);
      if (type === "restore-folder") {
        p = await call(`projects/${p.id}/native-inheritance-edit`, {
          configRevision: p.configRevision,
          operation: { type: "recycle-folder", sourceId: "folder" },
        });
      }
      const before = structuredClone(p);
      const foreignBefore = await app.store.get(foreign.id);
      const operation =
        type === "recycle-folder"
          ? { type, sourceId: "folder" }
          : { type, batchId: graph(before).folderLifecycle.records[0].batchId };
      fault = installFault(app.store, p.id, type, phase);
      const receipt = await call(
        `projects/${p.id}/native-inheritance-edit`,
        { configRevision: p.configRevision, operation },
        400,
      );
      assert.equal(
        fault.evidence.attempts,
        1,
        "one owner action performs one save attempt",
      );
      assert.equal(
        fault.evidence.reads,
        1,
        "fault armed only after the real locked read",
      );
      assert.equal(fault.evidence.oldRevision, before.revision);
      fault.uninstall();
      let committed;
      if (phase === "before-journal") {
        assert(!(fault.evidence.error instanceof ProjectCommitUncertain));
        assert.notEqual(receipt.code, "PROJECT_COMMIT_UNCERTAIN");
        assert.equal(receipt.commit_outcome, undefined);
        assert.equal(
          (await stat(fault.journal)).isDirectory(),
          true,
          "no JSON transaction was published",
        );
        assert.equal(
          (await json(path.join(fault.directory, "project.json"))).revision,
          before.revision,
        );
        assert.deepEqual(
          await json(path.join(fault.directory, "settings", "project.json")),
          before.settings,
        );
      } else {
        assert(fault.evidence.error instanceof ProjectCommitUncertain);
        assert.equal(fault.evidence.error.projectId, p.id);
        assert.equal(receipt.code, "PROJECT_COMMIT_UNCERTAIN");
        assert.equal(receipt.project_id, p.id);
        assert.equal(receipt.commit_outcome, "unknown");
        assert.equal(receipt.retry_safe, false);
        assert.equal(JSON.stringify(receipt).includes(root), false);
        committed = await json(fault.journal);
        assert.equal(committed.revision, before.revision + 1);
        assert.equal(committed.configRevision, before.configRevision + 1);
        validateNativeInheritanceProject(committed);
        validateAPIResourceTrash(committed);
        assert.equal((await stat(fault.history)).isFile(), true);
        // Prove partial real application, not merely an invented unknown receipt.
        assert.deepEqual(
          await json(path.join(fault.directory, "settings", "project.json")),
          committed.settings,
        );
        assert.equal(
          (await json(path.join(fault.directory, "project.json"))).revision,
          before.revision,
        );
        await assert.rejects(
          new Store(root).get(p.id),
          (error) =>
            error instanceof ProjectCommitUncertain && error.projectId === p.id,
        );
        assert.deepEqual(
          await json(fault.journal),
          committed,
          "failed read cannot mint another batch/revision",
        );
      }
      assert.deepEqual(await app.store.get(foreign.id), foreignBefore);
      // Remove only the path owned by this fixture, reopen, and READ recovery.
      // In particular, do not retry either owner operation with a new revision.
      await fault.repair();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
      const recovered = await new Store(root).get(p.id);
      assert.deepEqual(business(recovered), business(committed || before));
      assert.deepEqual(await app.store.get(p.id), recovered);
      assert.deepEqual(
        await new Store(root).get(p.id),
        recovered,
        "second read is idempotent reconciliation",
      );
      await assert.rejects(readFile(fault.journal), { code: "ENOENT" });
      assert.equal(
        fault.evidence.attempts,
        1,
        "reopen/recovery never replays save",
      );
      assert.deepEqual(recovered.cases, before.cases);
      assert.deepEqual(recovered.plans, before.plans);
      assert.deepEqual(recovered.history, before.history);
      assert.deepEqual(recovered.runs, before.runs);
      assert.deepEqual(graph(recovered).folders, graph(before).folders);
      assert.deepEqual(graph(recovered).bindings, graph(before).bindings);
      validateNativeInheritanceProject(recovered);
      validateAPIResourceTrash(recovered);
      if (committed && type === "recycle-folder") {
        const record = graph(recovered).folderLifecycle.records[0];
        const batch = recovered.apiResourceTrash.batches[0];
        assert.equal(recovered.apiResourceTrash.batches.length, 1);
        assert.equal(record.batchId, batch.id);
        assert.equal(record.state, "recycled");
        assert.deepEqual(batch.selectedTargetIds, ["folder:A"]);
        assert.deepEqual([...batch.folderPaths].sort(), ["A", "A/Child"]);
        assert.deepEqual(batch.requestIds, [requestId]);
        assert.equal(recovered.requests[0].deletedAt, batch.deletedAt);
        assert.deepEqual(recovered.folders, ["AB"]);
      }
      if (committed && type === "restore-folder") {
        assert.deepEqual(recovered.apiResourceTrash, before.apiResourceTrash);
        assert.equal(
          graph(recovered).folderLifecycle.records[0].state,
          "restored",
        );
        assert.equal(Object.hasOwn(recovered.requests[0], "deletedAt"), false);
        assert.deepEqual([...recovered.folders].sort(), ["A", "A/Child", "AB"]);
      }
      assert.deepEqual(await new Store(root).get(foreign.id), foreignBefore);
      assert.deepEqual(source, sourceBefore);
    });
