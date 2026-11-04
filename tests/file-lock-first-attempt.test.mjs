import test from "node:test";
import assert from "node:assert/strict";
import sqlite from "node:sqlite";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports, registerHooks } from "node:module";
import path from "node:path";
import os from "node:os";
const sourceURL = new URL("../src/file-lock.mjs", import.meta.url).href;
// node:sqlite named exports do not follow default-object reassignment, so wrap
// only construction through an in-memory module. The real SQLite OS locks remain.
const shim =
  "data:text/javascript," +
  encodeURIComponent(`
 import {DatabaseSync as Native} from 'node:sqlite';
 export class DatabaseSync extends Native {constructor(...args){super(...args);globalThis.__pr111AfterGuardOpen?.();}}
`);
const hooks = registerHooks({
  load(url, context, next) {
    const out = next(url, context);
    if (url !== sourceURL) return out;
    const anchor = 'import { DatabaseSync } from "node:sqlite";';
    const source = out.source.toString();
    assert(source.includes(anchor));
    return {
      ...out,
      source: source.replace(
        anchor,
        `import {DatabaseSync} from ${JSON.stringify(shim)};`,
      ),
    };
  },
});
const { acquireFileLock } = await import(sourceURL);
hooks.deregister();
const NativeDatabase = sqlite.DatabaseSync,
  nativeExec = NativeDatabase.prototype.exec;
const nativeNow = performance.now.bind(performance),
  nativeMkdir = fs.mkdir,
  nativeRead = fs.readFile,
  nativeRm = fs.rm;
for (const scenario of [
  "late-open-empty",
  "late-begin-empty",
  "late-open-guard-busy",
  "late-begin-dead-legacy",
  "late-begin-live-legacy",
  "late-begin-unrecognized-legacy",
  "late-begin-eperm",
  "hard-open",
  "hard-begin",
  "abort-after-open",
  "abort-after-begin",
  "deadline-after-open",
  "deadline-after-begin",
  "abort-after-mkdir",
]) {
  test(scenario, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pr111-first-attempt-"),
    );
    // acquireFileLock canonicalizes the parent before its filesystem calls.
    // Match the same native path on platforms where the temp root is an alias.
    const lock = path.join(
      realpathSync.native(root + path.sep),
      "project.lock",
    );
    let offset = 0,
      begins = 0,
      mkdirs = 0,
      reads = 0,
      removals = 0,
      waits = 0,
      contender,
      release;
    const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      ),
      nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now"),
      nativeTimeout = globalThis.setTimeout;
    const controller = new AbortController();
    if (scenario === "late-open-guard-busy") {
      contender = new NativeDatabase(lock + ".guard.sqlite", { timeout: 0 });
      contender.exec("BEGIN IMMEDIATE");
    }
    const owner =
      scenario === "late-begin-unrecognized-legacy"
        ? "{}"
        : JSON.stringify({
            pid:
              scenario === "late-begin-live-legacy" ? process.pid : 2147483647,
            nonce: "preserved-owner",
          });
    if (scenario.endsWith("-legacy")) {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, "owner.json"), owner);
    }
    const initial = nativeNow();
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => nativeNow() + offset,
    });
    globalThis.__pr111AfterGuardOpen = () => {
      if (scenario.includes("open"))
        offset = scenario === "hard-open" ? 10001 : 2001;
      if (scenario === "abort-after-open") controller.abort();
    };
    NativeDatabase.prototype.exec = function (sql, ...a) {
      if (sql === "BEGIN IMMEDIATE") begins++;
      const result = nativeExec.call(this, sql, ...a);
      if (sql === "BEGIN IMMEDIATE") {
        if (scenario.includes("begin") || scenario === "abort-after-mkdir")
          offset = scenario === "hard-begin" ? 10001 : 2001;
        if (scenario === "abort-after-begin") controller.abort();
      }
      return result;
    };
    fs.mkdir = async function (p, ...a) {
      if (p === lock) {
        mkdirs++;
        if (scenario === "late-begin-eperm")
          throw Object.assign(Error("owned transient mkdir fixture"), {
            code: "EPERM",
            syscall: "mkdir",
          });
      }
      const result = await nativeMkdir.call(this, p, ...a);
      if (p === lock && scenario === "abort-after-mkdir") controller.abort();
      return result;
    };
    globalThis.setTimeout = function (fn, ms, ...args) {
      if (ms === 20) waits++;
      return nativeTimeout(fn, ms, ...args);
    };
    if (scenario === "late-begin-eperm")
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "win32",
      });
    fs.readFile = async function (p, ...a) {
      if (p === path.join(lock, "owner.json")) reads++;
      return nativeRead.call(this, p, ...a);
    };
    fs.rm = async function (p, ...a) {
      if (p === lock) removals++;
      return nativeRm.call(this, p, ...a);
    };
    syncBuiltinESMExports();
    try {
      const options = {
        signal: controller.signal,
        ...(scenario.startsWith("deadline-after-")
          ? { deadline: initial + 1000 }
          : {}),
      };
      const started = nativeNow();
      let error;
      try {
        release = await acquireFileLock(lock, options);
      } catch (e) {
        error = e;
      }
      if (scenario.endsWith("-empty")) {
        assert.equal(error, undefined);
        assert.equal(begins, 1);
        assert.equal(mkdirs, 1);
        await release();
      } else {
        assert(error);
        if (scenario.startsWith("abort-after-"))
          assert.equal(error.code, "ABORT_ERR");
        else if (scenario.startsWith("deadline-after-"))
          assert.equal(error.code, "REQUEST_TIMEOUT");
        else if (scenario === "late-begin-eperm")
          assert.equal(error.code, "EPERM");
        else assert.match(error.message, /其他进程/);
        assert.equal(
          begins,
          ["hard-open", "abort-after-open", "deadline-after-open"].includes(
            scenario,
          )
            ? 0
            : 1,
        );
        assert.equal(
          mkdirs,
          scenario.endsWith("-legacy") ||
            scenario === "late-begin-eperm" ||
            scenario === "abort-after-mkdir"
            ? 1
            : 0,
        );
        assert.equal(reads, scenario === "abort-after-mkdir" ? 1 : 0);
        assert.equal(removals, scenario === "abort-after-mkdir" ? 1 : 0);
        if (scenario === "abort-after-mkdir")
          assert.equal(
            await fs.access(lock).then(
              () => true,
              () => false,
            ),
            false,
          );
        assert.equal(waits, 0);
        if (scenario.endsWith("-legacy"))
          assert.equal(
            await nativeRead(path.join(lock, "owner.json"), "utf8"),
            owner,
          );
        if (contender) {
          const d = new NativeDatabase(lock + ".guard.sqlite", { timeout: 0 });
          try {
            assert.throws(
              () => nativeExec.call(d, "BEGIN IMMEDIATE"),
              (e) => e.errcode === 5,
            );
          } finally {
            d.close();
          }
        }
      }
      // After a failed acquisition, a different real connection must be able
      // to take the guard. A real external contender is checked separately above.
      if (error && !contender) {
        const probe = new NativeDatabase(lock + ".guard.sqlite", {
          timeout: 0,
        });
        try {
          nativeExec.call(probe, "BEGIN IMMEDIATE");
          nativeExec.call(probe, "ROLLBACK");
        } finally {
          probe.close();
        }
      }
      t.diagnostic(
        JSON.stringify({
          scenario,
          error: error?.code || error?.message,
          begins,
          mkdirs,
          reads,
          removals,
          waits,
          elapsedRealMs: Math.round(nativeNow() - started),
        }),
      );
    } finally {
      delete globalThis.__pr111AfterGuardOpen;
      Object.defineProperty(process, "platform", platformDescriptor);
      globalThis.setTimeout = nativeTimeout;
      NativeDatabase.prototype.exec = nativeExec;
      fs.mkdir = nativeMkdir;
      fs.readFile = nativeRead;
      fs.rm = nativeRm;
      syncBuiltinESMExports();
      if (nowDescriptor)
        Object.defineProperty(performance, "now", nowDescriptor);
      else delete performance.now;
      await release?.();
      if (contender) {
        contender.exec("ROLLBACK");
        contender.close();
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
