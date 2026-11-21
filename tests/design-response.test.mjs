import assert from "node:assert/strict";
import test from "node:test";
import {
  designResponsePanel,
  editDesignResponseHeader,
  scopedResponseExamples,
  supportsDesignExamples,
  responseSelection,
} from "../public/design-response.js";

const definitions = [
  {
    status: "200",
    description: "成功",
    content: { "application/json": { schema: { type: "object" } } },
  },
  {
    status: "404",
    description: "失败",
    content: {
      "text/plain": { schema: { type: "string" } },
      "application/json": { schema: false },
    },
  },
];

test("select by status identity and keep only an existing media choice", () => {
  const unchanged = structuredClone(definitions);
  const selected = responseSelection(definitions.toReversed(), {
    status: "404",
    media: "application/json",
  });
  assert.equal(selected.index, 0);
  assert.equal(selected.media, "application/json");
  assert.equal(
    responseSelection(definitions, { status: "404", media: "missing" }).media,
    "text/plain",
  );
  assert.deepEqual(definitions, unchanged);
});

test("do not invent statuses for a new request; preserve the editable raw area", () => {
  const html = designResponsePanel([]);
  assert.doesNotMatch(html, /200|404|role="tabpanel"/);
  assert.match(html, /new-response-schema/);
  assert.match(html, /response-definitions/);
});

test("preview safely escapes names and supports boolean JSON Schema without replacing it", () => {
  const html = designResponsePanel(
    [{ ...definitions[1], description: "<svg>" }],
    { status: "404", media: "application/json" },
  );
  assert.match(html, /&lt;svg&gt;（404）/);
  assert.match(html, /design-response-kind">false</);
  assert.doesNotMatch(html, /<svg>/);
});

test("response Header edits preserve other header identities, media and raw contract data", () => {
  const trace = {
    schema: { type: "string", minLength: 2 },
    example: "abc",
    "x-flag": false,
  };
  const original = {
    ...definitions[1],
    headers: {
      "X-Trace": trace,
      "X-Other": { $ref: "#/components/headers/Example" },
    },
  };
  const updated = editDesignResponseHeader(original, "X-Trace", "x-trace", {
    ...trace,
    example: "xyz",
  });
  assert.equal(updated.headers["x-trace"].example, "xyz");
  assert.equal(original.headers["X-Trace"].example, "abc");
  assert.deepEqual(updated.headers["X-Other"], original.headers["X-Other"]);
  assert.deepEqual(updated.content, original.content);
  assert.throws(
    () => editDesignResponseHeader(original, null, "x-TRACE", trace),
    /同名响应头/,
  );
  assert.throws(
    () => editDesignResponseHeader(original, "X-Trace", "x-other", trace),
    /同名响应头/,
  );
  assert.throws(
    () => editDesignResponseHeader(original, null, "bad header", trace),
    /有效的响应头/,
  );
  assert.throws(
    () => editDesignResponseHeader(original, null, "Content-Type", trace),
    /媒体类型/,
  );
  assert.throws(
    () => editDesignResponseHeader(original, null, "X-Four", ["bad"]),
    /JSON 对象/,
  );
  assert.equal(
    editDesignResponseHeader(original, null, "__proto__", trace).headers
      .__proto__,
    trace,
  );
  assert.equal(
    Object.getPrototypeOf(
      editDesignResponseHeader(original, null, "__proto__", trace).headers,
    ),
    Object.prototype,
  );
});

test("Design examples respect status, media, and managed versus raw inline definitions", () => {
  const list = [
    { status: 200 },
    { status: 404, headers: { "Content-Type": "text/plain" } },
    { status: 404 },
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "content-type": "text/plain",
      },
    },
  ];
  assert.deepEqual(
    scopedResponseExamples(list, "404", "application/json").map(
      (row) => row.index,
    ),
    [2],
  );
  const response = {
    status: "404",
    content: {
      "application/json": { example: null },
      "text/plain": {},
      "application/problem+json": {},
    },
  };
  assert.equal(
    supportsDesignExamples(response, "application/json", false),
    false,
  );
  assert.equal(
    supportsDesignExamples(response, "application/json", true),
    true,
  );
  assert.equal(supportsDesignExamples(response, "text/plain", true), false);
  assert.equal(
    supportsDesignExamples(response, "application/problem+json", false),
    true,
  );
  assert.equal(
    supportsDesignExamples(
      { ...response, status: "4XX" },
      "application/json",
      true,
    ),
    false,
  );
});

test("JSON recognition does not flatten parameterized profile identity", () => {
  const plain = "application/problem+json";
  const profile =
    'application/problem+json; profile="https://example.invalid/errors"';
  const response = { status: "404", content: { [plain]: {}, [profile]: {} } };
  assert.equal(supportsDesignExamples(response, profile, false), true);
  assert.equal(
    supportsDesignExamples(
      { status: "404", content: { "text/plain; note=json": {} } },
      "text/plain; note=json",
      false,
    ),
    false,
  );
  const examples = [
    { status: 404, headers: { "content-type": plain } },
    { status: 404, headers: { "Content-Type": profile } },
  ];
  assert.deepEqual(
    scopedResponseExamples(examples, 404, plain).map((x) => x.index),
    [0],
  );
  assert.deepEqual(
    scopedResponseExamples(examples, 404, profile).map((x) => x.index),
    [1],
  );
});
