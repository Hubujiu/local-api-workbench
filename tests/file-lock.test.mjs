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

test("lock turnover extends only the idle wait, while an unchanged live owner remains protected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-lock-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "project.lock"),
    owner = path.join(lock, "owner.json");
  await mkdir(lock);
  await writeFile(owner, JSON.stringify({ pid: process.pid, nonce: "turn-0" }));
  const turnover = (async () => {
    for (let i = 1; i <= 24; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(
        owner,
        JSON.stringify({ pid: process.pid, nonce: "turn-" + i }),
      );
    }
    await rm(lock, { recursive: true, force: true });
  })();
  let release;
  try {
    release = await acquireFileLock(lock);
  } finally {
    await turnover;
    await release?.();
  }
  await mkdir(lock);
  const unchanged = JSON.stringify({ pid: process.pid, nonce: "held" });
  await writeFile(owner, unchanged);
  const started = Date.now();
  await assert.rejects(acquireFileLock(lock), /其他进程/);
  assert(Date.now() - started >= 1900);
  assert(
    Date.now() - started < 5000,
    "unchanged owner does not receive the progress extension",
  );
  assert.equal(await readFile(owner, "utf8"), unchanged);
});

test("continuous live lock turnover still reaches the independent hard deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-lock-hard-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "project.lock"),
    owner = path.join(lock, "owner.json");
  await mkdir(lock);
  await writeFile(owner, JSON.stringify({ pid: process.pid, nonce: "turn-0" }));
  let stopped = false;
  const turnover = (async () => {
    for (let i = 1; !stopped; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!stopped)
        await writeFile(
          owner,
          JSON.stringify({ pid: process.pid, nonce: "turn-" + i }),
        );
    }
  })();
  const started = Date.now();
  try {
    await assert.rejects(acquireFileLock(lock), /其他进程/);
    assert(
      Date.now() - started >= 9500,
      "turnover cannot be mistaken for idle ownership",
    );
    assert(
      Date.now() - started < 14000,
      "turnover cannot renew the hard deadline",
    );
    stopped = true;
    await turnover;
    assert.equal(JSON.parse(await readFile(owner, "utf8")).pid, process.pid);
  } finally {
    stopped = true;
    await turnover;
  }
});

test(
  "cancelled queue slots retain predecessor ordering and do not poison healthy successors",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "api-lock-cancel-queue-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const lock = path.join(root, "project.lock"),
      first = await acquireFileLock(lock);
    t.after(first);
    const controller = new AbortController();
    const cancelled = assert.rejects(
      acquireFileLock(lock, { signal: controller.signal }),
      { code: "ABORT_ERR" },
    );
    controller.abort();
    await cancelled;
    const order = [];
    const second = acquireFileLock(lock).then(async (release) => {
      order.push("second");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await release();
    });
    const timeout = assert.rejects(
      acquireFileLock(lock, { deadline: performance.now() + 30 }),
      { code: "REQUEST_TIMEOUT" },
    );
    await timeout;
    const third = acquireFileLock(lock).then(async (release) => {
      order.push("third");
      await release();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(order, []);
    await first();
    await Promise.all([second, third]);
    assert.deepEqual(order, ["second", "third"]);
    const healthy = await acquireFileLock(lock);
    await healthy();
  },
);

for (const mode of ["abort", "deadline"]) {
  test(
    `cross-process disk wait ${mode} leaves the live owner untouched and a healthy successor works`,
    { timeout: 5000 },
    async (t) => {
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      const { createInterface } = await import("node:readline");
      const root = await mkdtemp(
        path.join(os.tmpdir(), "api-lock-cancel-process-"),
      );
      const lock = path.join(root, "project.lock");
      const source = `import {acquireFileLock} from ${JSON.stringify(new URL("../src/file-lock.mjs", import.meta.url).href)};
      const release = await acquireFileLock(process.argv[1]);
      const failSafe = setTimeout(async () => { await release(); process.exit(2); }, 3500);
      process.stdin.once('data', async () => { clearTimeout(failSafe); await release(); process.exit(0); });
      console.log('held');`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", source, lock],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      t.after(async () => {
        if (child.exitCode === null) child.stdin.end("release\n");
        await exited;
        await rm(root, { recursive: true, force: true });
      });
      const lines = createInterface({ input: child.stdout });
      const [ready] = await once(lines, "line");
      assert.equal(ready, "held");
      const ownerBefore = await readFile(path.join(lock, "owner.json"));
      const controller = new AbortController();
      const pending = acquireFileLock(lock, {
        signal: controller.signal,
        deadline: mode === "deadline" ? performance.now() + 60 : undefined,
      });
      const assertion = assert.rejects(pending, {
        code: mode === "abort" ? "ABORT_ERR" : "REQUEST_TIMEOUT",
      });
      if (mode === "abort") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        controller.abort();
      }
      await assertion;
      assert.deepEqual(
        await readFile(path.join(lock, "owner.json")),
        ownerBefore,
      );
      child.stdin.end("release\n");
      const [code] = await exited;
      assert.equal(code, 0);
      const release = await acquireFileLock(lock);
      await release();
    },
  );
}

test(
  "cancelled middle waiter never lets a new contender start disk acquisition ahead of its predecessor",
  { timeout: 8000 },
  async (t) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "api-lock-cancel-order-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    // Observe real mkdir calls in an isolated process. No lock behavior is mocked;
    // a successor attempting disk polling early is itself an invariant violation.
    const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    import {setTimeout as sleep} from 'node:timers/promises';
    import {acquireFileLock} from ${JSON.stringify(new URL("../src/file-lock.mjs", import.meta.url).href)};
    const lock = process.argv[1], original = fs.mkdir;
    let attempts = 0;
    fs.mkdir = async function (...args) {
      if (args[0] === lock) attempts++;
      return await Reflect.apply(original, this, args);
    };
    syncBuiltinESMExports();
    const releases = [];
    try {
      const first = await acquireFileLock(lock); releases.push(first);
      assert.equal(attempts, 1);
      const controller = new AbortController();
      const cancelled = assert.rejects(acquireFileLock(lock, {signal: controller.signal}), {code: 'ABORT_ERR'});
      const second = acquireFileLock(lock);
      controller.abort();
      await cancelled;
      const third = acquireFileLock(lock);
      await sleep(35);
      assert.equal(attempts, 1, 'no successor may touch disk while original predecessor holds');
      await first();
      const releaseSecond = await second; releases.push(releaseSecond);
      await sleep(35);
      assert.equal(attempts, 2, 'new contender must still wait behind the older healthy successor');
      await releaseSecond();
      const releaseThird = await third; releases.push(releaseThird);
      assert.equal(attempts, 3);
      await releaseThird();
      console.log(JSON.stringify({attempts, orderPreserved: true}));
    } finally {
      for (const release of releases) await release();
      fs.mkdir = original;
      syncBuiltinESMExports();
    }
  `;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", source, path.join(root, "project.lock")],
      { timeout: 6000, maxBuffer: 65536 },
    );
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { attempts: 3, orderPreserved: true });
  },
);
