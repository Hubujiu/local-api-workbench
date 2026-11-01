// CI-only executable fixture. Never import this into the test runner: the
// temporary clock replacement belongs exclusively to this bounded subprocess.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const originalNow = performance.now;
const ownNow = Object.getOwnPropertyDescriptor(performance, "now");
let elapsed = 0;
let createNativeMockEvaluator;
try {
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => elapsed,
  });
  // The unmodified production adapter captures this clock at import time.
  // Its real QuickJS engine and original-library integrity checks still run.
  ({ createNativeMockEvaluator } = await import(
    "../../src/native-mock-library.mjs"
  ));
} finally {
  if (ownNow) Object.defineProperty(performance, "now", ownNow);
  else delete performance.now;
}
assert.equal(performance.now, originalNow);
assert.deepEqual(Object.getOwnPropertyDescriptor(performance, "now"), ownNow);

const parse = JSON.parse;
const spec = { name: "cfirst", args: [] };
const budgetError = { message: "原版Mock库运行额度已用尽" };
let outputs = 0;
let randomCalls = 0;
const random = () => {
  randomCalls++;
  return 0.5;
};
const proof = {};
JSON.parse = function (text, ...args) {
  const value = parse(text, ...args);
  if (typeof text === "string" && text.startsWith('"')) {
    outputs++;
    elapsed += 160;
  }
  return value;
};
try {
  const scope = createNativeMockEvaluator(random);
  try {
    assert.equal(typeof scope.evaluate(spec), "string");
    assert.equal(outputs, 1, "first call must reach its output tail");
    assert.equal(elapsed, 160);
    const firstRandomCalls = randomCalls;
    assert(firstRandomCalls > 0, "must execute the real guest generator");
    proof.first = { outputs, elapsed };

    assert.throws(() => scope.evaluate(spec), budgetError);
    assert.equal(outputs, 2, "second output must exhaust the shared budget");
    assert.equal(elapsed, 320);
    assert(
      randomCalls > firstRandomCalls,
      "second call must execute the guest",
    );
    proof.second = { outputs, elapsed };

    const beforeRefusal = randomCalls;
    assert.throws(() => scope.evaluate(spec), budgetError);
    assert.equal(outputs, 2, "exhausted scope must not reach another tail");
    assert.equal(elapsed, 320);
    assert.equal(
      randomCalls,
      beforeRefusal,
      "exhausted scope must not run guest",
    );
    proof.exhausted = { outputs, elapsed };
  } finally {
    scope.dispose();
  }
  assert.throws(() => scope.evaluate(spec), /关闭/);

  // Charge a real third output tail in a fresh VM without resetting the clock.
  // Only the scope's budget is fresh; a failed scope must not contaminate it.
  const fresh = createNativeMockEvaluator(random);
  try {
    assert.equal(typeof fresh.evaluate(spec), "string");
    assert.equal(outputs, 3);
    assert.equal(elapsed, 480);
    proof.fresh = { outputs, elapsed };
  } finally {
    fresh.dispose();
  }
} finally {
  JSON.parse = parse;
}
assert.equal(performance.now, originalNow);
assert.equal(JSON.parse, parse);
proof.clockRestored = true;
proof.parseRestored = true;
process.stdout.write(JSON.stringify(proof) + "\n");
