import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
test("script result settles only after isolated worker exits and closes message ports", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["tests/fixtures/script-lifecycle.mjs"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 30000 },
  );
  assert.match(stdout, /CLEAN_SCRIPT_WORKER_EXIT/);
});
