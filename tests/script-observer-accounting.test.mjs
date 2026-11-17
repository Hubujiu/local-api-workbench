import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
// --import consumes an ESM specifier, including on Windows drive-letter paths.
const preload = new URL(
  "./helpers/script-accounting-preload.mjs",
  import.meta.url,
).href;
const fixture = fileURLToPath(
  new URL("./helpers/script-accounting-probe.mjs", import.meta.url),
);
async function probe(mode) {
  const { stdout, stderr } = await exec(
    process.execPath,
    ["--import", preload, fixture],
    {
      env: { ...process.env, LOCAL_API_ACCOUNTING_PROBE: mode },
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
  if (mode !== "guest-loop")
    assert.equal(
      (stderr.match(/SCRIPT_ACCOUNTING_PAUSE /g) || []).length,
      1,
      stderr,
    );
  return JSON.parse(stdout);
}

test("compatibility CPU observations cannot spend the shared guest allowance", async () => {
  const result = await probe("compatibility");
  assert.equal(result.success, false, JSON.stringify(result));
  assert.match(result.message, /最多100次/, JSON.stringify(result));
  assert.equal(result.scriptScope, "b");
  assert.equal(result.sequenceActivity.length, 1);
  assert.equal(result.sequenceActivity[0].timerCount, 60);
  assert.equal(result.scriptDiagnostics.timerCount, 40);
  assert(result.scriptDiagnostics.activityBudgetMs < 250);
});

test("the final serialization CPU observation cannot reject an already bounded output", async () => {
  const result = await probe("serialization");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.payloadLength, 900000);
  assert.equal(result.retained, "original");
  assert(result.activityMs <= 250);
});

test("host JSON parsing still consumes active wall time and cannot publish a late result", async () => {
  const result = await probe("host-parse");
  assert.equal(result.success, false, JSON.stringify(result));
  assert.match(result.message, /超时/);
  assert.equal(result.scriptStage, "serialization");
  assert(result.scriptDiagnostics.serializationMs >= 250);
});

test("real guest execution retains the unchanged active wall limit", async () => {
  const result = await probe("guest-loop");
  assert.equal(result.success, false, JSON.stringify(result));
  assert.match(result.message, /interrupted|超时/);
  assert.equal(result.scriptDiagnostics.activityBudgetMs, 250);
  assert.equal(result.scriptStage, "script");
});

test("native assertion evidence conversion cannot escape the active wall allowance", async () => {
  const result = await probe("evidence-parse");
  assert.equal(result.success, false, JSON.stringify(result));
  assert.match(result.message, /超时/);
  assert(result.scriptDiagnostics.promiseStateMs >= 250);
});

test("the outer total deadline still terminates a blocked diagnostic observer", async () => {
  const result = await probe("total-wall");
  assert.equal(result.success, false, JSON.stringify(result));
  assert.match(result.message, /超时/);
  assert.equal(
    result.scriptDiagnostics.hostLifecycle.finishReason,
    "total-deadline",
  );
});
