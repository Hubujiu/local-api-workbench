import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";

const sessionId = "test-host:owner";
const input = (name = "imported") => ({
  format: "auto",
  document: {
    requests: [{ name, method: "GET", url: "https://example.invalid/items" }],
  },
  selection: { mode: "all" },
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "manual-import-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("target");
  return { root, store, project };
}
async function preview(store, id, value) {
  const result = await store.previewManualImport(id, value, { sessionId });
  assert.deepEqual(result.blockers, []);
  assert.equal(typeof result.token, "string");
  return result;
}
async function noJournal(store, id) {
  await assert.rejects(
    readFile(path.join(store.directory(id), ".transaction.json")),
    { code: "ENOENT" },
  );
}

test("two independent Stores accept one same-revision token exactly once and preserve newer activity", async (t) => {
  const { root, store, project } = await fixture(t),
    value = input();
  const p = await preview(store, project.id, value);
  await store.append(project.id, "history", {
    id: "latest-activity",
    status: "passed",
  });
  const results = await Promise.allSettled(
    [store, new Store(root)].map((s) =>
      s.applyManualImport(
        project.id,
        { token: p.token, input: value },
        { sessionId },
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const saved = await store.get(project.id);
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.history[0].id, "latest-activity");
  assert.equal(saved.configRevision, project.configRevision + 1);
  await noJournal(store, project.id);
});

test("configuration changes without revision bumps and different host sessions invalidate preview", async (t) => {
  const { store, project } = await fixture(t),
    value = input();
  const p = await preview(store, project.id, value);
  await assert.rejects(
    store.applyManualImport(
      project.id,
      { token: p.token, input: value },
      { sessionId: "other-host" },
    ),
  );
  const file = path.join(store.directory(project.id), "project.json"),
    metadata = JSON.parse(await readFile(file, "utf8"));
  metadata.name = "external configuration edit";
  await writeFile(file, JSON.stringify(metadata));
  await assert.rejects(
    store.applyManualImport(
      project.id,
      { token: p.token, input: value },
      { sessionId },
    ),
  );
  assert.equal((await store.get(project.id)).requests.length, 0);
  await noJournal(store, project.id);
});

test("cancellation and expiration after waiting for the lock cannot publish", async (t) => {
  for (const mode of ["cancel", "expire"]) {
    const { store, project } = await fixture(t),
      value = input();
    const p = await preview(store, project.id, value);
    const release = await acquireFileLock(store.lockFile(project.id));
    const controller = new AbortController(),
      originalNow = Date.now;
    let task;
    try {
      task = store.applyManualImport(
        project.id,
        { token: p.token, input: value },
        { sessionId, signal: controller.signal },
      );
      const rejected = assert.rejects(task);
      if (mode === "cancel") controller.abort();
      else Date.now = () => p.expiresAt;
      await release();
      await rejected;
    } finally {
      Date.now = originalNow;
    }
    assert.equal((await store.get(project.id)).requests.length, 0);
    await noJournal(store, project.id);
  }
});

test("journal temporary-write cancellation and expiration execute the final publication gate", async (t) => {
  for (const mode of ["cancel", "expire"]) {
    const { store, project } = await fixture(t),
      value = input(),
      p = await preview(store, project.id, value);
    const controller = new AbortController(),
      originalWrite = fs.promises.writeFile,
      originalNow = Date.now;
    let gated = 0;
    fs.promises.writeFile = async function (file, ...args) {
      const result = await originalWrite.call(this, file, ...args);
      if (
        String(file).includes(".transaction.json.") &&
        String(file).endsWith(".tmp")
      ) {
        gated++;
        if (mode === "cancel") controller.abort();
        else Date.now = () => p.expiresAt;
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        store.applyManualImport(
          project.id,
          { token: p.token, input: value },
          { sessionId, signal: controller.signal },
        ),
      );
    } finally {
      fs.promises.writeFile = originalWrite;
      Date.now = originalNow;
      syncBuiltinESMExports();
    }
    assert.equal(gated, 1);
    assert.equal((await store.get(project.id)).requests.length, 0);
    await noJournal(store, project.id);
  }
});

test("failure after journal publication reports unknown outcome and recovery rolls forward once", async (t) => {
  const { root, store, project } = await fixture(t),
    value = input(),
    p = await preview(store, project.id, value);
  const originalRename = fs.promises.rename;
  let published = false;
  fs.promises.rename = async function (from, to) {
    const result = await originalRename.call(this, from, to);
    if (String(to).endsWith(".transaction.json")) {
      published = true;
      throw Error("injected after-publication failure");
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      store.applyManualImport(
        project.id,
        { token: p.token, input: value },
        { sessionId },
      ),
      { code: "PROJECT_COMMIT_UNCERTAIN" },
    );
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(published, true);
  const recovered = await new Store(root).get(project.id);
  assert.equal(recovered.requests.length, 1);
  assert.equal(recovered.configRevision, project.configRevision + 1);
  assert.deepEqual(await new Store(root).get(project.id), recovered);
  await assert.rejects(
    store.applyManualImport(
      project.id,
      { token: p.token, input: value },
      { sessionId },
    ),
  );
  await noJournal(store, project.id);
});

test("API overwrite previews the same Store history owner and archives the exact prior definition", async (t) => {
  const { store, project } = await fixture(t);
  project.requests = [
    normalizeRequest({
      id: "existing",
      name: "old",
      method: "GET",
      url: "https://example.invalid/items",
      auth: { type: "bearer", token: "old-secret" },
    }),
  ];
  await store.save(project);
  const old = JSON.parse(JSON.stringify(project.requests[0]));
  const value = input("new");
  value.policies = { api: "url" };
  const p = await preview(store, project.id, value);
  assert.equal(p.historyImpact.addedSnapshots, 1);
  await store.applyManualImport(
    project.id,
    { token: p.token, input: value },
    { sessionId },
  );
  const saved = await store.get(project.id),
    lineage = saved.requestDefinitionHistory.entries.find(
      (e) => e.requestId === "existing",
    );
  assert.equal(saved.requests[0].id, "existing");
  assert.equal(saved.requests[0].name, "new");
  assert.deepEqual(lineage.versions.at(-1).definition, old);
});

function worker(t, root, id, mode, name) {
  const child = fork(
    fileURLToPath(
      new URL("./fixtures/manual-import-store-worker.mjs", import.meta.url),
    ),
    [root, id, mode, name],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  });
  const messages = [],
    waiters = [];
  child.on("message", (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("worker timed out: " + stderr)),
            10000,
          );
          waiters.push((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        });
  return { child, next, exit };
}

test(
  "different processes race with their own valid same-revision previews, not invalid cross-host signatures",
  { timeout: 20000 },
  async (t) => {
    const { root, store, project } = await fixture(t);
    const a = worker(t, root, project.id, "race", "A"),
      b = worker(t, root, project.id, "race", "B");
    for (const p of await Promise.all([a.next(), b.next()])) {
      assert.equal(p.type, "ready");
      assert.equal(p.configRevision, project.configRevision);
    }
    a.child.send({ go: true });
    b.child.send({ go: true });
    const results = await Promise.all([a.next(), b.next()]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    for (const result of await Promise.all([a.exit, b.exit]))
      assert.equal(result.code, 0, result.stderr);
    const saved = await store.get(project.id);
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.configRevision, project.configRevision + 1);
    await noJournal(store, project.id);
  },
);

test(
  "real process exit holding a published import journal recovers the complete transaction exactly once",
  { timeout: 20000 },
  async (t) => {
    const { root, store, project } = await fixture(t),
      child = worker(t, root, project.id, "crash", "after crash");
    assert.equal((await child.next()).type, "ready");
    child.child.send({ go: true });
    assert.equal((await child.exit).code, 23);
    const journal = JSON.parse(
      await readFile(
        path.join(store.directory(project.id), ".transaction.json"),
        "utf8",
      ),
    );
    const recovered = await new Store(root).get(project.id);
    assert.equal(recovered.requests[0].name, "after crash");
    assert.equal(recovered.configRevision, project.configRevision + 1);
    assert.deepEqual(
      recovered.requestDefinitionHistory,
      journal.requestDefinitionHistory,
    );
    assert.deepEqual(await new Store(root).get(project.id), recovered);
    await noJournal(store, project.id);
  },
);
