import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runFile = promisify(execFile);
export function windowsHardStopArgs(pid) {
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
    "Invalid owned desktop PID",
  );
  return ["/PID", String(pid), "/T", "/F"];
}
export async function hardStopDesktopProcess(child) {
  assert.equal(child.exitCode, null, "Desktop already exited before hard stop");
  assert.equal(
    child.signalCode,
    null,
    "Desktop already signalled before hard stop",
  );
  assert.ok(
    Number.isSafeInteger(child.pid) &&
      child.pid > 0 &&
      child.pid !== process.pid,
    "Invalid owned desktop PID",
  );
  if (process.platform === "win32") {
    // Only the freshly launched, still-live test-owned PID and its descendants.
    // Killing just Electron's main process can leave inherited stdio handles open.
    await runFile("taskkill.exe", windowsHardStopArgs(child.pid), {
      timeout: 10000,
      windowsHide: true,
      shell: false,
    });
    return true;
  }
  return child.kill("SIGKILL");
}
