import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { goFixtureEnvironment } from "./helpers/codegen-fixture-process.mjs";

// This executes portable AST only, never imports WinDLL or starts Windows jobs.
test("actual Windows cleanup function waits for both fake WinAPI receipts without expanding its deadline", async () => {
  const { stdout } = await promisify(execFile)(
    "python3",
    [
      "-I",
      "-X",
      "utf8",
      fileURLToPath(
        new URL("./fixtures/codegen-job-cleanup-proof.py", import.meta.url),
      ),
      fileURLToPath(
        new URL("./helpers/codegen-windows-job.py", import.meta.url),
      ),
    ],
    { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4096 },
  );
  assert.match(stdout, /actual cleanup AST:.*passed/);
});

test("Go probe and build share local offline toolchain settings", () => {
  const env = goFixtureEnvironment();
  assert.equal(env.GOTOOLCHAIN, "local");
  assert.equal(env.GOWORK, "off");
  assert.equal(env.GOPROXY, "off");
  assert.equal(env.GO111MODULE, "off");
});
