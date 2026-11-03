import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test(
  "concurrent dead-owner recovery preserves mutual exclusion and both persisted updates",
  { timeout: 15000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/file-lock-recovery-process.mjs", import.meta.url),
        ),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout = (stdout + data).slice(-16384);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-16384);
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
  },
);
