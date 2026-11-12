import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  hardStopDesktopProcess,
  windowsHardStopArgs,
} from "./helpers/desktop-hard-stop.mjs";
import assert from "node:assert/strict";
import {
  assertCleanDesktopExit,
  assertCrashDesktopExit,
} from "./helpers/desktop-restart-receipt.mjs";
const clean = {
  code: 0,
  signal: null,
  closed: true,
  saved: true,
  forced: false,
};
test("desktop restart accepts only clean closed saved receipts", () => {
  assert.doesNotThrow(() => assertCleanDesktopExit(clean));
});
for (const change of [
  { code: 2 },
  { signal: "SIGKILL" },
  { closed: false },
  { saved: false },
  { forced: true },
])
  test(`desktop restart rejects ${Object.keys(change)[0]} mismatch`, () => {
    assert.throws(() => assertCleanDesktopExit({ ...clean, ...change }));
  });

const crash = {
  code: null,
  signal: "SIGKILL",
  closed: true,
  saved: false,
  forced: true,
  sent: true,
  platform: "linux",
};
test("hard-stop receipt accepts POSIX kill and Windows abnormal exit", () => {
  assert.doesNotThrow(() => assertCrashDesktopExit(crash));
  assert.doesNotThrow(() =>
    assertCrashDesktopExit({
      ...crash,
      platform: "win32",
      signal: null,
      code: 1,
    }),
  );
});
for (const change of [
  { signal: "SIGTERM" },
  { code: 0 },
  { signal: null, code: 0 },
  { closed: false },
  { saved: true },
  { forced: false },
  { sent: false },
  { platform: "win32", signal: null, code: null },
]) {
  test(`hard-stop receipt rejects ${JSON.stringify(change)}`, () => {
    assert.throws(() => assertCrashDesktopExit({ ...crash, ...change }));
  });
}

test(
  "hard-stop receipt matches a real owned child process exit",
  { timeout: 15000 },
  async () => {
    const leaf = 'process.stdout.write("ready");setInterval(()=>{},1000)';
    // On Windows, keep a descendant holding inherited stdout/stderr until the
    // owned tree is killed. Waiting for close proves those handles were closed.
    const source =
      process.platform === "win32"
        ? `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(leaf)}],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)`
        : leaf;
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = once(child, "exit"),
      close = once(child, "close");
    try {
      await once(child.stdout, "data");
      const sent = await hardStopDesktopProcess(child);
      const [code, signal] = await exit;
      await close;
      assertCrashDesktopExit({
        code,
        signal,
        closed: true,
        saved: false,
        forced: true,
        sent,
        platform: process.platform,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        await hardStopDesktopProcess(child);
    }
  },
);

test("Windows hard-stop targets only a validated exact PID tree without a shell", () => {
  assert.deepEqual(windowsHardStopArgs(12345), ["/PID", "12345", "/T", "/F"]);
  for (const pid of [
    0,
    -1,
    NaN,
    Infinity,
    1.5,
    "12345",
    "1 /IM *",
    process.pid,
  ])
    assert.throws(() => windowsHardStopArgs(pid));
});
test("hard-stop refuses stale process handles before invoking the OS", async () => {
  for (const value of [
    { pid: 12345, exitCode: 0, signalCode: null },
    { pid: 12345, exitCode: null, signalCode: "SIGKILL" },
    { pid: process.pid, exitCode: null, signalCode: null },
  ])
    await assert.rejects(hardStopDesktopProcess(value));
});
