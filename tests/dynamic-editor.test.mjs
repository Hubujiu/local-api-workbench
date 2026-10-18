import test from "node:test";
import assert from "node:assert/strict";
import { dynamicEditor, parseDynamicEdits } from "../public/dynamic-editor.js";
import { applyStepEdits } from "../public/step-editor.js";
test("step dynamic edits preserve typed values and metadata with explicit removal", () => {
  const previous = {
    source: "mock",
    value: "@integer(1,2)",
    seed: 0,
    type: "integer",
    note: "keep",
  };
  for (const value of [false, 0, null, { nested: [1] }]) {
    const next = parseDynamicEdits(
      {
        enabled: true,
        source: "fixed",
        value: JSON.stringify(value),
        functions: "double, stringify",
      },
      previous,
    );
    assert.deepEqual(next.value, value);
    assert.equal(next.note, "keep");
    assert.equal(next.seed, undefined);
    assert.deepEqual(next.functions, ["double", "stringify"]);
  }
  const spec = parseDynamicEdits(
    {
      enabled: true,
      source: "mock",
      value: "@integer(7,7)",
      type: "integer",
      seed: "0",
    },
    previous,
  );
  assert.equal(spec.seed, 0);
  assert.equal(previous.value, "@integer(1,2)");
  assert.equal(parseDynamicEdits({ enabled: false }, previous), null);
  const step = {
    name: "step",
    request: {
      query: [
        { key: "x", value: "old", dynamic: previous, description: "keep" },
      ],
    },
  };
  const next = applyStepEdits(
    step,
    { name: "step" },
    {
      query: [
        { index: 0, key: "x", value: "old", enabled: true, dynamic: spec },
      ],
    },
  );
  assert.equal(next.request.query[0].dynamic.value, "@integer(7,7)");
  assert.equal(next.request.query[0].description, "keep");
  const removed = applyStepEdits(
    next,
    { name: "step" },
    {
      query: [
        { index: 0, key: "x", value: "plain", enabled: true, dynamic: null },
      ],
    },
  );
  assert.equal(removed.request.query[0].dynamic, undefined);
  assert.equal(step.request.query[0].dynamic.value, "@integer(1,2)");
});
test("step dynamic editor rejects invalid values and file combinations without source mutation", () => {
  const base = { enabled: true, source: "fixed", value: "null" };
  for (const fields of [
    { ...base, value: "{" },
    { ...base, value: "1e999" },
    { ...base, source: "variable", value: "" },
    { ...base, functions: Array(11).fill("x").join(",") },
    {
      ...base,
      source: "mock",
      type: "number",
      value: "@integer(1,2)",
      seed: "1.5",
    },
  ])
    assert.throws(() => parseDynamicEdits(fields));
  assert.throws(
    () =>
      applyStepEdits(
        { name: "s", request: {} },
        { name: "s" },
        {
          form: [
            {
              key: "file",
              value: "",
              enabled: true,
              type: "file",
              dynamic: { source: "fixed", value: 1 },
            },
          ],
        },
      ),
    /文件/,
  );
  assert(
    !dynamicEditor({ source: "fixed", value: "</textarea><script>" }).includes(
      "<script>",
    ),
  );
});

test("dynamic Mock seed follows the runtime unsigned32-bit contract", () => {
  for (const seed of ["-1", "4294967296"])
    assert.throws(
      () =>
        parseDynamicEdits({
          enabled: true,
          source: "mock",
          value: "@integer(1,2)",
          type: "integer",
          seed,
        }),
      /种子/,
    );
});
