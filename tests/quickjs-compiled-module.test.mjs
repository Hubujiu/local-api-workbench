import test from "node:test";
import assert from "node:assert/strict";
import * as engineLoader from "../src/tracked-quickjs.mjs";

const evaluate = (context, code) => {
  const value = context.evalCode(code);
  if (value.error) {
    const error = context.dump(value.error);
    value.error.dispose();
    throw Error(error.message);
  }
  const result = context.dump(value.value);
  value.value.dispose();
  return result;
};

test("verified compiled WASM is shareable while runtime globals and rejection state remain isolated", async () => {
  assert.equal(typeof engineLoader.compileTrackedQuickJS, "function");
  const compiled = await engineLoader.compileTrackedQuickJS();
  assert(compiled.module instanceof WebAssembly.Module);
  const [a, b] = await Promise.all([
    engineLoader.trackedQuickJS(compiled),
    engineLoader.trackedQuickJS(structuredClone(compiled)),
  ]);
  const ar = a.engine.newRuntime(),
    br = b.engine.newRuntime(),
    ac = ar.newContext(),
    bc = br.newContext();
  try {
    evaluate(
      ac,
      "globalThis.privateValue=123;Promise.reject(Error('only-a'));42",
    );
    assert.equal(evaluate(bc, "typeof privateValue"), "undefined");
    assert.equal(a.unhandledCount(), 1);
    assert.equal(b.unhandledCount(), 0);
  } finally {
    ac.dispose();
    bc.dispose();
    ar.dispose();
    br.dispose();
  }
  assert.equal(a.unhandledCount(), 0);
  assert.equal(b.unhandledCount(), 0);
  await assert.rejects(
    engineLoader.trackedQuickJS({ ...compiled, wasmSha256: "wrong" }),
    /完整性/,
  );
});
