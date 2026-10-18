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

test("concurrent lock handoffs keep exactly one owner across repeated acquisitions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-lock-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "project.lock");
  let active = 0,
    completed = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      for (let i = 0; i < 10; i++) {
        const release = await acquireFileLock(lock);
        try {
          active++;
          assert.equal(active, 1);
          await readFile(path.join(lock, "owner.json"), "utf8");
          completed++;
        } finally {
          active--;
          await release();
        }
      }
    }),
  );
  assert.equal(completed, 100);
});

test("failed acquisition unblocks its local queue and duplicate release cannot remove a later owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-lock-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "missing"),
    lock = path.join(parent, "project.lock");
  await assert.rejects(acquireFileLock(lock), { code: "ENOENT" });
  await mkdir(parent);
  const first = await acquireFileLock(lock);
  await first();
  const second = await acquireFileLock(lock);
  await first();
  assert.equal(
    JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).pid,
    process.pid,
  );
  await second();
});
test("Windows delete-pending retry is restricted to mkdir EPERM, not general permission errors", async () => {
  const { isTransientWindowsLockMkdir } = await import("../src/file-lock.mjs");
  assert.equal(
    isTransientWindowsLockMkdir({ code: "EPERM", syscall: "mkdir" }, "win32"),
    true,
  );
  assert.equal(
    isTransientWindowsLockMkdir({ code: "EPERM", syscall: "open" }, "win32"),
    false,
  );
  assert.equal(
    isTransientWindowsLockMkdir({ code: "EACCES", syscall: "mkdir" }, "win32"),
    false,
  );
  assert.equal(
    isTransientWindowsLockMkdir({ code: "EPERM", syscall: "mkdir" }, "linux"),
    false,
  );
});

test("independent processes serialize read-modify-write through the disk lock", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await mkdtemp(path.join(os.tmpdir(), "api-lock-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "counter"), "0");
  const source = `
    import {readFile,writeFile} from 'node:fs/promises';
    import path from 'node:path';
    import {acquireFileLock} from ${JSON.stringify(new URL("../src/file-lock.mjs", import.meta.url).href)};
    const root=process.argv[1], started=Date.now();
    for(let i=0;i<20;i++){
      let release;
      try { release=await acquireFileLock(path.join(root,'counter.lock')); }
      catch(error) {
        let owner;
        try { owner=JSON.parse(await readFile(path.join(root,'counter.lock','owner.json'),'utf8')).pid; }
        catch(readError) { owner=readError.code || readError.message; }
        throw Error(JSON.stringify({pid:process.pid,iteration:i,elapsed:Date.now()-started,owner,counter:await readFile(path.join(root,'counter'),'utf8'),error:error.message}));
      }
      try{
        const value=Number(await readFile(path.join(root,'counter'),'utf8'));
        await new Promise(resolve=>setTimeout(resolve,2));
        await writeFile(path.join(root,'counter'),String(value+1));
      } finally {await release();}
    }
    console.log(JSON.stringify({pid:process.pid,completed:20,elapsed:Date.now()-started}));
  `;
  const processes = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", source, root],
        { timeout: 15000, maxBuffer: 65536 },
      ),
    ),
  );
  assert(
    processes.every((result) => result.status === "fulfilled"),
    JSON.stringify(
      processes.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : { error: result.reason.message, stderr: result.reason.stderr },
      ),
    ),
  );
  assert.equal(await readFile(path.join(root, "counter"), "utf8"), "40");
});
