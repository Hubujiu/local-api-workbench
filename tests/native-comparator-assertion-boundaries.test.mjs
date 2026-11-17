import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { expect } from "chai";
import lodash from "lodash";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import {
  compileNativeAssertions,
  normalizeNativeAssertionData,
} from "../src/native-response-assertions.mjs";

const unary = ["null", "notnull", "exist", "notexist"];
const numeric = ["lt", "lte", "gt", "gte"];
const binary = [
  "eq",
  "uneq",
  "includes",
  "unincludes",
  ...numeric,
  "belongscollection",
  "notbelongscollection",
];
const data = (compareType, compareValue, extra = {}) => ({
  type: "responseJson",
  expression: {
    path: "$.value",
    compareType,
    ...(compareValue === undefined ? {} : { compareValue }),
    ...extra,
  },
});
const assertion = (comparison, expected, extra = {}) => ({
  type: "assert",
  enabled: 1,
  name: comparison,
  data: data(comparison, expected, extra),
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });
const phase = (body, tasks, options) =>
  runNativeTaskPhase(
    tasks,
    {
      request: {},
      response: { status: 200, body },
    },
    options,
  );
const from = (type, path, comparison, expected) => ({
  ...assertion(comparison, expected, { path }),
  data: { ...data(comparison, expected, { path }), type },
});

// This is an independently composed oracle using the already locked OSS
// packages, not execution or copied implementation of the proprietary sender.
function oracle(raw, comparison, expected) {
  try {
    switch (comparison) {
      case "lt":
        expect(lodash.toNumber(raw)).below(lodash.toNumber(expected));
        break;
      case "lte":
        expect(lodash.toNumber(raw)).most(lodash.toNumber(expected));
        break;
      case "gt":
        expect(lodash.toNumber(raw)).above(lodash.toNumber(expected));
        break;
      case "gte":
        expect(lodash.toNumber(raw)).least(lodash.toNumber(expected));
        break;
      case "null":
        expect(raw).empty;
        break;
      case "notnull":
        expect(String(raw)).not.empty;
        break;
      case "exist":
        expect(raw).exist;
        break;
      case "notexist":
        expect(raw).not.exist;
        break;
      case "belongscollection":
        expect(String(raw)).oneOf(expected.split(","));
        break;
      case "notbelongscollection":
        expect(String(raw)).not.oneOf(expected.split(","));
        break;
      default:
        throw Error("unknown oracle comparator");
    }
    return true;
  } catch (error) {
    if (error.message === "unknown oracle comparator") throw error;
    return false;
  }
}
async function compareCases(cases) {
  // The production limit stays 16 tasks. Each independent phase uses at most
  // sixteen operations; no increased assertion/time/resource options.
  for (let start = 0; start < cases.length; start += 16) {
    const rows = cases.slice(start, start + 16);
    const body = Object.fromEntries(
      rows.map(([raw], index) => ["v" + index, raw]),
    );
    const result = await phase(
      JSON.stringify(body),
      rows.map(([, comparison, expected], index) =>
        assertion(comparison, expected, { path: "$.v" + index }),
      ),
    );
    assert.deepEqual(
      result.tests.map((entry) => entry.passed),
      rows.map(([raw, comparison, expected]) =>
        oracle(raw, comparison, expected),
      ),
      "oracle mismatch at " + start + ": " + JSON.stringify(rows),
    );
  }
}

test("four unary comparators alone preserve omitted expected fields; active and disabled schemas remain closed", () => {
  for (const comparison of unary) {
    const sample = data(comparison);
    assert.deepEqual(normalizeNativeAssertionData(sample), sample);
    assert.deepEqual(
      normalizeNativeAssertionData(sample, { enabled: false }),
      sample,
    );
    assert(
      !Object.hasOwn(
        compileNativeAssertions([{ name: "unary", data: sample }])[0],
        "expected",
      ),
    );
    assert.deepEqual(
      normalizeNativeAssertionData(data(comparison, "ignored")),
      data(comparison, "ignored"),
    );
    for (const invalid of [null, 1, [], {}, "\ud800", "x".repeat(65536)])
      assert.throws(() =>
        normalizeNativeAssertionData(data(comparison, invalid)),
      );
    assert.deepEqual(
      normalizeNativeAssertionData(data(comparison, "{{$unsupported}}")),
      data(comparison, "{{$unsupported}}"),
    );
    assert.deepEqual(
      normalizeNativeAssertionData(data(comparison, "{{inert}}"), {
        enabled: false,
      }),
      data(comparison, "{{inert}}"),
    );
  }
  for (const comparison of binary)
    for (const enabled of [true, false])
      assert.throws(
        () => normalizeNativeAssertionData(data(comparison), { enabled }),
        /自有/,
      );
  for (const comparison of [
    "unsupportedComparison",
    "regex",
    "empty",
    "contains",
    "bogus",
  ])
    for (const enabled of [true, false])
      assert.throws(() =>
        normalizeNativeAssertionData(data(comparison, "x"), { enabled }),
      );
  const unset = data(undefined, "");
  delete unset.expression.compareType;
  assert.deepEqual(
    normalizeNativeAssertionData(unset, { enabled: false }),
    unset,
  );
  delete unset.expression.compareValue;
  assert.throws(
    () => normalizeNativeAssertionData(unset, { enabled: false }),
    /自有/,
  );
  assert.throws(() =>
    normalizeNativeAssertionData(
      data("exist", undefined, { compareValue: undefined }),
    ),
  );
});

test("omitted unary values never read inherited getters; own literal/accessor restrictions persist", () => {
  let reads = 0;
  Object.defineProperty(Object.prototype, "compareValue", {
    configurable: true,
    get() {
      reads++;
      throw Error("inherited");
    },
  });
  try {
    for (const comparison of unary) {
      const normalized = normalizeNativeAssertionData(data(comparison));
      assert(!Object.hasOwn(normalized.expression, "compareValue"));
      assert(
        !Object.hasOwn(
          compileNativeAssertions([
            { name: "unary", data: data(comparison) },
          ])[0],
          "expected",
        ),
      );
    }
    assert.throws(() => normalizeNativeAssertionData(data("eq")), /自有/);
  } finally {
    delete Object.prototype.compareValue;
  }
  const sample = data("exist");
  Object.defineProperty(sample.expression, "compareValue", {
    enumerable: true,
    get() {
      reads++;
      throw Error("own");
    },
  });
  assert.throws(() => normalizeNativeAssertionData(sample), /访问器/);
  assert.equal(reads, 0);
});

test("native numeric relationships match locked Lodash/Chai across raw primitives and literal conversions", async () => {
  const values = [
    undefined,
    null,
    false,
    true,
    0,
    -0,
    1,
    -1,
    2.5,
    "",
    " ",
    "\t\r\n",
    "\u00a0\ufeff",
    "-0",
    "+12",
    "1e2",
    "0x10",
    "0b11",
    "0o10",
    "-0x1",
    "0b2",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e999",
    "雪",
    "1_000",
    "1,2",
    "\u200b",
  ];
  const expected = [
    "0",
    "1",
    "-1",
    "",
    "0x10",
    "0b11",
    "0o10",
    "NaN",
    "Infinity",
    "-Infinity",
  ];
  const samples = [...values];
  for (let index = -300; index <= 300; index++)
    samples.push(String(index), " " + index + " ", index + "e2");
  for (const raw of samples)
    assert(
      Object.is(Number(raw), lodash.toNumber(raw)),
      "conversion: " + String(raw),
    );
  const cases = [];
  // Four relations for every conversion edge, plus all expected-literal edges.
  for (const raw of values)
    for (const comparison of numeric) cases.push([raw, comparison, "0"]);
  for (const literal of expected)
    for (const raw of [null, undefined, false, true, "1", "Infinity"])
      for (const comparison of numeric) cases.push([raw, comparison, literal]);
  await compareCases(cases);
});

test("native unary raw-empty and existence distinctions match locked Chai including completed type failures", async () => {
  const values = [
    undefined,
    null,
    false,
    true,
    0,
    -0,
    1,
    "",
    " ",
    "null",
    "undefined",
    "0",
    "雪",
    "NaN",
  ];
  await compareCases(
    values.flatMap((raw) => unary.map((comparison) => [raw, comparison])),
  );
  const result = await phase('{"value":false}', [
    assertion("null"),
    assertion("notnull"),
    assertion("exist"),
    assertion("notexist"),
    script("pm.environment.set('continued',true);"),
  ]);
  assert.deepEqual(
    result.tests.map((row) => row.passed),
    [false, true, true, false],
  );
  assert.equal(result.scopes.environment.continued, true);
});

test("native collection membership matches exact split-token OSS oracle without CSV or normalization", async () => {
  const values = [
    undefined,
    null,
    false,
    true,
    0,
    "",
    "a",
    " a",
    "a ",
    "A",
    ",",
    "a,b",
    '"a"',
    "雪",
    "é",
    "e\u0301",
    "\0",
  ];
  const lists = [
    "",
    ",",
    ",a,",
    "a,,b",
    "a,b",
    " a,b ",
    "A,a",
    '"a,b",c',
    "null,undefined,false,true,0",
    "雪,é",
    "e\u0301,\0",
  ];
  await compareCases(
    values.flatMap((raw) =>
      lists.flatMap((list) => [
        [raw, "belongscollection", list],
        [raw, "notbelongscollection", list],
      ]),
    ),
  );
});

test("new comparators keep selected-source errors outside callbacks, including notexist", async (t) => {
  for (const body of ['{"value":{}}', '{"value":[]}', '{"value":1e999}'])
    for (const comparison of ["null", "notexist", "lte", "belongscollection"])
      await assert.rejects(
        phase(body, [assertion(comparison, "Infinity")]),
        /有限JSON原始值/,
      );
  await assert.rejects(phase("bad JSON", [assertion("notexist")]), /严格JSON/);
  await assert.rejects(
    phase("<root/>", [
      from("responseXml", "string(/root/missing)", "notexist"),
    ]),
    /恰好/,
  );
  await assert.rejects(
    phase("body", [
      script("delete response.body;"),
      from("responseText", "", "notexist"),
    ]),
    /正文|字符串/,
  );
  await assert.rejects(
    phase("body", [from("responseHeader", "absent", "notexist")]),
    /传输证据/,
  );
  const server = http.createServer((_req, res) => {
    res.setHeader("x-duplicate", ["a", "b"]);
    res.end("body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await executeRequest({
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  const input = { request: {}, response };
  const absent = await runNativeTaskPhase(
    [from("responseHeader", "missing", "notexist")],
    input,
  );
  assert.equal(absent.tests[0].passed, true);
  await assert.rejects(
    runNativeTaskPhase(
      [from("responseHeader", "x-duplicate", "notexist")],
      input,
    ),
    /传输证据/,
  );
  await assert.rejects(
    runNativeTaskPhase([from("responseHeader", "missing", "notexist")], {
      request: {},
      response: JSON.parse(JSON.stringify(response)),
    }),
    /传输证据/,
  );
});

test("captured Number/String/indexOf and omitted unary expected resist public mutation and preserve private failures", async () => {
  const result = await phase('{"value":"2"}', [
    script(
      "Number=()=>-99;String=()=>'';String.prototype={};Object.defineProperty(Object.prototype,'expected',{get(){throw Error('missing expected getter');}});pm.test=()=>{};",
    ),
    assertion("lt", "1"),
    assertion("gte", "2"),
    assertion("null"),
    assertion("notnull"),
    assertion("exist"),
    assertion("notexist"),
    assertion("belongscollection", "2, 3"),
    assertion("notbelongscollection", "2,3"),
    script("tests.length=0;pm.environment.set('after',true);"),
  ]);
  assert.deepEqual(
    result.tests.map((row) => row.passed),
    [false, true, false, true, true, false, true, false],
  );
  assert.equal(result.scopes.environment.after, true);
  const collection = await phase('{"value":"a,b"}', [
    script(
      "String.prototype.indexOf=()=>0;String.prototype.split=()=>['a,b'];",
    ),
    assertion("belongscollection", "a,b"),
    assertion("notbelongscollection", "a,b"),
  ]);
  assert.deepEqual(
    collection.tests.map((row) => row.passed),
    [false, true],
  );
  await assert.rejects(
    phase("bad", [script("try{"), assertion("notexist"), script("}catch{}")]),
    /未完成/,
  );
  await assert.rejects(
    phase("{}", [script("return;"), assertion("notexist")]),
    /未完成/,
  );
});

test("collection scanning and every new comparator retain source, shared test and phase quotas", async () => {
  const list = ",".repeat(64000);
  const result = await phase('{"value":""}', [
    assertion("belongscollection", list),
    assertion("notbelongscollection", list),
  ]);
  assert.deepEqual(
    result.tests.map((row) => row.passed),
    [true, false],
  );
  assert.throws(() =>
    compileNativeAssertions(
      Array.from({ length: 17 }, () => ({
        name: "limit",
        data: data("exist"),
      })),
    ),
  );
  assert.throws(
    () =>
      compileNativeAssertions(
        Array.from({ length: 5 }, () => ({
          name: "phase",
          data: data("belongscollection", list),
        })),
      ),
    /256KiB/,
  );
  await assert.rejects(
    phase("{}", [
      script('for(let i=0;i<1000;i++)pm.test.skip("prior");'),
      assertion("notexist"),
    ]),
    /1000/,
  );
  await assert.rejects(
    async () =>
      phase("{}", [assertion("null"), assertion("notexist")], {
        assertionLimit: 1,
      }),
    /断言预算/,
  );
});
