import test from "node:test";
import assert from "node:assert/strict";
import { previewFunction } from "../src/custom-functions.mjs";

test("parameter functions preview typed values without mutating project state", async () => {
  const fn = {
    name: "is_even",
    kind: "transform",
    body: "return text % 2 === 0;",
  };
  assert.deepEqual(await previewFunction(fn, 4), { value: true, logs: [] });
  assert.equal((await previewFunction(fn, 3)).value, false);
  assert.deepEqual(
    (
      await previewFunction(
        { name: "wrap", kind: "transform", body: "return {original:text};" },
        { a: 1 },
      )
    ).value,
    { original: { a: 1 } },
  );
  assert.equal(
    (await previewFunction({ name: "double", body: "return args[0] * 2;" }, 3))
      .value,
    6,
  );
});
test("function preview rejects invalid, nonserializable and unbounded execution", async () => {
  for (const body of [
    "return undefined;",
    "return 1n;",
    "return NaN;",
    "return (() => {const x={};x.self=x;return x;})();",
    "while(true){}",
    "return process.env;",
  ])
    await assert.rejects(
      previewFunction({ name: "invalid", kind: "transform", body }, "x"),
    );
  await assert.rejects(
    previewFunction(
      { name: "constructor", kind: "transform", body: "return text;" },
      "x",
    ),
  );
  assert.equal(
    (
      await previewFunction(
        { name: "123", kind: "transform", body: "return text;" },
        0,
      )
    ).value,
    0,
  );
});
