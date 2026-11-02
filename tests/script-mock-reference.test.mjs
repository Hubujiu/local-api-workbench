import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import Mock from "apipost-mock";
import { createScriptMockGenerator } from "../src/script-mock-core.mjs";

// CI-only execution of the locked public MIT reference and the admitted-core
// adaptation. These are not original-application fixtures or local static tests.
// No await occurs while the process-local Math.random descriptor is replaced.
const withDraws = (draws, action) => {
  const original = Object.getOwnPropertyDescriptor(Math, "random");
  const trace = [];
  const random = () => {
    assert(trace.length < draws.length, "unexpected extra random draw");
    const value = draws[trace.length];
    assert(Number.isFinite(value) && value >= 0 && value < 1);
    trace.push(value);
    return value;
  };
  Object.defineProperty(Math, "random", { ...original, value: random });
  try {
    return { value: action(), trace };
  } finally {
    Object.defineProperty(Math, "random", original);
  }
};

const orderedKeys = (value, path = [], rows = []) => {
  if (value === null || typeof value !== "object") return rows;
  const keys = Object.keys(value);
  rows.push({ path, keys });
  for (const key of keys) orderedKeys(value[key], [...path, key], rows);
  return rows;
};
const assertFreshContainers = (input, output) => {
  const inputObjects = new Set();
  const collect = (value) => {
    if (value === null || typeof value !== "object") return;
    inputObjects.add(value);
    for (const key of Object.keys(value)) collect(value[key]);
  };
  collect(input);
  const outputObjects = new Set();
  const inspect = (value) => {
    if (value === null || typeof value !== "object") return;
    assert.equal(
      inputObjects.has(value),
      false,
      "generated container aliases input",
    );
    assert.equal(
      outputObjects.has(value),
      false,
      "generated containers share identity",
    );
    outputObjects.add(value);
    for (const key of Object.keys(value)) inspect(value[key]);
  };
  inspect(output);
};

test("script Mock comparison reference is the exact locked apipost-mock public package", async () => {
  const require = createRequire(import.meta.url);
  const [packageText, lockText, source] = await Promise.all([
    readFile(require.resolve("apipost-mock/package.json"), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(require.resolve("apipost-mock")),
  ]);
  const pkg = JSON.parse(packageText);
  const locked = JSON.parse(lockText).packages["node_modules/apipost-mock"];
  assert.equal(pkg.name, "apipost-mock");
  assert.equal(pkg.version, "1.0.2");
  assert.equal(pkg.license, "MIT");
  assert.equal(locked.version, pkg.version);
  assert.equal(
    locked.integrity,
    "sha512-eC/OtJpAT5IR2f20sx4u4J6KGGo8Kc8eJSzeCTGPv2sacqGFPnNUgl0XucWdJSea2GmGRap/FUky28HTiJzfyA==",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "444c7ccad3c4ee00ce6871517995852d5a5928715a6b449d3f2622291e6e816a",
  );
});

const cases = [
  ...[
    ["null", null],
    ["false", false],
    ["true", true],
    ["zero", 0],
    ["negative zero", -0],
    ["finite positive fraction", 3.125],
    ["finite negative fraction", -8.75],
    ["empty string", ""],
    ["Unicode string", "中文🙂 空 格"],
  ].map(([name, value]) => ({
    name,
    make: () => value,
    expected: value,
    draws: [],
  })),
  { name: "empty object", make: () => ({}), expected: {}, draws: [] },
  { name: "empty array", make: () => [], expected: [], draws: [] },
  {
    name: "fixed numeric rules do not draw",
    make: () => ({
      "positive|7": 0,
      "zero|0": 2,
      "negative|-7": 9,
      fraction: 2.125,
      negativeZero: -0,
    }),
    expected: {
      positive: 7,
      zero: 0,
      negative: -7,
      fraction: 2.125,
      negativeZero: -0,
    },
    draws: [],
  },
  {
    name: "equal numeric ranges still draw in key order",
    make: () => ({ "equal|5-5": 0, "below|-3--3": 4, "zero|0-0": 999 }),
    expected: { equal: 5, below: -3, zero: 0 },
    draws: [0.13, 0.91, 0],
  },
  {
    name: "range generation preserves round rather than floor",
    make: () => ({
      "a|0-2": 0,
      "b|0-2": 0,
      "c|0-2": 0,
      "d|-2-0": 0,
      "e|-2-0": 0,
    }),
    expected: { a: 0, b: 0, c: 1, d: 0, e: 0 },
    draws: [0, 0.249, 0.25, 0.75, 0.999],
  },
  {
    name: "safe integer extremes with safe spans",
    make: () => ({
      "nearMax|9007199254740989-9007199254740991": 0,
      "nearMin|-9007199254740991--9007199254740989": 0,
      "max|9007199254740991": 0,
      "min|-9007199254740991": 0,
    }),
    expected: {
      nearMax: 9007199254740990,
      nearMin: -9007199254740990,
      max: 9007199254740991,
      min: -9007199254740991,
    },
    draws: [0.5, 0.5],
  },
  {
    name: "fixed array repetition preserves the full mixed sequence without draws",
    make: () => ({ "values|2": [1, false, null, { label: "x" }] }),
    expected: {
      values: [1, false, null, { label: "x" }, 1, false, null, { label: "x" }],
    },
    draws: [],
  },
  {
    name: "zero repetition skips children but an empty range array still parses its range",
    make: () => ({
      "gone|0": [{ "n|0-9": 0 }],
      "empty|2-4": [],
      "tail|1-2": 0,
    }),
    expected: { gone: [], empty: [], tail: 1 },
    draws: [0.9, 0.1],
  },
  {
    name: "empty pick does not draw",
    make: () => ({ "pick|1": [] }),
    expected: { pick: [] },
    draws: [],
  },
  {
    name: "pick generates every candidate before natural selection and later sibling",
    make: () => ({
      "pick|1": [{ "n|0-9": 0 }, { "n|0-9": 0 }, { "n|0-9": 0 }],
      "tail|10-20": 0,
    }),
    expected: { pick: { n: 5 }, tail: 12 },
    draws: [0, 0.5, 0.999, 0.6, 0.2],
  },
  {
    name: "pick visits nested numeric rules in mixed candidates before selecting an array",
    make: () => ({ "pick|1": [1, { "n|4-6": 0 }, [{ "n|-2-0": 0 }, false]] }),
    expected: { pick: [{ n: 0 }, false] },
    draws: [0.25, 0.75, 0.9],
  },
  {
    name: "single candidate pick still consumes its natural draw",
    make: () => ({ "pick|1": [{ "n|1-3": 0 }], "sibling|1-3": 0 }),
    expected: { pick: { n: 2 }, sibling: 1 },
    draws: [0.5, 0.4, 0],
  },
  {
    name: "one-to-one array range draws before children and returns an array",
    make: () => ({ "list|1-1": [{ "n|0-9": 0 }, { "n|0-9": 0 }] }),
    expected: { list: [{ n: 1 }, { n: 7 }] },
    draws: [0.99, 0.1, 0.8],
  },
  {
    name: "zero-to-zero array range draws but does not generate its children",
    make: () => ({ "list|0-0": [{ "n|0-9": 0 }], "tail|0-9": 0 }),
    expected: { list: [], tail: 7 },
    draws: [0.7, 0.8],
  },
  {
    name: "variable repetition draws count before each full template sequence",
    make: () => ({ "list|1-3": [{ "n|0-9": 0 }, "x"], "tail|0-9": 0 }),
    expected: { list: [{ n: 2 }, "x", { n: 7 }, "x"], tail: 4 },
    draws: [0.5, 0.2, 0.8, 0.4],
  },
  {
    name: "nested repetitions preserve depth-first draws across repeated objects",
    make: () => ({
      "rows|2": [{ "batch|1-2": [{ "n|0-2": 0 }], "after|10-12": 0 }],
    }),
    expected: {
      rows: [
        { batch: [{ n: 1 }], after: 11 },
        { batch: [{ n: 0 }, { n: 2 }], after: 10 },
      ],
    },
    draws: [0, 0.25, 0.5, 0.99, 0, 0.99, 0],
  },
  {
    name: "literal at-sign keys are not value placeholders",
    make: () => ({
      "@score|2-4": 0,
      "@literal": { text: "unchanged" },
      "@arr|1": ["x", "y"],
    }),
    expected: { "@score": 3, "@literal": { text: "unchanged" }, "@arr": "y" },
    draws: [0.5, 0.8],
  },
  {
    name: "dense root arrays use no rules for their own numeric indices",
    make: () => [{ "a|2-3": 0 }, [{ "b|0-2": 0 }, 2], false],
    expected: [{ a: 2 }, [{ b: 2 }, 2], false],
    draws: [0, 0.75],
  },
  {
    name: "projected numeric keys preserve ordinary JavaScript key order",
    make: () => ({
      first: "first",
      10: "ten",
      "2|8": 0,
      "02": "leading-zero",
      last: { 名字: "中文🙂" },
    }),
    expected: {
      2: 8,
      10: "ten",
      first: "first",
      "02": "leading-zero",
      last: { 名字: "中文🙂" },
    },
    keys: ["2", "10", "first", "02", "last"],
    draws: [],
  },
  {
    name: "null-prototype input objects preserve values and own key order",
    make: () => {
      const root = Object.create(null);
      root["b|2-2"] = 0;
      root["@literal"] = "unchanged";
      root.inner = Object.create(null);
      root.inner["n|1-3"] = 0;
      root.inner["arr|1-1"] = [{ label: "子" }];
      return root;
    },
    expected: {
      b: 2,
      "@literal": "unchanged",
      inner: { n: 2, arr: [{ label: "子" }] },
    },
    draws: [0.9, 0.5, 0.3],
  },
];

for (const fixture of cases)
  test("script Mock admitted-core reference: " + fixture.name, () => {
    const adaptedInput = fixture.make();
    const referenceInput = fixture.make();
    const adapted = withDraws(fixture.draws, () =>
      createScriptMockGenerator()(adaptedInput),
    );
    const reference = withDraws(fixture.draws, () => Mock.mock(referenceInput));
    assert.deepEqual(
      reference.value,
      fixture.expected,
      "explicit public-core oracle",
    );
    assert.deepEqual(adapted.value, fixture.expected);
    assert.deepEqual(adapted.value, reference.value);
    assert.deepEqual(orderedKeys(adapted.value), orderedKeys(reference.value));
    assert.deepEqual(orderedKeys(adapted.value), orderedKeys(fixture.expected));
    if (fixture.keys)
      assert.deepEqual(Object.keys(adapted.value), fixture.keys);
    assert.deepEqual(
      reference.trace,
      fixture.draws,
      "public core must consume the complete expected draw sequence",
    );
    assert.deepEqual(
      adapted.trace,
      reference.trace,
      "adaptation must retain every draw and its order",
    );
    assert.deepEqual(
      adaptedInput,
      fixture.make(),
      "adaptation mutated its input",
    );
    assert.deepEqual(
      referenceInput,
      fixture.make(),
      "reference mutated its admitted input",
    );
    assertFreshContainers(adaptedInput, adapted.value);
    assertFreshContainers(referenceInput, reference.value);
  });

test("script Mock admitted core returns fresh independent trees across calls on one generator", () => {
  const make = () => ({
    "rows|2": [{ value: "x" }],
    nested: { count: 2 },
    array: [{ flag: false }],
  });
  const adaptedInput = make();
  const referenceInput = make();
  const run = (generate, input) => {
    const first = generate(input);
    const second = generate(input);
    assertFreshContainers(input, { first, second });
    first.rows[0].value = "changed-output";
    first.nested.count = 999;
    first.array[0].flag = true;
    assert.equal(first.rows[1].value, "x");
    assert.equal(second.rows[0].value, "x");
    assert.equal(second.nested.count, 2);
    assert.equal(second.array[0].flag, false);
    assert.deepEqual(input, make());
    return { first, second };
  };
  const adapted = withDraws([], () =>
    run(createScriptMockGenerator(), adaptedInput),
  );
  const reference = withDraws([], () =>
    run((input) => Mock.mock(input), referenceInput),
  );
  assert.deepEqual(adapted.value, reference.value);
  assert.deepEqual(orderedKeys(adapted.value), orderedKeys(reference.value));
  assert.deepEqual(adapted.trace, []);
  assert.deepEqual(reference.trace, []);
});

test("script Mock admitted factory captures its random source while retaining the locked reference sequence", () => {
  const draws = [0.25, 0.75];
  const captured = withDraws(draws, () => createScriptMockGenerator());
  assert.deepEqual(captured.trace, [], "factory creation itself must not draw");
  const adapted = withDraws([], () => [
    captured.value({ "n|0-2": 0 }),
    captured.value({ "n|0-2": 0 }),
  ]);
  const reference = withDraws(draws, () => [
    Mock.mock({ "n|0-2": 0 }),
    Mock.mock({ "n|0-2": 0 }),
  ]);
  assert.deepEqual(adapted.value, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(adapted.value, reference.value);
  assert.deepEqual(
    adapted.trace,
    [],
    "later ambient random source must not be consulted",
  );
  assert.deepEqual(captured.trace, draws);
  assert.deepEqual(reference.trace, draws);
});
