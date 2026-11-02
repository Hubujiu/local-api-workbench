import test from "node:test";
import assert from "node:assert/strict";
import { trackedQuickJS } from "../src/tracked-quickjs.mjs";

const LIMIT = 16 * 1024 * 1024;
const MIB = 1024 * 1024;
const activity = new WeakMap();
const allocation = (runtime) => {
  const match = runtime
    .dumpMemoryUsage()
    .match(/^memory allocated\s+(\d+)\s+(\d+)/m);
  assert(match, "runtime must expose its actual allocator accounting");
  return { count: Number(match[1]), bytes: Number(match[2]) };
};
async function session() {
  const tracked = await trackedQuickJS();
  const runtime = tracked.engine.newRuntime();
  runtime.setMemoryLimit(LIMIT);
  runtime.setMaxStackSize(512 * 1024);
  const budget = { used: 0, started: 0 };
  runtime.setInterruptHandler(
    () => budget.used + performance.now() - budget.started >= 250,
  );
  const context = runtime.newContext();
  activity.set(context, budget);
  return {
    runtime,
    context,
    tracked,
    dispose() {
      context.dispose();
      runtime.dispose();
    },
  };
}
function evaluate(context, source) {
  const budget = activity.get(context);
  assert(budget.used < 250, "cumulative active wall-time budget exceeded");
  budget.started = performance.now();
  try {
    return evaluateInside(context, source);
  } finally {
    budget.used += performance.now() - budget.started;
    assert(budget.used < 250, "cumulative active wall-time budget exceeded");
  }
}
function evaluateInside(context, source) {
  const result = context.evalCode(source, "heap-accounting-test.js", {
    type: "global",
  });
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw Error(error.message);
  }
  try {
    return context.dump(result.value);
  } finally {
    result.value.dispose();
  }
}

test("QuickJS accounts actual allocation size and returns to the same count after free", async () => {
  const s = await session();
  try {
    const before = allocation(s.runtime);
    const held = s.context.newString("a".repeat(MIB));
    try {
      assert.equal(s.context.getString(held).length, MIB);
      const during = allocation(s.runtime);
      assert(
        during.bytes - before.bytes >= MIB,
        JSON.stringify({ before, during }),
      );
      assert.equal(during.count, before.count + 1);
    } finally {
      held.dispose();
    }
    assert.deepEqual(allocation(s.runtime), before);
  } finally {
    s.dispose();
  }
});

test("cumulative 16MiB limit rejects ordinary bounded allocations and releases capacity", async () => {
  const s = await session();
  try {
    evaluate(s.context, "globalThis.held = []");
    let rejected = false;
    // Hard upper bound: only twenty ordinary guest-owned ArrayBuffers, each one MiB.
    // These use guest js_malloc, not the host newArrayBuffer external allocator.
    for (let index = 0; index < 20; index++) {
      try {
        evaluate(
          s.context,
          "held.push(new ArrayBuffer(1024*1024)); held.length",
        );
      } catch (error) {
        assert.match(error.message, /out of memory/);
        rejected = true;
        break;
      }
    }
    assert(
      rejected,
      "a 16MiB runtime must not retain 20MiB of live guest buffers",
    );
    const lengths = evaluate(s.context, "held.map(value => value.byteLength)");
    assert(lengths.length >= 1 && lengths.length < 16);
    assert(lengths.every((length) => length === MIB));
    assert(allocation(s.runtime).bytes <= LIMIT);
    evaluate(s.context, "held = []");
    assert(allocation(s.runtime).bytes < MIB);
    assert.equal(
      evaluate(s.context, "new ArrayBuffer(1024*1024).byteLength"),
      MIB,
    );
    assert.equal(s.tracked.unhandledCount(), 0);
  } finally {
    s.dispose();
  }
});

test("array growth remains accounted and failed replacement preserves existing values", async () => {
  const s = await session();
  try {
    evaluate(s.context, "globalThis.items = []");
    assert.equal(
      evaluate(s.context, "for(let i=0;i<50000;i++)items.push(i);items.length"),
      50000,
    );
    const beforeFailure = allocation(s.runtime);
    assert(beforeFailure.bytes >= 50000 * 8);
    assert.throws(
      () => evaluate(s.context, "items = new Array(4*1024*1024).fill(1)"),
      /out of memory/,
    );
    // Failed growth does not corrupt the existing object or prevent later work.
    assert.equal(evaluate(s.context, "items[0]"), 0);
    assert.equal(evaluate(s.context, "items[49999]"), 49999);
    evaluate(s.context, "items=[]");
    assert(allocation(s.runtime).bytes < beforeFailure.bytes);
    assert.equal(evaluate(s.context, "[1,2,3].map(x=>x*2).join(',')"), "2,4,6");
  } finally {
    s.dispose();
  }
});

test("independent instances preserve per-runtime accounting and isolate OOM", async () => {
  const a = await session(),
    b = await session();
  try {
    for (const s of [a, b])
      evaluate(
        s.context,
        "globalThis.held=Array.from({length:9},()=> new ArrayBuffer(1024*1024))",
      );
    assert(allocation(a.runtime).bytes > 9 * MIB);
    assert(allocation(b.runtime).bytes > 9 * MIB);
    assert.throws(
      () =>
        evaluate(
          a.context,
          "for(let i=0;i<9;i++)held.push(new ArrayBuffer(1024*1024))",
        ),
      /out of memory/,
    );
    assert.equal(evaluate(b.context, "held.length"), 9);
    assert.equal(evaluate(b.context, "held[8].byteLength"), MIB);
    evaluate(a.context, "held=[]");
    assert(allocation(a.runtime).bytes < MIB);
    assert(allocation(b.runtime).bytes > 9 * MIB);
  } finally {
    a.dispose();
    b.dispose();
  }
});
