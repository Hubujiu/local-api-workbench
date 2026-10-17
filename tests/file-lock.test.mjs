import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireFileLock } from "../src/file-lock.mjs";
test("orphaned writer lock recovers without deleting project data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "project.lock");
  await mkdir(lock);
  await writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: 2147483647, nonce: "orphan" }),
  );
  await writeFile(path.join(root, "project.json"), "safe");
  const release = await acquireFileLock(lock);
  assert.equal(
    JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).pid,
    process.pid,
  );
  await release();
  assert.equal(await readFile(path.join(root, "project.json"), "utf8"), "safe");
});
