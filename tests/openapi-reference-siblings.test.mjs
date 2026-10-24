import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  importDocument,
  exportOpenAPI,
  resolveLocalReferences,
} from "../src/core.mjs";

function document(target, siblings = {}, mime = "application/json") {
  return {
    openapi: "3.1.0",
    components: { schemas: { Base: target } },
    paths: {
      "/item": {
        post: {
          requestBody: {
            content: {
              [mime]: {
                schema: { $ref: "#/components/schemas/Base", ...siblings },
              },
            },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
}

const cases = [
  {
    name: "minimum cannot be weakened",
    target: { type: "string", minLength: 5 },
    siblings: { minLength: 1 },
    values: ["", "x", "abcde", 1, null],
  },
  {
    name: "conflicting types stay impossible",
    target: { type: "string" },
    siblings: { type: "number" },
    values: ["x", 1, null, {}, []],
  },
  {
    name: "required sets both apply",
    target: { type: "object", required: ["a"] },
    siblings: { required: ["b"] },
    values: [{}, { a: 1 }, { b: 1 }, { a: 1, b: 1 }],
  },
  {
    name: "closed target properties are not replaced",
    target: {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    },
    siblings: { properties: { b: { type: "string" } } },
    values: [{}, { a: "x" }, { b: "x" }, { a: "x", b: "x" }],
  },
  {
    name: "sibling additionalProperties sees only sibling properties",
    target: { type: "object", properties: { a: { type: "string" } } },
    siblings: { additionalProperties: false },
    values: [{}, { a: "x" }, { b: "x" }],
  },
  {
    name: "unevaluatedProperties can see the referenced evaluation",
    target: { type: "object", properties: { a: { type: "string" } } },
    siblings: {
      properties: { b: { type: "number" } },
      unevaluatedProperties: false,
    },
    values: [
      {},
      { a: "x" },
      { a: "x", b: 1 },
      { a: "x", b: "wrong" },
      { c: 1 },
    ],
  },
  {
    name: "existing allOf and target allOf both survive",
    target: { type: "number", allOf: [{ minimum: 5 }] },
    siblings: { allOf: [{ maximum: 8 }] },
    values: [0, 5, 8, 9, "6"],
  },
  {
    name: "conditional branches do not leak across reference scope",
    target: {
      type: "object",
      if: { required: ["a"] },
      then: { required: ["b"] },
    },
    siblings: { else: { required: ["c"] } },
    values: [{}, { a: 1 }, { a: 1, b: 1 }, { c: 1 }],
  },
  {
    name: "false target remains false with sibling constraints",
    target: false,
    siblings: { type: "string" },
    values: ["", "x", 0, null],
  },
  {
    name: "true target retains sibling constraints",
    target: true,
    siblings: { type: "string", minLength: 2 },
    values: ["", "x", "xx", null],
  },
];

test("OpenAPI 3.1 resolved schemas preserve independent JSON Schema 2020 validation results", () => {
  for (const { name, target, siblings, values } of cases) {
    const source = document(target, siblings);
    const snapshot = structuredClone(source);
    const [request] = importDocument(source);
    const ajv = new Ajv2020({ strict: false });
    const original = ajv.compile({
      components: source.components,
      ...source.paths["/item"].post.requestBody.content["application/json"]
        .schema,
    });
    const resolved = ajv.compile(request.schema);
    const restored = ajv.compile(JSON.parse(JSON.stringify(request)).schema);
    for (const value of values) {
      assert.equal(
        resolved(value),
        original(value),
        `${name}: ${JSON.stringify(value)}`,
      );
      assert.equal(
        restored(value),
        original(value),
        `${name} after persistence: ${JSON.stringify(value)}`,
      );
    }
    assert.deepEqual(source, snapshot, "import does not mutate source");
  }
});

test("portable reference sibling constraints survive OpenAPI export and reimport", () => {
  const [request] = importDocument(
    document(
      { type: "string", minLength: 5 },
      { minLength: 1, maxLength: 8, description: "local description" },
    ),
  );
  const exported = exportOpenAPI({ name: "References", requests: [request] });
  const [restored] = importDocument(exported);
  const validate = new Ajv2020({ strict: false }).compile(restored.schema);
  assert.equal(validate("x"), false);
  assert.equal(validate("abcde"), true);
  assert.equal(validate("abcdefghi"), false);
  assert.equal(restored.schema.description, "local description");
});

test("annotation-only referenced multipart fields retain file classification", () => {
  const source = document({
    type: "string",
    format: "binary",
    description: "base",
  });
  source.paths["/item"].post.requestBody.content = {
    "multipart/form-data": {
      schema: {
        type: "object",
        properties: {
          upload: {
            $ref: "#/components/schemas/Base",
            description: "local",
            "x-note": { $ref: "literal" },
          },
        },
      },
    },
  };
  const [request] = importDocument(source);
  assert.equal(request.form[0].type, "file");
  assert.equal(request.form[0].requiresFile, true);
  assert.equal(request.form[0].description, "local");
  assert.deepEqual(request.form[0].schema["x-note"], { $ref: "literal" });
});

test("composed form roots and fields reject instead of becoming empty or text-only forms", () => {
  assert.throws(
    () =>
      importDocument(
        document(
          { type: "object", properties: { a: { type: "string" } } },
          { required: ["a"] },
          "multipart/form-data",
        ),
      ),
    /复杂表单/,
  );
  const source = document({ type: "string", format: "binary" });
  source.paths["/item"].post.requestBody.content = {
    "multipart/form-data": {
      schema: {
        type: "object",
        properties: {
          upload: { $ref: "#/components/schemas/Base", maxLength: 10 },
        },
      },
    },
  };
  assert.throws(() => importDocument(source), /复杂表单字段/);
});

test("malformed allOf siblings are not repaired silently by inserting the reference", () => {
  for (const allOf of [[], false, {}, null])
    assert.throws(
      () => importDocument(document({ type: "string" }, { allOf })),
      /allOf/,
    );
});

test("legacy unmarked reference helper keeps its established overlay contract", () => {
  assert.deepEqual(
    resolveLocalReferences({
      base: { type: "string", minLength: 5 },
      value: { $ref: "#/base", minLength: 1 },
    }).value,
    { type: "string", minLength: 1 },
  );
});
