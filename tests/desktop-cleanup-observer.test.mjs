import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopCleanupObserver } from "./fixtures/desktop-cleanup-observer.mjs";

test("cleanup markers locate a pending stage without timers or completing it", async () => {
  const entries = [];
  let time = 10,
    resolve;
  const observe = createDesktopCleanupObserver({
    now: () => time,
    report: (e) => entries.push(e),
  });
  observe("application-kill")();
  const closed = observe("application-close");
  const pending = new Promise((r) => {
    resolve = r;
  });
  const cleanup = pending.then(() => closed());
  await Promise.resolve();
  assert.deepEqual(entries, [
    { stage: "application-kill", state: "begin" },
    { stage: "application-kill", state: "completed", elapsedMs: 0 },
    { stage: "application-close", state: "begin" },
  ]);
  time = 25.4;
  resolve();
  await cleanup;
  assert.deepEqual(entries.at(-1), {
    stage: "application-close",
    state: "completed",
    elapsedMs: 15,
  });
});

test("cleanup observations are bounded and cannot include arbitrary stage or error text", () => {
  const entries = [];
  const observe = createDesktopCleanupObserver({
    now: () => 0,
    report: (e) => entries.push(e),
  });
  observe("secret-path-token")("secret-error");
  const finish = observe("application-close");
  finish("failed");
  finish();
  observe("application-close")();
  assert.deepEqual(entries, [
    { stage: "application-close", state: "begin" },
    { stage: "application-close", state: "failed", elapsedMs: 0 },
  ]);
  for (let i = 0; i < 100; i++)
    for (const stage of [
      "application-kill",
      "ntlm-close",
      "jwt-close-connections",
      "jwt-close",
      "watchdog-clear",
      "temporary-directory-remove",
    ])
      observe(stage)("secret-error");
  assert.equal(entries.length, 14);
  assert(!JSON.stringify(entries).includes("secret"));
});

test("observer failures and invalid clocks cannot break cleanup or emit unbounded numbers", () => {
  const observe = createDesktopCleanupObserver({
    now: () => {
      throw Error("private");
    },
    report: () => {
      throw Error("private");
    },
  });
  assert.doesNotThrow(() => observe("application-close")());
  for (const end of [NaN, Infinity, -10, 1e20]) {
    let value = 0;
    const entries = [];
    const track = createDesktopCleanupObserver({
      now: () => value,
      report: (e) => entries.push(e),
    });
    const finish = track("ntlm-close");
    value = end;
    finish();
    assert.equal(entries[1].elapsedMs, end === 1e20 ? 86400000 : 0);
  }
});
