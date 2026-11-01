import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createNativeMockEvaluator } from "../src/native-mock-library.mjs";

// CI-only runtime regression: delay the host output parse, after VM execution
// has returned. A slow RNG alone could hit an earlier VM interrupt and would
// not distinguish the terminal-accounting defect. No production test hook.
function withSlowOutputParse(milliseconds, run) {
  const parse = JSON.parse;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  let outputs = 0;
  JSON.parse = function (text, ...args) {
    if (typeof text === "string" && text.startsWith('"')) {
      outputs++;
      assert.equal(Atomics.wait(cell, 0, 0, milliseconds), "timed-out");
    }
    return parse(text, ...args);
  };
  try {
    run(() => outputs);
  } finally {
    JSON.parse = parse;
  }
}

const spec = { name: "cfirst", args: [] };

test("native Mock refuses a final host-parsing overrun before returning its value", () => {
  const scope = createNativeMockEvaluator(() => 0.5);
  try {
    withSlowOutputParse(300, (outputs) => {
      const started = performance.now();
      assert.throws(() => scope.evaluate(spec), /原版Mock库运行额度已用尽/);
      assert.equal(outputs(), 1, "must reach the host output tail");
      assert(performance.now() - started >= 250);
      assert.throws(() => scope.evaluate(spec), /原版Mock库运行额度已用尽/);
      assert.equal(outputs(), 1, "exhausted scope must not execute again");
    });
  } finally {
    scope.dispose();
  }
  assert.throws(() => scope.evaluate(spec), /关闭/);
});

test("native Mock charges output tails cumulatively without resetting across calls", () => {
  // A timed wait is a lower bound, not a guarantee that the first call fits
  // 250 ms on a paused runner. Isolate a controlled accounting clock from this
  // process; the unchanged test above independently checks real elapsed time.
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./fixtures/native-mock-budget-clock.mjs", import.meta.url),
      ),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    first: { outputs: 1, elapsed: 160 },
    second: { outputs: 2, elapsed: 320 },
    exhausted: { outputs: 2, elapsed: 320 },
    fresh: { outputs: 3, elapsed: 480 },
    clockRestored: true,
    parseRestored: true,
  });
});
