import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fixture does not rewrite production source. Gate only the first real stale-lock rm call
// in each child. Every read, kill(pid,0), mkdir, write and removal stays real.
const source = new URL("../../src/file-lock.mjs", import.meta.url).href;
if (process.argv[2] === "dead") process.exit(0);
if (process.argv[2] === "child") {
  const root = process.argv[3],
    name = process.argv[4];
  const lock = path.join(root, "project.lock");
  const messages = new Map();
  process.on("message", (m) => {
    const resolve = messages.get(m);
    if (resolve) {
      messages.delete(m);
      resolve();
    }
  });
  const wait = (m) => new Promise((resolve) => messages.set(m, resolve));
  let probe = false;
  process.on("message", (m) => {
    if (m === "probe") probe = true;
  });
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (...args) {
    try {
      return exec.apply(this, args);
    } catch (error) {
      if (name === "B" && probe && error.errcode === 5) {
        probe = false;
        process.send({ type: "observation", kind: "busy", name });
      }
      throw error;
    }
  };
  const rm = fs.rm;
  let gated = false,
    acquired = false;
  fs.rm = async (...args) => {
    if (!gated && !acquired && args[0] === lock) {
      gated = true;
      const go = wait("remove");
      process.send({
        type: name === "B" ? "observation" : "stale-rm-ready",
        kind: "remove",
        name,
        pid: process.pid,
      });
      await go;
    }
    return rm(...args);
  };
  syncBuiltinESMExports();
  const { acquireFileLock } = await import(source);
  process.send({ type: "started", name });
  const release = await acquireFileLock(lock);
  acquired = true;
  const value = Number(await fs.readFile(path.join(root, "counter"), "utf8"));
  const commit = wait("commit");
  process.send({
    type: "acquired",
    name,
    pid: process.pid,
    read: value,
    owner: JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")),
  });
  await commit;
  await fs.writeFile(path.join(root, "counter"), String(value + 1));
  await release();
  process.send({ type: "committed", name, pid: process.pid });
  process.disconnect();
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "real-lock-recovery-"));
  const children = [];
  const transcript = [];
  const make = (name) => {
    const child = fork(fileURLToPath(import.meta.url), ["child", root, name], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    const queues = new Map(),
      waits = new Map();
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("message", (m) => {
      transcript.push(m);
      const fn = waits.get(m.type);
      if (fn) {
        waits.delete(m.type);
        fn(m);
      } else queues.set(m.type, m);
    });
    return {
      child,
      next(type) {
        if (queues.has(type)) {
          const message = queues.get(type);
          queues.delete(type);
          return Promise.resolve(message);
        }
        return new Promise((resolve, reject) => {
          waits.set(type, resolve);
          child.once("exit", (code) => {
            if (waits.has(type))
              reject(Error(`${name} exited ${code}: ${stderr}`));
          });
        });
      },
    };
  };
  const timer = setTimeout(() => {
    for (const c of children) c.kill("SIGKILL");
  }, 10000);
  try {
    // A short-lived real child supplies a demonstrably exited PID.
    const dead = fork(fileURLToPath(import.meta.url), ["dead"], {
      stdio: "ignore",
    });
    children.push(dead);
    await new Promise((resolve) => dead.once("exit", resolve));
    assert.throws(() => process.kill(dead.pid, 0), { code: "ESRCH" });
    await fs.mkdir(path.join(root, "project.lock"));
    await fs.writeFile(
      path.join(root, "project.lock", "owner.json"),
      JSON.stringify({ pid: dead.pid, nonce: "confirmed-dead-owner" }),
    );
    await fs.writeFile(path.join(root, "counter"), "0");
    const a = make("A");
    await a.next("stale-rm-ready");
    const b = make("B");
    await b.next("started");
    b.child.send("probe");
    const observation = await b.next("observation");
    a.child.send("remove");
    const aa = await a.next("acquired");
    assert.equal(aa.owner.pid, a.child.pid);
    if (observation.kind === "remove") {
      // Original protocol: B already authorized destruction of A's live lock.
      b.child.send("remove");
      const bb = await b.next("acquired");
      assert.equal(bb.read, 0);
      process.kill(a.child.pid, 0);
      b.child.send("commit");
      await b.next("committed");
      a.child.send("commit");
      await a.next("committed");
    } else {
      // A real SQLITE_BUSY after A acquired is positive evidence of exclusion,
      // rather than absence of an IPC message during a short sleep.
      assert.equal(observation.kind, "busy");
      b.child.send("probe");
      assert.equal((await b.next("observation")).kind, "busy");
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(root, "project.lock", "owner.json")),
        ).pid,
        a.child.pid,
      );
      a.child.send("commit");
      await a.next("committed");
      const bb = await b.next("acquired");
      assert.equal(bb.read, 1);
      b.child.send("commit");
      await b.next("committed");
    }
    const final = Number(await fs.readFile(path.join(root, "counter"), "utf8"));
    console.log(
      JSON.stringify(
        { expectedCounter: 2, actualCounter: final, transcript },
        null,
        2,
      ),
    );
    assert.equal(
      final,
      2,
      "two completed independent-process locked updates must both persist",
    );
  } finally {
    clearTimeout(timer);
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(
      children
        .filter((c) => c.exitCode === null)
        .map((c) => new Promise((r) => c.once("exit", r))),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
}
