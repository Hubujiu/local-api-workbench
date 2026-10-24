import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameProgress } from "../src/rename-progress.mjs";

test("Windows progress replacement preserves old journal until transient contention clears", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "progress-rename-"));
  const source = path.join(dir, "new.tmp"),
    target = path.join(dir, "progress.json");
  try {
    await writeFile(source, "new");
    await writeFile(target, "old");
    let attempts = 0;
    const delays = [];
    await renameProgress(source, target, {
      platform: "win32",
      rename: async (from, to) => {
        assert.equal(from, source);
        assert.equal(to, target);
        assert.equal(await readFile(target, "utf8"), "old");
        if (++attempts < 3)
          throw Object.assign(Error("sharing violation"), { code: "EPERM" });
        await rename(from, to);
      },
      sleep: async (ms) => delays.push(ms),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.equal(await readFile(target, "utf8"), "new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`permanent Windows ${code} is bounded and preserves the original error`, async () => {
    const error = Object.assign(Error("denied"), { code });
    let attempts = 0;
    const delays = [];
    await assert.rejects(
      renameProgress("a", "b", {
        platform: "win32",
        rename: async () => {
          attempts++;
          throw error;
        },
        sleep: async (ms) => delays.push(ms),
      }),
      (actual) => actual === error,
    );
    assert.equal(attempts, 5);
    assert.deepEqual(delays, [10, 20, 40, 80]);
  });
}
for (const [platform, code] of [
  ["linux", "EPERM"],
  ["darwin", "EBUSY"],
  ["win32", "ENOENT"],
  ["win32", "ENOSPC"],
]) {
  test(`${platform} ${code} does not retry`, async () => {
    let attempts = 0;
    const error = Object.assign(Error(code), { code });
    await assert.rejects(
      renameProgress("a", "b", {
        platform,
        rename: async () => {
          attempts++;
          throw error;
        },
        sleep: async () => assert.fail("unexpected sleep"),
      }),
      (actual) => actual === error,
    );
    assert.equal(attempts, 1);
  });
}
