import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireFileLock } from "../src/file-lock.mjs";
import { readProject, writeProject } from "../src/project-files.mjs";
import { reconcileRequestDefinitionHistory } from "../src/request-definition-history.mjs";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "history-process-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = {
    id: "project",
    revision: 1,
    requests: [
      { id: "api", name: "v1", url: "http://127.0.0.1:1/not-executed" },
    ],
    environments: [],
    plans: [],
    cases: [],
    protocols: [],
  };
  p.requestDefinitionHistory = reconcileRequestDefinitionHistory(undefined, p);
  await writeProject(path.join(root, p.id), p);
  return { root, p };
}
function worker(t, root, mode, name) {
  const child = fork(
    fileURLToPath(
      new URL(
        "./fixtures/definition-history-files-worker.mjs",
        import.meta.url,
      ),
    ),
    [root, "project", mode, name],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit.catch(() => {});
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
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
          const timeout = setTimeout(
            () => reject(Error("child message timeout: " + stderr)),
            10000,
          );
          waiters.push((message) => {
            clearTimeout(timeout);
            resolve(message);
          });
        });
  return { child, next, exit };
}

test(
  "real cross-process file locks serialize history plus current definition as a single journal",
  { timeout: 20000 },
  async (t) => {
    const { root, p } = await fixture(t);
    const a = worker(t, root, "edit", "v2"),
      b = worker(t, root, "edit", "v3");
    assert.equal((await a.next()).type, "ready");
    assert.equal((await b.next()).type, "ready");
    a.child.send({ type: "go" });
    b.child.send({ type: "go" });
    const results = await Promise.all([a.next(), b.next()]);
    assert.deepEqual(results.map((r) => r.revision).sort(), [2, 3]);
    for (const outcome of await Promise.all([a.exit, b.exit]))
      assert.equal(outcome.code, 0, outcome.stderr);
    const saved = await readProject(path.join(root, p.id), p.id),
      entry = saved.requestDefinitionHistory.entries[0];
    assert.equal(saved.revision, 3);
    assert.equal(entry.currentVersion, 3);
    assert.equal(entry.versions[0].definition.name, "v1");
    assert.deepEqual(
      [entry.versions[1].definition.name, saved.requests[0].name].sort(),
      ["v2", "v3"],
    );
    await assert.rejects(readFile(path.join(root, p.id, ".transaction.json")), {
      code: "ENOENT",
    });
  },
);

test(
  "a real process exits with the published history journal and held lock; restart rolls forward once",
  { timeout: 20000 },
  async (t) => {
    const { root, p } = await fixture(t),
      child = worker(t, root, "crash", "after crash");
    assert.equal((await child.next()).type, "ready");
    child.child.send({ type: "go" });
    assert.equal((await child.next()).type, "published");
    const exit = await child.exit;
    assert.equal(exit.code, 23, exit.stderr);
    const directory = path.join(root, p.id),
      journal = JSON.parse(
        await readFile(path.join(directory, ".transaction.json"), "utf8"),
      );
    assert.equal(journal.revision, 2);
    assert.equal(journal.requestDefinitionHistory.entries[0].currentVersion, 2);
    const release = await acquireFileLock(path.join(root, p.id + ".lock"));
    try {
      await rm(path.join(directory, "apis"));
      const recovered = await readProject(directory, p.id);
      assert.equal(recovered.requests[0].name, "after crash");
      assert.deepEqual(
        recovered.requestDefinitionHistory,
        journal.requestDefinitionHistory,
      );
      assert.deepEqual(await readProject(directory, p.id), recovered);
      await assert.rejects(
        readFile(path.join(directory, ".transaction.json")),
        { code: "ENOENT" },
      );
    } finally {
      await release();
    }
  },
);
