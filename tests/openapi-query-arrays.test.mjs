import test from "node:test";
import assert from "node:assert/strict";
import {
  assertQueryArrayCurlDefinition,
  importOpenAPIQuery,
  exportOpenAPIQueryArray,
  parseQueryArray,
  encodeQueryArray,
  validateQueryArrayRequest,
} from "../src/openapi-query-arrays.mjs";
import { appendRequestQuery } from "../src/query-serialization.mjs";
const parameter = (example, extra = {}) => ({
  name: "q",
  in: "query",
  schema: { type: "array", items: { type: "string" } },
  example,
  ...extra,
});
const row = (example, extra) =>
  importOpenAPIQuery([parameter(example, extra)])[0];

test("OAS3 default explode emits repeated independently encoded elements", () => {
  const value = row(["a,b", "c&d", "+/%", "!'()*", '引号"\\']);
  const pairs = encodeQueryArray(value);
  assert.deepEqual(pairs, [
    "q=a%2Cb",
    "q=c%26d",
    "q=%2B%2F%25",
    "q=%21%27%28%29%2A",
    "q=%E5%BC%95%E5%8F%B7%22%5C",
  ]);
  assert.deepEqual(
    [...new URLSearchParams(pairs.join("&")).values()],
    JSON.parse(value.value),
  );
  assert.deepEqual(exportOpenAPIQueryArray(value), {
    example: JSON.parse(value.value),
    style: "form",
    explode: true,
    allowReserved: false,
  });
});
test("non-exploded form preserves encoded commas inside elements and literal separators", () => {
  const value = row(["a,b", "c&d", "+/%"], { explode: false });
  assert.deepEqual(encodeQueryArray(value), ["q=a%2Cb,c%26d,%2B%2F%25"]);
  assert.deepEqual(
    encodeQueryArray(value)[0].slice(2).split(",").map(decodeURIComponent),
    ["a,b", "c&d", "+/%"],
  );
  assert.equal(exportOpenAPIQueryArray(value).explode, false);
});
test("Swagger csv default and multi preserve scalar items/default without conflating formats", () => {
  for (const collectionFormat of [undefined, "csv", "multi"]) {
    const [value] = importOpenAPIQuery(
      [
        {
          name: "q",
          in: "query",
          type: "array",
          items: { type: "integer" },
          default: [0, 2],
          ...(collectionFormat ? { collectionFormat } : {}),
        },
      ],
      { swagger: true },
    );
    assert.equal(value.schema.items.type, "integer");
    assert.deepEqual(parseQueryArray(value), [0, 2]);
    assert.deepEqual(
      encodeQueryArray(value),
      collectionFormat === "multi" ? ["q=0", "q=2"] : ["q=0,2"],
    );
  }
});
test("empty and unspecified arrays omit wire parameters but keep exportable definitions", () => {
  const explicit = row([]),
    [unspecified] = importOpenAPIQuery(
      [parameter(undefined)].map(({ example, ...rest }) => rest),
    );
  for (const value of [explicit, unspecified]) {
    assert.deepEqual(encodeQueryArray(value), []);
    assert.deepEqual(exportOpenAPIQueryArray(value).example, []);
    assert.equal(value.schema.type, "array");
  }
});
test("schema/default and single named examples retain false/zero values", () => {
  const p = parameter(undefined);
  delete p.example;
  p.schema.items.type = "boolean";
  p.schema.default = [false, true];
  assert.deepEqual(parseQueryArray(importOpenAPIQuery([p])[0]), [false, true]);
  p.schema.items.type = "integer";
  p.schema.default = [0, 2];
  assert.deepEqual(parseQueryArray(importOpenAPIQuery([p])[0]), [0, 2]);
  p.schema.items.type = "string";
  delete p.schema.default;
  p.examples = { chosen: { value: ["one", "two"] } };
  assert.deepEqual(parseQueryArray(importOpenAPIQuery([p])[0]), ["one", "two"]);
});
test("raw query spelling, ordinary rows, disabled rows and addEqual policy stay unchanged", () => {
  const url = new URL("https://example.test/a?raw=%2f+%20&flag");
  appendRequestQuery(
    url,
    [
      { key: "ordinary", value: "a b" },
      row(["a b", "+"]),
      { ...row(["hidden"]), enabled: false },
      { key: "empty", value: "" },
    ],
    false,
  );
  assert.equal(
    url.search,
    "?raw=%2f+%20&flag&ordinary=a+b&q=a%20b&q=%2B&empty",
  );
  assert.throws(() => row([""]), /空字符串元素/);
});
test("unsupported formats, ambiguous examples and lossy arrays fail explicitly", () => {
  for (const extra of [
    { style: "spaceDelimited" },
    { explode: "false" },
    { allowReserved: true },
    { collectionFormat: "multi" },
    { content: {} },
  ])
    assert.throws(() => row(["one"], extra), /OpenAPI Query数组/);
  for (const value of [[{}], [[]], [null], [""], [Number.MAX_SAFE_INTEGER + 1]])
    assert.throws(() => row(value), /OpenAPI Query数组/);
  assert.throws(
    () =>
      importOpenAPIQuery([
        { name: "x", in: "query", schema: { type: "object" } },
      ]),
    /对象Query/,
  );
  assert.throws(
    () =>
      importOpenAPIQuery(
        [
          {
            name: "x",
            in: "query",
            type: "array",
            items: { type: "string" },
            collectionFormat: "pipes",
          },
        ],
        { swagger: true },
      ),
    /multi\/csv/,
  );
  const p = parameter(undefined);
  delete p.example;
  for (const examples of [
    { a: { value: ["x"] }, b: { value: ["y"] } },
    { a: { externalValue: "https://example.test/x" } },
  ])
    assert.throws(
      () => importOpenAPIQuery([{ ...p, examples }]),
      /OpenAPI Query数组/,
    );
});
test("closed marker, schema, value size, count, Unicode and encoded budget are enforced", () => {
  const good = row(["x"]);
  for (const querySerialization of [
    null,
    {},
    { ...good.querySerialization, extra: true },
    { ...good.querySerialization, version: 2 },
  ])
    assert.throws(
      () => parseQueryArray({ ...good, querySerialization }),
      /标记/,
    );
  assert.throws(() => parseQueryArray({ ...good, value: "[" }), /JSON/);
  assert.throws(
    () =>
      parseQueryArray({
        ...good,
        value: JSON.stringify(Array(1001).fill("x")),
      }),
    /1000/,
  );
  assert.throws(
    () =>
      parseQueryArray({ ...good, value: JSON.stringify(["x".repeat(65536)]) }),
    /64KiB/,
  );
  assert.throws(() => encodeQueryArray(row(["界".repeat(8000)])), /64KiB/);
  assert.throws(() => row(["\ud800"]), /Unicode/);
  assert.throws(
    () => parseQueryArray({ ...good, schema: { type: "string" } }),
    /Schema/,
  );
  assert.throws(
    () => validateQueryArrayRequest({ query: [good], scriptURLMode: "sdk" }),
    /SDK URL/,
  );
  assert.throws(
    () => validateQueryArrayRequest({ query: [], headers: [good] }),
    /仅适用于Query/,
  );
  assert.throws(
    () =>
      exportOpenAPIQueryArray({
        ...good,
        dynamic: { source: "fixed", value: ["x"] },
      }),
    /动态数组/,
  );
});

test("supplied nulls, composed or union arrays and ambiguous example selection fail closed", () => {
  for (const extra of [
    { style: null },
    { explode: null },
    { allowReserved: null },
  ])
    assert.throws(() => row(["x"], extra), /OpenAPI Query数组/);
  assert.throws(
    () =>
      importOpenAPIQuery(
        [
          {
            name: "q",
            in: "query",
            type: "array",
            items: { type: "string" },
            collectionFormat: null,
          },
        ],
        { swagger: true },
      ),
    /multi\/csv/,
  );
  for (const schema of [
    { type: ["array", "null"], items: { type: "string" } },
    { allOf: [{ type: "array", items: { type: "string" } }] },
    { type: "string" },
    {},
  ])
    assert.throws(() => row(["a", "b"], { schema }), /OpenAPI Query数组/);
  assert.throws(
    () => row(["a"], { examples: { x: { value: ["b"] } } }),
    /不能同时提供/,
  );
  assert.throws(() => row([false]), /items不一致/);
});
test("metadata rejects accessors, hidden keys, symbols and prototypes without reading getters", () => {
  const value = row(["x"]);
  let reads = 0;
  const accessorRow = { ...value };
  Object.defineProperty(accessorRow, "querySerialization", {
    enumerable: true,
    get() {
      reads++;
      return value.querySerialization;
    },
  });
  assert.throws(() => parseQueryArray(accessorRow), /数据属性/);
  for (const marker of [
    Object.create(value.querySerialization),
    Object.defineProperty({ ...value.querySerialization }, "hidden", {
      value: true,
    }),
    { ...value.querySerialization, [Symbol("unknown")]: true },
    Object.defineProperty({ ...value.querySerialization }, "explode", {
      enumerable: true,
      get() {
        reads++;
        return true;
      },
    }),
  ])
    assert.throws(
      () => parseQueryArray({ ...value, querySerialization: marker }),
      /标记/,
    );
  assert.equal(reads, 0);
  assert.throws(() => validateQueryArrayRequest({ query: {} }), /数组/);
  assert.throws(
    () => validateQueryArrayRequest({ query: [], headers: {} }),
    /数组/,
  );
});

test("static cURL projection rejects active dynamic arrays rather than exporting stale baseline", () => {
  const value = {
    ...row(["saved"]),
    dynamic: { source: "fixed", value: ["actual"] },
  };
  assert.throws(
    () => assertQueryArrayCurlDefinition({ query: [value] }),
    /动态数组.*cURL/,
  );
  assert.doesNotThrow(() =>
    assertQueryArrayCurlDefinition({ query: [{ ...value, enabled: false }] }),
  );
});

test("CSV rejects AWS query presigning without blocking header auth, repeated arrays or omitted arrays", () => {
  const csv = row(["a,b", "c"], { explode: false });
  const presign = { type: "aws", addAuthDataToQuery: true };
  assert.throws(
    () => validateQueryArrayRequest({ query: [csv], auth: presign }),
    /AWS Query预签名/,
  );
  for (const request of [
    { query: [csv], auth: { type: "aws", addAuthDataToQuery: false } },
    { query: [row(["a,b", "c"])], auth: presign },
    { query: [row([], { explode: false })], auth: presign },
    { query: [{ ...csv, enabled: false }], auth: presign },
  ])
    assert.doesNotThrow(() => validateQueryArrayRequest(request));
});

test("unmarked boolean parameter schemas remain boolean", () => {
  for (const schema of [false, true]) {
    const imported = importOpenAPIQuery([
      { name: "q", in: "query", schema },
    ])[0];
    assert.equal(imported.schema, schema);
    assert.equal(Object.hasOwn(imported, "querySerialization"), false);
  }
});
