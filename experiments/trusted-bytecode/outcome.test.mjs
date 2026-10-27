import test from "node:test";
import assert from "node:assert/strict";
import { completeSession } from "./outcome.mjs";
import { ActivityBudget } from "./budget.mjs";

function fixture({
  fail = false,
  initiallyExpired = false,
  late = false,
} = {}) {
  let now = 0,
    disposed = false,
    frees = 0;
  const budget = new ActivityBudget(() => now);
  if (initiallyExpired) budget.used = 251;
  return {
    budget,
    get frees() {
      return frees;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      frees++;
      if (late) now = 251;
      if (fail) throw Error("injected disposal failure");
    },
  };
}

test("worker success is returned only after successful disposal", () => {
  const s = fixture();
  const result = completeSession(s, { ok: true });
  assert.equal(s.frees, 1);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.metrics, "dispose-session"), true);
});

test("worker disposal failure rejects provisional success instead of reporting success", () => {
  const s = fixture({ fail: true });
  assert.deepEqual(completeSession(s, { ok: true }), {
    ok: false,
    error: "Session cleanup failed: injected disposal failure",
  });
  assert.equal(s.frees, 1);
});

test("late cleanup and already-expired budget reject success but still dispose once", () => {
  for (const options of [{ late: true }, { initiallyExpired: true }]) {
    const s = fixture(options);
    const result = completeSession(s, { ok: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /budget/);
    assert.equal(s.frees, 1);
  }
  const s = fixture({ initiallyExpired: true });
  assert.deepEqual(completeSession(s, { ok: false, error: "work failed" }), {
    ok: false,
    error: "work failed",
  });
  assert.equal(s.frees, 1);
});
