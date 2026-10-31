import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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
  const scope = createNativeMockEvaluator(() => 0.5);
  try {
    withSlowOutputParse(160, (outputs) => {
      assert.equal(typeof scope.evaluate(spec), "string");
      assert.equal(outputs(), 1);
      assert.throws(() => scope.evaluate(spec), /原版Mock库运行额度已用尽/);
      assert.equal(
        outputs(),
        2,
        "second output must exhaust the shared budget",
      );
    });
  } finally {
    scope.dispose();
  }
  // A fresh scope still succeeds; failed scopes do not contaminate later VMs.
  const fresh = createNativeMockEvaluator(() => 0.5);
  try {
    assert.equal(typeof fresh.evaluate(spec), "string");
  } finally {
    fresh.dispose();
  }
});
