import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeOpenAPI30Schemas } from "../src/openapi-schema-export.mjs";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
} from "../src/core.mjs";
import {
  payload,
  schemaDocument,
} from "./fixtures/openapi31-schema-export.mjs";

function document(schema) {
  return {
    openapi: "3.1.0",
    paths: {
      "/item": {
        post: {
          requestBody: {
            content: { "application/json": { schema, example: {} } },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
}
const body = (doc) =>
  doc.paths["/item"].post.requestBody.content["application/json"].schema;
const convert = (schema) => body(normalizeOpenAPI30Schemas(document(schema)));

// Independent target-dialect interpretation for Ajv2020. Only Schema positions
// are visited; const/enum/example data must not be interpreted as schemas.
function asJSONSchema(schema) {
  if (typeof schema === "boolean") return schema;
  const out = { ...schema };
  assert.equal(Object.hasOwn(out, "const"), false);
  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (!Object.hasOwn(out, flag)) continue;
    assert.equal(typeof out[flag], "boolean");
    if (out[flag]) {
      assert.equal(typeof out[bound], "number");
      out[flag] = out[bound];
      delete out[bound];
    } else delete out[flag];
  }
  for (const key of ["allOf", "anyOf", "oneOf"])
    if (out[key]) out[key] = out[key].map(asJSONSchema);
  for (const key of ["items", "not", "additionalProperties"])
    if (Object.hasOwn(out, key)) out[key] = asJSONSchema(out[key]);
  if (out.properties)
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [
        key,
        asJSONSchema(value),
      ]),
    );
  return out;
}

const values = [
  null,
  false,
  true,
  "",
  "active",
  "other",
  0,
  -0,
  1,
  -1,
  2,
  2.5,
  3,
  5,
  8,
  10,
  [],
  [1, null],
  {},
  { a: 1, b: [true, null] },
  { b: [true, null], a: 1 },
];
function equivalent(source, samples = values) {
  const snapshot = structuredClone(source),
    target = convert(source);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const before = ajv.compile(source),
    after = ajv.compile(asJSONSchema(target));
  for (const value of samples)
    assert.equal(
      after(value),
      before(value),
      JSON.stringify({ source, target, value }),
    );
  assert.deepEqual(source, snapshot);
  return target;
}

test("non-null JSON constants export as equivalent singleton enums", () => {
  for (const value of [
    false,
    true,
    "",
    "active",
    0,
    -0,
    2.5,
    [1, null],
    { a: 1, b: [true, null] },
  ]) {
    assert.deepEqual(equivalent({ const: value }), { enum: [value] });
  }
});

test("constant and existing enum/allOf remain an intersection, including impossible schemas", () => {
  for (const source of [
    { const: "active", enum: ["active", "other"] },
    { const: "active", enum: ["other"] },
    { const: { a: 1, b: [true, null] }, enum: [{ b: [true, null], a: 1 }] },
    { const: "active", enum: ["active"], allOf: [{ minLength: 10 }] },
    { type: "number", const: "active" },
  ]) {
    const target = equivalent(source);
    assert.equal(Object.hasOwn(target, "const"), false);
    if (source.enum) assert.deepEqual(target.enum, source.enum);
  }
});

test("numeric exclusive bounds preserve the stricter inclusive or exclusive constraint", () => {
  for (const source of [
    { exclusiveMinimum: 2 },
    { minimum: 0, exclusiveMinimum: 2 },
    { minimum: 2, exclusiveMinimum: 2 },
    { minimum: 5, exclusiveMinimum: 2 },
    { exclusiveMaximum: 8 },
    { maximum: 10, exclusiveMaximum: 8 },
    { maximum: 8, exclusiveMaximum: 8 },
    { maximum: 5, exclusiveMaximum: 8 },
    { type: "number", exclusiveMinimum: 5, exclusiveMaximum: 2 },
    { type: "integer", exclusiveMinimum: 2.5, maximum: 8 },
    { type: "string", exclusiveMinimum: 2 },
  ])
    equivalent(source);
  assert.deepEqual(convert({ minimum: 5, exclusiveMinimum: 2 }), {
    minimum: 5,
  });
  assert.deepEqual(convert({ minimum: 2, exclusiveMinimum: 2 }), {
    minimum: 2,
    exclusiveMinimum: true,
  });
  assert.deepEqual(convert({ maximum: 5, exclusiveMaximum: 8 }), {
    maximum: 5,
  });
});

test("bound intersections agree at negative, fractional, zero, and extreme finite boundaries", () => {
  for (const bound of [
    -Number.MAX_VALUE,
    -5,
    -Number.MIN_VALUE,
    -0,
    0,
    Number.MIN_VALUE,
    0.125,
    2.5,
    Number.MAX_VALUE,
  ]) {
    for (const inclusive of [undefined, bound, -1, 1]) {
      for (const [key, ordinary] of [
        ["exclusiveMinimum", "minimum"],
        ["exclusiveMaximum", "maximum"],
      ]) {
        const source = {
          [key]: bound,
          ...(inclusive === undefined ? {} : { [ordinary]: inclusive }),
        };
        equivalent(source, [
          ...values,
          bound,
          bound - 0.125,
          bound + 0.125,
          inclusive ?? 0,
        ]);
      }
    }
  }
});

test("nested const/bounds support positive/negative composition, items and additional properties", () => {
  for (const source of [
    {
      type: "object",
      properties: {
        score: { exclusiveMinimum: 2 },
        state: { const: "active" },
      },
    },
    { type: "array", items: { const: false } },
    { type: "object", additionalProperties: { exclusiveMaximum: 3 } },
    { anyOf: [{ const: false }, { exclusiveMinimum: 2, type: "number" }] },
    { oneOf: [{ const: "active" }, { enum: ["active", "other"] }] },
    { not: { const: "active" } },
  ])
    equivalent(source, [
      ...values,
      { score: 2, state: "active" },
      { score: 3, state: "active" },
      { score: 3, state: "other" },
      [false],
      [true],
      { score: 2 },
      { score: 3 },
    ]);
});

test("reference siblings keep constant and bounds constraints as Schema Object conjunctions", () => {
  const doc = document({
    $ref: "#/components/schemas/Score",
    const: 3,
    exclusiveMinimum: 2,
  });
  doc.components = { schemas: { Score: { type: "number", maximum: 8 } } };
  const snapshot = structuredClone(doc),
    out = normalizeOpenAPI30Schemas(doc),
    target = body(out);
  assert.deepEqual(target, {
    minimum: 2,
    exclusiveMinimum: true,
    enum: [3],
    allOf: [{ $ref: "#/components/schemas/Score" }],
  });
  const ajv = new Ajv2020({ strict: false });
  const before = ajv.compile({ ...body(doc), components: doc.components });
  const after = ajv.compile({
    ...asJSONSchema(target),
    components: out.components,
  });
  for (const value of values) assert.equal(after(value), before(value));
  assert.deepEqual(doc, snapshot);
  const combined = document({
    $ref: "#/components/schemas/Score",
    const: 3,
    enum: [3, 5],
    allOf: [{ minimum: 1 }],
    exclusiveMinimum: 2,
  });
  combined.components = doc.components;
  const converted = normalizeOpenAPI30Schemas(combined);
  assert.deepEqual(body(converted).allOf, [
    { $ref: "#/components/schemas/Score" },
    { minimum: 1 },
    { enum: [3] },
  ]);
  const compoundBefore = ajv.compile({
    ...body(combined),
    components: combined.components,
  });
  const compoundAfter = ajv.compile({
    ...asJSONSchema(body(converted)),
    components: converted.components,
  });
  for (const value of values)
    assert.equal(compoundAfter(value), compoundBefore(value));
});

test("all OpenAPI Schema positions convert while schema-looking data stays opaque", () => {
  const child = { const: "active" },
    literal = {
      const: null,
      exclusiveMinimum: 2,
      properties: { type: ["string", "null"] },
    };
  const doc = document({
    ...child,
    example: literal,
    default: literal,
    "x-data": literal,
  });
  const op = doc.paths["/item"].post;
  op.parameters = [
    { in: "query", name: "state", schema: child, example: literal },
  ];
  op.responses[200].content = {
    "application/json": { schema: child, example: literal },
  };
  op.responses[200].headers = { state: { schema: child, example: literal } };
  op.callbacks = {
    next: {
      "{$request.query.next}": {
        post: {
          requestBody: { content: { "application/json": { schema: child } } },
          responses: {},
        },
      },
    },
  };
  doc.components = {
    schemas: { State: child },
    parameters: { state: op.parameters[0] },
    headers: { state: { schema: child } },
    requestBodies: { state: op.requestBody },
    responses: { state: op.responses[200] },
    callbacks: { next: op.callbacks.next },
    examples: { data: { value: literal } },
  };
  const snapshot = structuredClone(doc),
    out = normalizeOpenAPI30Schemas(doc),
    expected = { enum: ["active"] };
  const converted = out.paths["/item"].post;
  assert.deepEqual(converted.parameters[0].schema, expected);
  assert.deepEqual(
    converted.responses[200].content["application/json"].schema,
    expected,
  );
  assert.deepEqual(converted.responses[200].headers.state.schema, expected);
  assert.deepEqual(
    converted.callbacks.next["{$request.query.next}"].post.requestBody.content[
      "application/json"
    ].schema,
    expected,
  );
  assert.deepEqual(out.components.schemas.State, expected);
  for (const key of ["example", "default", "x-data"])
    assert.deepEqual(body(out)[key], literal);
  assert.deepEqual(out.components.examples.data.value, literal);
  assert.deepEqual(doc, snapshot);
  body(out).example.const = "changed";
  assert.deepEqual(doc, snapshot);
});

test("imported OpenAPI 3.1 request schemas can export and reimport without value-set changes", () => {
  const source = {
    type: "object",
    properties: {
      state: { const: "active" },
      score: {
        type: "number",
        minimum: 0,
        exclusiveMinimum: 2,
        exclusiveMaximum: 8,
      },
    },
    required: ["state", "score"],
  };
  const doc = document(source),
    snapshot = structuredClone(doc),
    requests = importDocument(doc);
  const exported = exportOpenAPI({ name: "Schema portability", requests });
  assert.equal(exported.openapi, "3.0.3");
  const [roundtrip] = importDocument(exported);
  assert.deepEqual(roundtrip.schema, body(exported));
  const ajv = new Ajv2020({ strict: false });
  const before = ajv.compile(source),
    after = ajv.compile(asJSONSchema(roundtrip.schema));
  for (const value of [
    { state: "active", score: 3 },
    { state: "active", score: 2 },
    { state: "other", score: 3 },
    {},
    null,
  ])
    assert.equal(after(value), before(value));
  assert.deepEqual(doc, snapshot);
  assert.deepEqual(requests[0].schema, source);
});

test("workflow fixture preserves referenced components, parameter and response constraints through pure project roundtrip", () => {
  const input = schemaDocument("http://127.0.0.1:12345"),
    snapshot = structuredClone(input);
  const project = { name: "Source", requests: [], environments: [] };
  importIntoProject(project, input);
  const out = exportOpenAPI(project),
    schema = body(out);
  assert.deepEqual(schema.properties.state, {
    type: "string",
    enum: ["active", "other"],
    allOf: [{ enum: ["active"] }],
  });
  assert.deepEqual(schema.properties.score, {
    type: "number",
    minimum: 2,
    exclusiveMinimum: true,
    maximum: 8,
    exclusiveMaximum: true,
  });
  assert.deepEqual(schema.properties.floor, { type: "number", minimum: 5 });
  assert.deepEqual(schema.properties.fixed, {
    enum: [{ flags: [false, null] }],
  });
  assert.deepEqual(out.paths["/item"].post.parameters[0].schema, {
    type: "integer",
    minimum: 2,
    exclusiveMinimum: true,
  });
  assert.deepEqual(
    out.paths["/item"].post.responses[200].content["application/json"].schema,
    schema,
  );
  assert.deepEqual(out.components.schemas.State, { enum: ["active"] });
  const fresh = { name: "Fresh", requests: [], environments: [] };
  importIntoProject(fresh, out);
  assert.deepEqual(fresh.requests[0].schema, schema);
  assert.deepEqual(body(exportOpenAPI(fresh)), schema);
  for (const target of [project, fresh])
    assert.deepEqual(JSON.parse(target.requests[0].body), payload);
  assert.deepEqual(input, snapshot);
});

test("existing OpenAPI 3.0 boolean exclusivity stays unchanged", () => {
  for (const schema of [
    { minimum: 2, exclusiveMinimum: true },
    { maximum: 8, exclusiveMaximum: false },
    {
      type: "number",
      minimum: 2,
      maximum: 8,
      exclusiveMinimum: false,
      exclusiveMaximum: true,
    },
  ])
    assert.deepEqual(convert(schema), schema);
});

test("null constants and unrelated unsupported dialect constructs still reject", () => {
  for (const source of [
    { const: null },
    { type: ["string", "null"] },
    { prefixItems: [false] },
    { $dynamicRef: "#item" },
  ])
    assert.throws(() => convert(source), /OpenAPI 3\.0/);
});

test("new conversions reject nonfinite numbers and malformed companion bounds", () => {
  for (const value of [NaN, Infinity, -Infinity, "2", null, {}]) {
    for (const [key, ordinary] of [
      ["exclusiveMinimum", "minimum"],
      ["exclusiveMaximum", "maximum"],
    ]) {
      assert.throws(() => convert({ [key]: value }), /OpenAPI/);
      assert.throws(() => convert({ [key]: 2, [ordinary]: value }), /OpenAPI/);
    }
  }
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    /x/,
    new Map(),
    new Set(),
    () => {},
    Symbol("x"),
    { value: undefined },
    [undefined],
    new Array(1),
  ])
    assert.throws(() => convert({ const: value }), /OpenAPI/);
  const sparse = new Array(1);
  sparse[4294967295] = false;
  assert.throws(() => convert({ const: sparse }), /OpenAPI/);
  const getter = {
    get value() {
      throw Error("getter must not execute");
    },
  };
  assert.throws(() => convert({ const: getter }), /OpenAPI/);
  const arrayGetter = [];
  Object.defineProperty(arrayGetter, "0", {
    enumerable: true,
    get() {
      throw Error("array getter must not execute");
    },
  });
  assert.throws(() => convert({ const: arrayGetter }), /OpenAPI/);
  assert.throws(() => convert({ const: "active", allOf: [] }), /非空数组/);
});

test("constant literal traversal retains existing depth/node bounds", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => convert({ const: cyclic }), /上限/);
  assert.throws(
    () => convert({ const: Array.from({ length: 50001 }, () => false) }),
    /上限/,
  );
  const original = {
    const: { enum: ["literal"], properties: { const: "literal" } },
  };
  assert.deepEqual(convert(original), { enum: [original.const] });
});
