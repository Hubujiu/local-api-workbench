import assert from "node:assert/strict";
// A killed/uncertain process must never satisfy the successful restart boundary.
export function assertCleanDesktopExit({
  code,
  signal,
  closed,
  saved,
  forced,
}) {
  assert.equal(forced, false);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(closed, true);
  assert.equal(saved, true);
}

// A crash test must prove an accepted hard stop and abnormal process termination.
// Windows may report its TerminateProcess exit code instead of a POSIX signal.
export function assertCrashDesktopExit({
  code,
  signal,
  closed,
  saved,
  forced,
  sent,
  platform,
}) {
  assert.equal(forced, true);
  assert.equal(sent, true);
  assert.equal(closed, true);
  assert.equal(saved, false);
  assert.ok(
    (signal === "SIGKILL" && code === null) ||
      (platform === "win32" &&
        signal === null &&
        Number.isInteger(code) &&
        code !== 0),
  );
}
