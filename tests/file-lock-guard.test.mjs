import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  rm,
  readFile,
  writeFile,
  stat,
  symlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { acquireFileLock } from "../src/file-lock.mjs";
const source = new URL("../src/file-lock.mjs", import.meta.url).href;
async function root(t) {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "guard-lock-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function child(t, code, args = []) {
  const p = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, ...args],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stderr = "";
  p.stderr.on("data", (b) => {
    stderr = (stderr + b).slice(-16000);
  });
  const exited = once(p, "exit");
  const messages = [],
    waiting = [];
  p.on("message", (m) => {
    if (waiting.length) waiting.shift().resolve(m);
    else messages.push(m);
  });
  p.on("exit", (code) => {
    for (const w of waiting.splice(0))
      w.reject(Error(`child exited ${code}: ${stderr}`));
  });
  t.after(async () => {
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await exited;
  });
  return {
    p,
    exited,
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise((resolve, reject) => waiting.push({ resolve, reject })),
  };
}

test(
  "guard survives owner crash, recovers receipt and persists updates across fresh processes",
  { timeout: 15000 },
  async (t) => {
    const dir = await root(t),
      lock = path.join(dir, "project.lock");
    const a = child(
      t,
      `import {acquireFileLock} from ${JSON.stringify(source)}; await acquireFileLock(process.argv[1]); process.send('held'); setInterval(()=>{},1000);`,
      [lock],
    );
    assert.equal(await a.next(), "held");
    const before = await stat(lock + ".guard.sqlite");
    a.p.kill("SIGKILL");
    await a.exited;
    await writeFile(path.join(dir, "counter"), "0");
    for (let i = 0; i < 3; i++) {
      const b = child(
        t,
        `import {acquireFileLock} from ${JSON.stringify(source)}; import {readFile,writeFile} from 'node:fs/promises'; const release=await acquireFileLock(process.argv[1]); const f=process.argv[2]; await writeFile(f,String(Number(await readFile(f,'utf8'))+1)); await release(); process.send('committed'); process.disconnect();`,
        [lock, path.join(dir, "counter")],
      );
      assert.equal(await b.next(), "committed");
      assert.equal((await b.exited)[0], 0);
    }
    assert.equal(await readFile(path.join(dir, "counter"), "utf8"), "3");
    assert.equal((await stat(lock + ".guard.sqlite")).ino, before.ino);
  },
);

test(
  "real guard contention aborts promptly without releasing the owner, then succeeds",
  { timeout: 10000 },
  async (t) => {
    const dir = await root(t),
      lock = path.join(dir, "project.lock");
    const owner = child(
      t,
      `import {acquireFileLock} from ${JSON.stringify(source)}; const release=await acquireFileLock(process.argv[1]); process.send('held'); process.on('message',async()=>{await release();process.send('released');process.disconnect();});`,
      [lock],
    );
    assert.equal(await owner.next(), "held");
    const controller = new AbortController();
    const pending = acquireFileLock(lock, { signal: controller.signal });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(pending);
    assert.equal(
      JSON.parse(await readFile(path.join(lock, "owner.json"))).pid,
      owner.p.pid,
    );
    // An independent SQLite connection must still see the owner's OS lock.
    const db = new DatabaseSync(lock + ".guard.sqlite", { timeout: 0 });
    assert.throws(
      () => db.exec("BEGIN IMMEDIATE"),
      (e) => e.errcode === 5,
    );
    db.close();
    owner.p.send("release");
    assert.equal(await owner.next(), "released");
    const release = await acquireFileLock(lock);
    await release();
    await release();
  },
);

test("different projects and cookie paths remain independent while a lock is held", async (t) => {
  const dir = await root(t),
    a = await acquireFileLock(path.join(dir, "a.json.lock"));
  try {
    const b = await acquireFileLock(path.join(dir, "b.json.lock"));
    const cookie = await acquireFileLock(path.join(dir, "cookies.lock"));
    await b();
    await cookie();
  } finally {
    await a();
  }
});

test("corrupt guard fails closed without deleting the legacy receipt or guard", async (t) => {
  const dir = await root(t),
    lock = path.join(dir, "project.lock");
  await writeFile(lock + ".guard.sqlite", "not a sqlite database");
  await assert.rejects(acquireFileLock(lock), (e) => e.errcode === 26);
  assert.equal(
    await readFile(lock + ".guard.sqlite", "utf8"),
    "not a sqlite database",
  );
});

test(
  "parent symlink aliases share the same local queue and persistent OS identity",
  { timeout: 10000 },
  async (t) => {
    const dir = await root(t),
      alias = dir + "-alias";
    try {
      await symlink(dir, alias, "junction");
    } catch (e) {
      if (e.code === "EPERM") return t.skip("symlink privilege unavailable");
      throw e;
    }
    t.after(() => rm(alias, { force: true }));
    const release = await acquireFileLock(path.join(dir, "project.lock"));
    const abort = new AbortController();
    const second = acquireFileLock(path.join(alias, "project.lock"), {
      signal: abort.signal,
    });
    abort.abort();
    await assert.rejects(second);
    const probe = child(
      t,
      `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);try{d.exec('BEGIN IMMEDIATE');process.send('unsafe');}catch(e){process.send(e.errcode);}finally{d.close();process.disconnect();}`,
      [path.join(dir, "project.lock.guard.sqlite")],
    );
    assert.equal(await probe.next(), 5);
    await release();
  },
);

for (const fault of ["abort-after-begin", "receipt-write", "release-remove"]) {
  test(
    `${fault} releases the real SQLite transaction and permits a fresh acquisition`,
    { timeout: 10000 },
    async (t) => {
      const dir = await root(t),
        lock = path.join(dir, "project.lock");
      const worker = child(
        t,
        `
      import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path';
      import {syncBuiltinESMExports} from 'node:module'; import {DatabaseSync} from 'node:sqlite';
      const lock=process.argv[1], fault=process.argv[2], controller=new AbortController();
      const exec=DatabaseSync.prototype.exec, write=fs.writeFile, rm=fs.rm; let injected=false;
      if(fault==='abort-after-begin') DatabaseSync.prototype.exec=function(sql){const r=exec.call(this,sql);if(sql==='BEGIN IMMEDIATE'&&!injected){injected=true;controller.abort();}return r;};
      if(fault==='receipt-write') fs.writeFile=async function(p,...args){if(p===path.join(lock,'owner.json')&&!injected){injected=true;throw Object.assign(Error('fixture write failure'),{code:'EIO'});}return write.call(this,p,...args);};
      if(fault==='release-remove') fs.rm=async function(p,...args){if(p===lock&&!injected){injected=true;throw Object.assign(Error('fixture remove failure'),{code:'EIO'});}return rm.call(this,p,...args);};
      syncBuiltinESMExports();
      const {acquireFileLock}=await import(${JSON.stringify(source)});
      if(fault==='release-remove') {const release=await acquireFileLock(lock);await assert.rejects(release(),{code:'EIO'});}
      else await assert.rejects(acquireFileLock(lock,{signal:controller.signal}),{code:fault==='abort-after-begin'?'ABORT_ERR':'EIO'});
      assert(injected);const probe=new DatabaseSync(lock+'.guard.sqlite',{timeout:0});probe.exec('BEGIN IMMEDIATE');probe.exec('ROLLBACK');probe.close();process.send('unlocked');process.disconnect();
    `,
        [lock, fault],
      );
      assert.equal(await worker.next(), "unlocked");
      assert.equal((await worker.exited)[0], 0);
      const release = await acquireFileLock(lock);
      await release();
    },
  );
}

test(
  "guard waiting and legacy owner waiting share one idle budget",
  { timeout: 7000 },
  async (t) => {
    const dir = await root(t),
      lock = path.join(dir, "project.lock");
    const holder = child(
      t,
      `import {DatabaseSync} from 'node:sqlite';import {mkdir,writeFile} from 'node:fs/promises'; const lock=process.argv[1];await mkdir(lock);await writeFile(lock+'/owner.json',JSON.stringify({pid:Number(process.argv[2]),nonce:'live-legacy'}));const db=new DatabaseSync(lock+'.guard.sqlite');db.exec('BEGIN IMMEDIATE');process.send('held');setTimeout(()=>{db.exec('ROLLBACK');db.close();process.disconnect();},1300);`,
      [lock, String(process.pid)],
    );
    assert.equal(await holder.next(), "held");
    const start = performance.now();
    await assert.rejects(acquireFileLock(lock), /其他进程/);
    const elapsed = performance.now() - start;
    assert(
      elapsed >= 1900 && elapsed < 3000,
      `shared idle budget elapsed ${elapsed}`,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(lock, "owner.json"))).nonce,
      "live-legacy",
    );
  },
);

test(
  "opening and closing a contender never revokes another SQLite connection OS lock",
  { timeout: 10000 },
  async (t) => {
    const dir = await root(t),
      lock = path.join(dir, "project.lock");
    const owner = new DatabaseSync(lock + ".guard.sqlite", { timeout: 0 });
    owner.exec("BEGIN IMMEDIATE");
    t.after(() => owner.close());
    const original = DatabaseSync.prototype.exec;
    let attempted;
    const barrier = new Promise((resolve) => {
      attempted = resolve;
    });
    DatabaseSync.prototype.exec = function (sql) {
      try {
        return original.call(this, sql);
      } catch (e) {
        if (this !== owner && sql === "BEGIN IMMEDIATE") attempted(e);
        throw e;
      }
    };
    t.after(() => {
      DatabaseSync.prototype.exec = original;
    });
    const abort = new AbortController(),
      pending = acquireFileLock(lock, { signal: abort.signal });
    const rejection = assert.rejects(pending, { code: "ABORT_ERR" });
    assert.equal((await barrier).errcode, 5);
    async function probe() {
      const p = child(
        t,
        `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{timeout:0});try{db.exec('BEGIN IMMEDIATE');process.send('unsafe');}catch(e){process.send(e.errcode);}finally{db.close();process.disconnect();}`,
        [lock + ".guard.sqlite"],
      );
      assert.equal(await p.next(), 5);
      assert.equal((await p.exited)[0], 0);
    }
    await probe();
    abort.abort();
    await rejection;
    assert.equal(owner.isTransaction, true);
    await probe();
    owner.exec("ROLLBACK");
    const release = await acquireFileLock(lock);
    await release();
  },
);

for (const nonce of [undefined, "", 123, "x".repeat(257)]) {
  test(`unrecognized dead-owner receipt stays intact (${typeof nonce}:${String(nonce).length})`, async (t) => {
    const dir = await root(t),
      lock = path.join(dir, "project.lock");
    await mkdir(lock);
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: 2147483647, nonce }),
    );
    await writeFile(path.join(lock, "sentinel"), "preserve");
    await assert.rejects(
      acquireFileLock(lock, { deadline: performance.now() + 80 }),
      { code: "REQUEST_TIMEOUT" },
    );
    assert.equal(
      await readFile(path.join(lock, "sentinel"), "utf8"),
      "preserve",
    );
  });
}

test(
  "canonicalization preserves FIFO even when asynchronous path lookup would complete out of order",
  { timeout: 10000 },
  async (t) => {
    const dir = await root(t),
      lock = path.join(dir, "project.lock");
    const worker = child(
      t,
      `
    import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    import {setImmediate as turn} from 'node:timers/promises';
    const original=fsp.realpath, sync=fs.realpathSync.native;
    let enabled=false,calls=0,unblock,thirdReady;
    const third=new Promise(resolve=>{thirdReady=resolve;});
    fsp.realpath=async function(...args){const number=enabled?++calls:0;const result=await original(...args);if(enabled){if(number===1)await new Promise(resolve=>{unblock=resolve;});else if(number===2)thirdReady();}return result;};
    fs.realpathSync.native=function(...args){const result=sync(...args);if(enabled&&++calls===2)thirdReady();return result;};
    syncBuiltinESMExports();
    const {acquireFileLock}=await import(${JSON.stringify(source)});
    const first=await acquireFileLock(process.argv[1]);enabled=true;
    const order=[];
    const second=acquireFileLock(process.argv[1]).then(async release=>{order.push('second');await release();});
    const last=acquireFileLock(process.argv[1]).then(async release=>{order.push('third');await release();});
    await third;if(unblock)unblock();await turn();await first();await Promise.all([second,last]);
    assert.deepEqual(order,['second','third']);process.send(order);process.disconnect();
  `,
      [lock],
    );
    assert.deepEqual(await worker.next(), ["second", "third"]);
    assert.equal((await worker.exited)[0], 0);
  },
);
