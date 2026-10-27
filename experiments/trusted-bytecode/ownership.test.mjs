import test from "node:test";
import assert from "node:assert/strict";
import { ActivityBudget } from "./budget.mjs";
import { createOwnedRuntime } from "./ownership.mjs";
import { LIMITS } from "./catalog.mjs";

function fixture(failAt, late = false) {
  let now = 0;
  const calls = [];
  const step = (name) => {
    calls.push(name);
    if (name === failAt) throw Error("injected " + name);
  };
  const context = { dispose: () => step("dispose-context") };
  const runtime = {
    setMemoryLimit(value) {
      assert.equal(value, LIMITS.memory);
      step("memory");
    },
    setMaxStackSize(value) {
      assert.equal(value, LIMITS.stack);
      step("stack");
    },
    setInterruptHandler(handler) {
      assert.equal(handler(), false);
      step("interrupt");
    },
    newContext() {
      step("context");
      if (late) now = 251;
      return context;
    },
    dispose: () => step("dispose-runtime"),
  };
  return {
    raw: {
      engine: {
        newRuntime() {
          step("runtime");
          return runtime;
        },
      },
    },
    budget: new ActivityBudget(() => now),
    calls,
  };
}

test("late context creation disposes the acquired context before its runtime", () => {
  const f = fixture(undefined, true);
  assert.throws(() => createOwnedRuntime(f.raw, f.budget), /wall-time budget/);
  assert.deepEqual(f.calls.slice(-2), ["dispose-context", "dispose-runtime"]);
});

test("runtime option and context creation failures dispose only acquired owners", () => {
  for (const point of ["runtime", "memory", "stack", "interrupt", "context"]) {
    const f = fixture(point);
    assert.throws(() => createOwnedRuntime(f.raw, f.budget), /injected/);
    assert.equal(f.calls.includes("dispose-context"), false);
    assert.equal(
      f.calls.filter((x) => x === "dispose-runtime").length,
      point === "runtime" ? 0 : 1,
    );
  }
});

test("successful ownership is idempotent and still frees runtime if context cleanup throws", () => {
  for (const failAt of [undefined, "dispose-context"]) {
    const f = fixture(failAt);
    const owner = createOwnedRuntime(f.raw, f.budget);
    if (failAt) assert.throws(() => owner.dispose(), /injected/);
    else owner.dispose();
    owner.dispose();
    assert.deepEqual(f.calls.slice(-2), ["dispose-context", "dispose-runtime"]);
  }
});
