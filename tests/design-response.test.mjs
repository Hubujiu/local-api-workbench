import assert from "node:assert/strict";
import test from "node:test";
import {
  designResponsePanel,
  editDesignResponseHeader,
  addDesignResponseStringHeader,
  editDesignResponseRoot,
  scopedResponseExamples,
  supportsDesignExamples,
  designExampleTarget,
  prepareDesignExampleBody,
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

test("inline response header preserves literal strings and advanced siblings", () => {
  const original = {
    ...definitions[1],
    headers: {
      "X-Advanced": { $ref: "#/components/headers/Example" },
    },
  };
  const next = addDesignResponseStringHeader(original, {
    name: "  X-Fixture ",
    example: "0",
    description: "<header>",
  });
  assert.deepEqual(next.headers["X-Fixture"], {
    schema: { type: "string" },
    example: "0",
    description: "<header>",
  });
  assert.equal(next.headers["X-Advanced"], original.headers["X-Advanced"]);
  assert.equal(next.content, original.content);
  assert.equal(Object.hasOwn(original.headers, "X-Fixture"), false);
  assert.deepEqual(
    addDesignResponseStringHeader(original, { name: "X-Blank" }).headers[
      "X-Blank"
    ],
    { schema: { type: "string" } },
  );
  for (const [input, error] of [
    [{ name: "x-ADVANCED" }, /同名响应头/],
    [{ name: "bad name" }, /有效的响应头/],
    [{ name: "Content-Type" }, /媒体类型/],
    [{ name: "X-Fixture", example: 0 }, /无效/],
  ])
    assert.throws(() => addDesignResponseStringHeader(original, input), error);
  const html = designResponsePanel(
    [next],
    { status: "404", view: "headers" },
    false,
    [],
    null,
    {
      kind: "header",
      index: 0,
      status: "404",
      name: "<synthetic>",
      example: '"x"',
    },
  );
  assert.match(html, /&lt;synthetic&gt;/);
  assert.match(html, /&quot;x&quot;/);
  assert.doesNotMatch(html, /<synthetic>/);
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

test("inline example targeting is explicit for same-name rows and stable under reordering", () => {
  const one = { name: "Fixture" };
  const two = { name: "Fixture" };
  const rows = [
    { example: one, index: 4 },
    { example: two, index: 7 },
  ];
  assert.deepEqual(designExampleTarget(rows), { key: "" });
  assert.deepEqual(designExampleTarget(rows.toReversed(), one), {
    example: one,
    index: 4,
    key: "4",
  });
  assert.deepEqual(designExampleTarget(rows, { ...one }), { key: "" });
  assert.deepEqual(designExampleTarget(rows, "new"), { key: "new" });
  assert.deepEqual(designExampleTarget([]), { key: "new" });
});

test("example body edit accepts JSON roots without rewriting source bytes or unrelated metadata", () => {
  const definition = definitions[1];
  const media = "application/json";
  const original = {
    name: "Fixture",
    status: 404,
    headers: { "content-type": media, "x-fixture": "v" },
    body: "{}",
    openapiExampleSource: { key: "bound" },
  };
  for (const body of [
    "null",
    " false ",
    "0",
    '""',
    '"<x>"',
    "[1]",
    '{"i":9007199254740993}',
    "\n  [0]\n",
  ]) {
    const result = prepareDesignExampleBody(
      definition,
      media,
      true,
      original,
      body,
    );
    assert.deepEqual(result, { ...original, body });
    assert.equal(result.openapiExampleSource, original.openapiExampleSource);
    assert.equal(Object.hasOwn(result, "delayMs"), false);
  }
  assert.deepEqual(
    prepareDesignExampleBody(definition, media, true, undefined, "null"),
    {
      name: "响应示例",
      status: 404,
      headers: { "content-type": media },
      body: "null",
    },
  );
  for (const body of ["", " ", "{", "NaN", "undefined"]) {
    assert.throws(
      () => prepareDesignExampleBody(definition, media, true, original, body),
      /JSON 响应示例正文无效/,
    );
  }
  assert.throws(
    () =>
      prepareDesignExampleBody(
        definition,
        "text/plain",
        true,
        original,
        "null",
      ),
    /不属于/,
  );
  assert.throws(
    () =>
      prepareDesignExampleBody(
        { ...definition, status: "4XX" },
        media,
        true,
        undefined,
        "null",
      ),
    /不属于/,
  );
  assert.equal(original.body, "{}");
  const html = designResponsePanel(
    [definition],
    { status: "404", media, bodyView: "examples" },
    true,
    [{ ...original, body: '"</textarea>"' }],
  );
  assert.match(html, /&lt;\/textarea&gt;/);
});

test("root description and field edits preserve media, examples, constraints and sibling responses", () => {
  const json = {
    schema: {
      type: "object",
      description: "old",
      properties: { first: { type: "string", minLength: 4 } },
      required: ["first"],
      additionalProperties: false,
      "x-opaque": { sample: 1 },
    },
    example: { first: "safe" },
  };
  const response = {
    status: "404",
    description: "response-level",
    headers: { "X-Trace": { schema: { type: "string" } } },
    content: { "application/json": json, "text/plain": { schema: false } },
  };
  const saved = structuredClone(response);
  const described = editDesignResponseRoot(
    response,
    "application/json",
    "description",
    "<svg>\n各媒体独立",
  );
  const added = editDesignResponseRoot(
    described,
    "application/json",
    "add",
    "__proto__",
  );
  assert.deepEqual(added, {
    ...response,
    content: {
      ...response.content,
      "application/json": {
        ...json,
        schema: {
          ...json.schema,
          description: "<svg>\n各媒体独立",
          properties: {
            ...json.schema.properties,
            ["__proto__"]: { type: "string" },
          },
        },
      },
    },
  });
  assert.deepEqual(response, saved);
  assert.equal(
    editDesignResponseRoot(response, "application/json", "description", "old"),
    response,
  );
  assert.throws(
    () => editDesignResponseRoot(added, "application/json", "add", "first"),
    /已存在/,
  );
  assert.throws(
    () => editDesignResponseRoot(response, "text/plain", "description", "no"),
    /没有可编辑/,
  );
  assert.throws(
    () =>
      editDesignResponseRoot(response, "Application/JSON", "description", "no"),
    /没有可编辑/,
  );
  const html = designResponsePanel([added], {
    status: "404",
    media: "application/json",
  });
  assert.match(html, /&lt;svg&gt;/);
  assert.doesNotMatch(html, /<svg>/);
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /id="design-response-root-type"/);
});

test("root type editing is explicit and only converts simple portable schemas", () => {
  const response = definitions[0];
  assert.equal(
    editDesignResponseRoot(response, "application/json", "type", "object"),
    response,
  );
  assert.deepEqual(
    editDesignResponseRoot(response, "application/json", "type", "number")
      .content["application/json"].schema,
    { type: "number" },
  );
  for (const type of ["array", "null"])
    assert.throws(
      () => editDesignResponseRoot(response, "application/json", "type", type),
      /响应定义 JSON/,
    );
  for (const content of [
    { schema: { type: ["object", "null"] } },
    { schema: { type: "object", additionalProperties: false } },
    { schema: { type: "object", properties: { keep: false } } },
    { schema: { type: "object", example: {} } },
    { schema: { type: "object" }, examples: { original: { value: {} } } },
  ])
    assert.throws(
      () =>
        editDesignResponseRoot(
          { status: "200", content: { "application/json": content } },
          "application/json",
          "type",
          "array",
        ),
      /可能影响/,
    );
  for (const schema of [
    false,
    { $ref: "#/$defs/Original" },
    { $dynamicRef: "#meta" },
  ]) {
    const definition = {
      status: "200",
      content: { "application/json": { schema } },
    };
    assert.doesNotMatch(
      designResponsePanel([definition]),
      /id="design-response-root-(type|description|add)"/,
    );
  }
  const withManagedExample = designResponsePanel([response], {}, true, [
    { status: 200, headers: { "Content-Type": "application/json" } },
  ]);
  assert.doesNotMatch(withManagedExample, /id="design-response-root-type"/);
});
