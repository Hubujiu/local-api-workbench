import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";
import {
  deleteAPIResources,
  validateAPIResourceTrash,
} from "../src/api-resource-lifecycle.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

// Root-combination acceptance: exercise the real owner route, Store, lock and
// journal. The hook adds only a test-owned filesystem obstruction after the
// original locked read; it does not fabricate errors or mutation results.
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const business = (p) => {
  const result = structuredClone(p);
  delete result._diskFingerprint;
  return result;
};
const close = async (server) => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
function installFault(store, projectId, phase) {
  const save = store.save;
  const directory = store.directory(projectId);
  const journal = path.join(directory, ".transaction.json");
  const history = path.join(directory, "history");
  const keptHistory = path.join(directory, "history-test-owned-kept");
  const evidence = { attempts: 0, reads: 0, contexts: [], armed: true };
  store.save = async function (value, options) {
    if (value.id !== projectId || !options?.apiResourceRestore)
      return save.call(this, value, options);
    evidence.attempts++;
    evidence.contexts.push(structuredClone(options.apiResourceRestore));
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
          await mkdir(journal);
          await writeFile(
            path.join(journal, "test-owned"),
            "prejournal obstacle",
          );
        } else {
          await rename(history, keptHistory);
          await writeFile(history, "test-owned file obstructs journal apply");
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
  test(`owner ordinary resource restore ${phase} reconciles without replay`, async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "resource-restore-outcome-"),
    );
    let app, fault;
    let executions = 0;
    const upstream = http.createServer((_req, res) => {
      executions++;
      res.end("unexpected execution");
    });
    t.after(async () => {
      fault?.uninstall();
      await close(app?.server);
      await close(upstream);
      await rm(root, { recursive: true, force: true });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    app = await createApp({ root, port: 0 });
    const call = async (id, body, expected = 200) => {
      const response = await fetch(
        `${app.url}/api/projects/${id}/api-resource-restore`,
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    let p = await app.store.create("Ordinary mixed batch");
    const foreign = await app.store.create("Unrelated project");
    const foreignBefore = await app.store.get(foreign.id);
    p.folders = [
      "Ancestor",
      "Ancestor/Tree",
      "Ancestor/Tree/Child",
      "Ancestor/Tree/Empty",
      "Ancestor/Sibling",
    ];
    p.requests = [
      normalizeRequest({
        id: "inside",
        name: "HTTP retained definition",
        method: "GET",
        url: `http://127.0.0.1:${upstream.address().port}/must-not-execute`,
        folder: "Ancestor/Tree/Child",
      }),
    ];
    p.documents = [
      {
        id: "guide",
        title: "Guide",
        content: "# 静态🌏 {{not-executed}}",
        folder: "Ancestor/Tree/Child",
        statusId: "draft",
        attributes: {},
        importNotes: ["test-owned"],
      },
    ];
    p.settings.recursiveFolderScopes = true;
    p.settings.folderParameters = {
      "Ancestor/Tree/Child": {
        headers: [{ key: "X-Folder", value: "retained", enabled: true }],
      },
    };
    p.settings.folderAuth = {
      "Ancestor/Tree/Child": {
        type: "bearer",
        token: "test-owned-not-a-secret",
      },
    };
    p.settings.folderScripts = {
      "Ancestor/Tree/Child": {
        enabled: true,
        beforeScript: 'throw new Error("restore must not execute scripts");',
      },
    };
    p.settings.folderServices = { "Ancestor/Tree/Child": "historical-binding" };
    p.plans = [
      snapshotPlan({
        id: "frozen-plan",
        name: "Frozen plan",
        steps: [{ id: "frozen-step", request: p.requests[0] }],
      }),
    ];
    p.cases = [
      snapshotCase({
        id: "frozen-case",
        name: "Frozen case",
        sourceRequestId: "inside",
        request: p.requests[0],
      }),
    ];
    await app.store.save(p);
    const configured = await app.store.get(p.id);
    await app.store.save(
      deleteAPIResources(configured, ["folder:Ancestor/Tree"]).project,
    );
    const before = await app.store.get(p.id);
    const batch = structuredClone(before.apiResourceTrash.batches[0]);
    assert.equal(before.documents.length, 0);
    assert.equal(before.requests[0].deletedAt, batch.deletedAt);
    assert.deepEqual(batch.requestIds, ["inside"]);
    assert.deepEqual(batch.documents, configured.documents);
    fault = installFault(app.store, p.id, phase);
    const metadataBefore = await json(
      path.join(fault.directory, "project.json"),
    );
    const receipt = await call(
      p.id,
      { configRevision: before.configRevision, batchId: batch.id },
      400,
    );
    assert.equal(fault.evidence.attempts, 1);
    assert.equal(fault.evidence.reads, 1);
    assert.equal(fault.evidence.oldRevision, before.revision);
    assert.equal(fault.evidence.contexts.length, 1);
    const context = fault.evidence.contexts[0];
    assert.equal(context.batchId, batch.id);
    assert.equal(
      new Date(context.restoredAt).toISOString(),
      context.restoredAt,
    );
    let committed;
    if (phase === "before-journal") {
      assert(!(fault.evidence.error instanceof ProjectCommitUncertain));
      assert.notEqual(receipt.code, "PROJECT_COMMIT_UNCERTAIN");
      assert.equal(receipt.commit_outcome, undefined);
      assert.equal(receipt.retry_safe, undefined);
      assert.equal((await stat(fault.journal)).isDirectory(), true);
      assert.deepEqual(
        await json(path.join(fault.directory, "project.json")),
        metadataBefore,
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
      assert.equal(
        committed.apiResourceTrash.batches[0].restoredAt,
        context.restoredAt,
      );
      validateAPIResourceTrash(committed);
      assert.equal((await stat(fault.history)).isFile(), true);
      // project-files applies HTTP/settings BEFORE history, documents/folders
      // AFTER history, and apiResourceTrash in the final project.json metadata.
      assert.deepEqual(
        await json(path.join(fault.directory, "settings", "project.json")),
        committed.settings,
      );
      assert.notDeepEqual(committed.settings, before.settings);
      const requestFiles = await readdir(path.join(fault.directory, "apis"));
      assert.equal(requestFiles.length, 1);
      assert.deepEqual(
        await json(path.join(fault.directory, "apis", requestFiles[0])),
        committed.requests[0],
      );
      assert.equal(Object.hasOwn(committed.requests[0], "deletedAt"), false);
      assert.deepEqual(
        await json(path.join(fault.directory, "settings", "documents.json")),
        before.documents,
      );
      assert.deepEqual(
        await json(path.join(fault.directory, "settings", "folders.json")),
        before.folders,
      );
      assert.deepEqual(
        await json(path.join(fault.directory, "project.json")),
        metadataBefore,
      );
      await assert.rejects(
        new Store(root).get(p.id),
        (error) =>
          error instanceof ProjectCommitUncertain && error.projectId === p.id,
      );
      assert.deepEqual(
        await json(fault.journal),
        committed,
        "failed read must not mint another revision or timestamp",
      );
    }
    assert.deepEqual(await app.store.get(foreign.id), foreignBefore);
    await fault.repair();
    fault.uninstall();
    await close(app.server);
    app = await createApp({ root, port: 0 });
    const recovered = await new Store(root).get(p.id);
    assert.deepEqual(business(recovered), business(committed || before));
    assert.deepEqual(await app.store.get(p.id), recovered);
    assert.deepEqual(
      await new Store(root).get(p.id),
      recovered,
      "second read is idempotent",
    );
    await assert.rejects(readFile(fault.journal), { code: "ENOENT" });
    assert.equal(
      fault.evidence.attempts,
      1,
      "recovery must not replay owner save",
    );
    assert.equal(fault.evidence.contexts.length, 1);
    for (const key of ["cases", "plans", "history", "runs", "protocolRuns"])
      assert.deepEqual(recovered[key], before[key], `${key} remains frozen`);
    if (committed) {
      assert.deepEqual(recovered.documents, configured.documents);
      assert.deepEqual(
        [...recovered.folders].sort(),
        [...configured.folders].sort(),
      );
      assert.deepEqual(recovered.settings, configured.settings);
      assert.deepEqual(recovered.requests, configured.requests);
      assert.deepEqual(recovered.apiResourceTrash.batches, [
        { ...batch, restoredAt: context.restoredAt },
      ]);
      await call(
        p.id,
        { configRevision: recovered.configRevision, batchId: batch.id },
        400,
      );
      assert.deepEqual(
        await app.store.get(p.id),
        recovered,
        "explicit duplicate restore cannot increment revision or rewrite history",
      );
      await assert.rejects(readFile(fault.journal), { code: "ENOENT" });
    } else {
      assert.deepEqual(recovered.apiResourceTrash.batches, [batch]);
      assert.equal(recovered.revision, before.revision);
      assert.equal(recovered.configRevision, before.configRevision);
    }
    validateAPIResourceTrash(recovered);
    assert.deepEqual(await new Store(root).get(foreign.id), foreignBefore);
    assert.equal(
      executions,
      0,
      "restore and recovery must not execute requests or frozen plans/cases",
    );
  });
