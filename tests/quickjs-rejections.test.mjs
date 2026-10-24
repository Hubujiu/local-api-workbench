import test from "node:test";
import assert from "node:assert/strict";
import { trackedQuickJS } from "../src/tracked-quickjs.mjs";
const evaluate = (context, code) => {
  const result = context.evalCode(code);
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw Error(error.message);
  }
  const value = context.dump(result.value);
  result.value.dispose();
  return value;
};
const jobs = (runtime) => {
  const result = runtime.executePendingJobs(1000);
  if (result.error) {
    const value = result.context.dump(result.error);
    result.error.dispose();
    throw Error(value.message);
  }
};

test("native rejection tracking sees detached async errors, clears handled rejections and releases contexts", async () => {
  const tracked = await trackedQuickJS();
  for (let i = 0; i < 20; i++) {
    const runtime = tracked.engine.newRuntime(),
      context = runtime.newContext();
    try {
      evaluate(context, "globalThis.p=Promise.reject(Error('unhandled'));42");
      assert.equal(tracked.unhandledCount(), 1);
      assert.match(tracked.unhandledMessage(), /unhandled/);
      evaluate(context, "p.catch(()=>{});42");
      jobs(runtime);
      assert.equal(tracked.unhandledCount(), 0);
      evaluate(
        context,
        "(async()=>{await 1;throw Error('detached async')})();42",
      );
      jobs(runtime);
      assert.equal(tracked.unhandledCount(), 1);
      assert.match(tracked.unhandledMessage(), /detached async/);
    } finally {
      context.dispose();
      runtime.dispose();
    }
    assert.equal(tracked.unhandledCount(), 0);
  }
});
test("rejection reporting does not invoke user getters or coercion hooks", async () => {
  const tracked = await trackedQuickJS(),
    runtime = tracked.engine.newRuntime(),
    context = runtime.newContext();
  const deadline = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  try {
    evaluate(
      context,
      "globalThis.called=false;const error=new Error();Object.defineProperty(error,'message',{get(){called=true;return 'unsafe'}});Promise.reject(error);42",
    );
    assert.equal(tracked.unhandledCount(), 1);
    tracked.unhandledMessage();
    assert.equal(evaluate(context, "called"), false);
    assert.equal(
      evaluate(context, "typeof QTS_UnhandledRejectionCount"),
      "undefined",
    );
  } finally {
    context.dispose();
    runtime.dispose();
  }
});
test("unhandled rejection capacity is bounded and teardown still frees every retained value", async () => {
  const tracked = await trackedQuickJS(),
    runtime = tracked.engine.newRuntime(),
    context = runtime.newContext();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  const deadline = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  try {
    evaluate(context, "for(let i=0;i<1001;i++)Promise.reject(i);42");
    assert.match(tracked.unhandledMessage(), /1000/);
  } finally {
    context.dispose();
    runtime.dispose();
  }
  assert.equal(tracked.unhandledCount(), 0);
});
