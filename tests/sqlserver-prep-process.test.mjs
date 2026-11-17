// All execution fixtures use invented fake ports. No database, TCP or TLS.
import test from "node:test";
import { fork } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const src = new URL("../src/", import.meta.url);
const input = (mode = "success") => ({
  connection: {
    host: "fixture.invalid",
    user: "fixture",
    password: "IPC-ONLY-SENTINEL",
    database: mode,
    ssl: true,
  },
  sql: "SELECT id FROM dbo.items",
  parameters: [],
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function source(name) {
  return (await readFile(new URL(name, src), "utf8")).replace(
    /from "(\.\/[^\"]+)"/g,
    (_, p) => `from "${new URL(p, src).href}"`,
  );
}
async function setup(t, fake = false) {
  const dir = await mkdtemp(join(tmpdir(), "sqlserver-prep-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, "heartbeat.jsonl");
  let parent = await source("sqlserver-prep-process.mjs");
  if (fake) {
    await writeFile(
      join(dir, "fake-child.mjs"),
      `
      import { EventEmitter } from 'node:events';
      export let mode = 'success';
      export const children = [];
      export function setMode(m) { mode = m; }
      const result = {columns:['id'],rows:[{id:1}],truncated:false,limit:1000};
      export function fork(url, options) {
        const c = new EventEmitter(); c.connected = true; c.options = options; c.sends=[]; c.kills=0; children.push(c);
        c.send = (m, cb=()=>{}) => { c.sends.push(m); cb(); if(m.kind !== 'start') return;
          queueMicrotask(() => {
            if(mode === 'earlyExit') return c.emit('close', 1, null);
            if(mode === 'error') return c.emit('error', Error('PRIVATE DRIVER MESSAGE'));
            if(mode === 'totalTimeout') return;
            c.emit('message', {kind:'closing'});
            if(mode === 'success') { c.emit('message', {kind:'result', result}); c.emit('close',0,null); }
            if(mode === 'duplicate') { c.emit('message', {kind:'result', result}); c.emit('message', {kind:'result', result}); c.emit('close',0,null); }
          });
        };
        c.kill = () => { c.kills++; if(mode === 'throwKill') throw Error('private'); if(mode === 'noClose') return false;
          queueMicrotask(() => { c.emit('message', {kind:'result',result}); c.emit('close',0,'SIGKILL'); }); return true;
        }; return c;
      }
    `,
    );
    parent = parent.replace(
      'from "node:child_process"',
      'from "./fake-child.mjs"',
    );
  } else {
    let entry = await source("sqlserver-prep-process-entry.mjs");
    entry = entry.replace(
      '"./sqlserver-prep-execution-worker.mjs"',
      JSON.stringify(pathToFileURL(join(dir, "worker.mjs")).href),
    );
    await writeFile(join(dir, "entry.mjs"), entry);
    await writeFile(
      join(dir, "worker.mjs"),
      `
      import { parentPort, workerData } from 'node:worker_threads';
      import { appendFileSync } from 'node:fs';
      import { runCompiledSQLServerPreparation, SQLSERVER_READONLY_PROBE } from ${JSON.stringify(new URL("sqlserver-read-prep.mjs", src).href)};
      const marker = ${JSON.stringify(marker)};
      const mode = workerData.config.options.database;
      appendFileSync(marker, JSON.stringify({pid:process.pid,kind:'start'})+'\\n');
      const pulse = setInterval(()=>appendFileSync(marker,JSON.stringify({pid:process.pid,kind:'tick'})+'\\n'),20);
      const controller = new AbortController();
      parentPort.on('message', m=>{ if(m?.kind==='cancel') controller.abort(); });
      let end=false, socket=false, resolveClosed;
      const closed = new Promise(r=>resolveClosed=r);
      const settle=()=>{ if(end&&socket) resolveClosed(); };
      const port = { closed,
        connect:async()=>{ if(mode==='busy') while(true){} },
        query:async(plan,sink)=> {
          if(mode==='hangQuery' && plan.sql!==SQLSERVER_READONLY_PROBE) return new Promise(()=>{});
          sink.metadata([{name:plan.sql===SQLSERVER_READONLY_PROBE?'updateability':'id',type:plan.sql===SQLSERVER_READONLY_PROBE?'NVarChar':'Int'}]);
          sink.row([plan.sql===SQLSERVER_READONLY_PROBE?'READ_ONLY':1]);
        },
        destroy:()=> {
          if(mode!=='missingEnd'&&mode!=='missingBoth') setTimeout(()=>{end=true;settle();},10);
          if(mode!=='missingSocket'&&mode!=='missingBoth') setTimeout(()=>{socket=true;settle();},20);
        }
      };
      try {
        const result = await runCompiledSQLServerPreparation(workerData,{factory:()=>port,signal:controller.signal,onClosing:()=>parentPort.postMessage({kind:'closing'})});
        parentPort.postMessage({kind:'result',result});
      } catch { parentPort.postMessage({kind:'failure'}); }
      finally { if(mode!=='leakHandle') clearInterval(pulse); parentPort.close(); }
    `,
    );
    parent = parent.replace(
      '"./sqlserver-prep-process-entry.mjs"',
      JSON.stringify(pathToFileURL(join(dir, "entry.mjs")).href),
    );
  }
  await writeFile(join(dir, "parent.mjs"), parent);
  const module = await import(pathToFileURL(join(dir, "parent.mjs")));
  return {
    run: module.runSQLServerPreparationProcess,
    marker,
    entry: join(dir, "entry.mjs"),
    fake: fake
      ? await import(pathToFileURL(join(dir, "fake-child.mjs")))
      : null,
  };
}
async function ended(marker) {
  const content = await readFile(marker, "utf8");
  const pid = JSON.parse(content.split("\n")[0]).pid;
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === "ESRCH",
  );
  await pause(80);
  assert.equal(await readFile(marker, "utf8"), content);
  assert.equal(
    process
      ._getActiveHandles()
      .filter(
        (h) =>
          h.constructor?.name === "ChildProcess" &&
          h.pid === pid &&
          h.exitCode === null &&
          h.signalCode === null,
      ).length,
    0,
  );
}
test("supervisor real fake-port process succeeds only after child exit and leaves no owned child", async (t) => {
  const f = await setup(t);
  const r = await f.run(input());
  assert.deepEqual(r.rows, [{ id: 1 }]);
  await ended(f.marker);
});
test("supervisor kills real fake-port process missing either or both receipts, never returns partial success", async (t) => {
  for (const mode of [
    "missingEnd",
    "missingSocket",
    "missingBoth",
    "leakHandle",
  ]) {
    const f = await setup(t);
    await assert.rejects(f.run(input(mode)), {
      code: "SQLSERVER_PREP_FORCED_TERMINATION_CONFIRMED",
    });
    await ended(f.marker);
  }
});
test("supervisor real busy fake worker is killable on revocation without a responsive worker", async (t) => {
  const f = await setup(t),
    c = new AbortController();
  const p = f.run(input("busy"), { signal: c.signal });
  p.catch(() => {});
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(f.marker);
      break;
    } catch {
      await pause(10);
    }
  }
  c.abort();
  await assert.rejects(p, {
    code: "SQLSERVER_PREP_FORCED_TERMINATION_CONFIRMED",
  });
  await ended(f.marker);
});
test("supervisor cooperative revoke is distinct from forced cleanup and preserves no result", async (t) => {
  const f = await setup(t),
    c = new AbortController();
  const p = f.run(input("hangQuery"), { signal: c.signal });
  p.catch(() => {});
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(f.marker);
      break;
    } catch {
      await pause(10);
    }
  }
  c.abort();
  await assert.rejects(p, { code: "SQLSERVER_PREP_CANCELLED" });
  await ended(f.marker);
});
test("supervisor fake child verifies IPC-only credentials, no replay and duplicate-result rejection", async (t) => {
  const f = await setup(t, true);
  await f.run(input());
  const c = f.fake.children[0];
  assert.equal(c.sends.filter((m) => m.kind === "start").length, 1);
  assert.doesNotMatch(JSON.stringify(c.options), /IPC-ONLY-SENTINEL/);
  assert.equal(
    c.sends[0].input.config.authentication.options.password,
    "IPC-ONLY-SENTINEL",
  );
  assert.deepEqual(c.options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  assert.equal(c.options.env.NODE_OPTIONS, undefined);
  f.fake.setMode("duplicate");
  await assert.rejects(f.run(input()), {
    code: "SQLSERVER_PREP_PROTOCOL_FAILED",
  });
  assert.equal(f.fake.children.length, 2);
});
test("supervisor kill request without OS receipt is bounded, quarantines admission and releases only on close", async (t) => {
  for (const mode of ["noClose", "throwKill"]) {
    const f = await setup(t, true);
    f.fake.setMode(mode);
    await assert.rejects(f.run(input()), {
      code: "SQLSERVER_PREP_CLEANUP_UNCONFIRMED",
    });
    assert.equal(f.fake.children[0].kills, 1);
    await assert.rejects(f.run(input()), { code: "SQLSERVER_PREP_BUSY" });
    assert.equal(f.fake.children.length, 1);
    f.fake.children[0].emit("close", null, "SIGKILL");
    f.fake.setMode("success");
    await f.run(input());
    assert.equal(f.fake.children.length, 2);
  }
});
test("supervisor enforces conservative total deadline without a status message or replay", async (t) => {
  const f = await setup(t, true);
  f.fake.setMode("totalTimeout");
  const start = Date.now();
  await assert.rejects(f.run(input()), {
    code: "SQLSERVER_PREP_FORCED_TERMINATION_CONFIRMED",
  });
  assert.ok(Date.now() - start >= 10000);
  assert.equal(f.fake.children.length, 1);
  assert.equal(f.fake.children[0].kills, 1);
});

test("supervisor child IPC disconnect kills a busy fake worker without its parent", async (t) => {
  const f = await setup(t);
  const child = fork(f.entry, {
    execArgv: [],
    env: {},
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  child.send({
    kind: "start",
    input: {
      config: { options: { database: "busy" } },
      plan: { sql: "unused", parameters: [] },
    },
  });
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(f.marker);
      break;
    } catch {
      await pause(10);
    }
  }
  child.disconnect();
  let deadline;
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => {
      deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("fixture exit receipt missing"));
      }, 3000);
    }),
  ]).finally(() => clearTimeout(deadline));
  assert.ok(result.signal || result.code !== 0);
  await ended(f.marker);
});

test("supervisor late result after kill cannot become success, and cleanup retains its initiating reason", async (t) => {
  const f = await setup(t, true);
  f.fake.setMode("hold");
  const c = new AbortController(),
    p = f.run(input(), { signal: c.signal });
  p.catch(() => {});
  while (!f.fake.children.length) await pause(5);
  c.abort();
  await assert.rejects(p, {
    code: "SQLSERVER_PREP_FORCED_TERMINATION_CONFIRMED",
    reason: "SQLSERVER_PREP_CANCELLED",
  });
  assert.equal(f.fake.children.length, 1);
  assert.equal(
    f.fake.children[0].sends.filter((m) => m.kind === "start").length,
    1,
  );
});
