import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  resolveLocalReferences,
  importIntoProject,
  exportOpenAPI,
} from "../src/core.mjs";
import { normalizeOpenAPI30Schemas } from "../src/openapi-schema-export.mjs";

const ref = "#/components/schemas/Node";
function document(siblings = { required: ["name"] }) {
  return {
    openapi: "3.1.0",
    info: { title: "Recursive" },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            next: {
              $ref: ref,
              ...siblings,
              description: "child-note",
              example: { $ref: "literal-payload" },
            },
          },
        },
      },
    },
    paths: {
      "/nodes": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: ref } } },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
}
function validate(document, schema = { $ref: ref }) {
  return new Ajv2020({ strict: false }).compile({
    components: document.components,
    ...schema,
  });
}

test("recursive 3.1 references retain sibling constraints at every recursion boundary", () => {
  const values = [
    {},
    { next: {} },
    { next: { name: "a" } },
    { next: { name: "a", next: {} } },
    { next: { name: "a", next: { name: "b" } } },
    { next: { name: "a", next: { name: "b", unexpected: true } } },
  ];
  for (const siblings of [
    { required: ["name"] },
    { minProperties: 1 },
    { required: ["name"], unevaluatedProperties: false },
  ]) {
    const source = document(siblings),
      snapshot = structuredClone(source),
      resolved = resolveLocalReferences(source);
    const before = validate(source),
      after = validate(resolved);
    for (const value of values)
      assert.equal(
        after(value),
        before(value),
        JSON.stringify({ siblings, value }),
      );
    assert.deepEqual(source, snapshot);
    const boundary =
      resolved.components.schemas.Node.properties.next.allOf[0].properties.next;
    assert.equal(boundary.description, "child-note");
    assert.deepEqual(boundary.example, { $ref: "literal-payload" });
  }
});

test("3.0 schema export uses composition instead of ignored Reference Object siblings", () => {
  const source = document(),
    snapshot = structuredClone(source);
  const exported = normalizeOpenAPI30Schemas(source);
  const next = exported.components.schemas.Node.properties.next;
  assert.equal(Object.hasOwn(next, "$ref"), false);
  assert.deepEqual(next.allOf[0], { $ref: ref });
  assert.deepEqual(next.required, ["name"]);
  assert.deepEqual(next.example, { $ref: "literal-payload" });
  assert.deepEqual(source, snapshot);
  assert.deepEqual(
    exported.paths["/nodes"].post.requestBody.content["application/json"]
      .schema,
    { $ref: ref },
  );
});

test("recursive sibling constraints survive project persistence, export and reimport", () => {
  const source = document(),
    project = { name: "Recursive", requests: [], environments: [] };
  importIntoProject(project, source);
  const exported = exportOpenAPI(JSON.parse(JSON.stringify(project)));
  const restored = { name: "Restored", requests: [], environments: [] };
  importIntoProject(restored, exported);
  const expected = validate(source);
  for (const candidate of [project, restored]) {
    const actual = validate(
      { components: candidate.openapiComponents },
      candidate.requests[0].schema,
    );
    for (const value of [
      {},
      { next: {} },
      { next: { name: "a", next: {} } },
      { next: { name: "a", next: { name: "b" } } },
    ])
      assert.equal(actual(value), expected(value));
  }
});

test("export does not repair invalid allOf siblings or non-string references", () => {
  for (const schema of [
    { $ref: ref, allOf: [] },
    { $ref: 1, description: "invalid" },
  ]) {
    const source = document();
    source.components.schemas.Bad = schema;
    assert.throws(() => normalizeOpenAPI30Schemas(source), /allOf|引用/);
  }
});

test("recursive siblings still resolve their own schema children, but never payload references", () => {
  const source = document({
    required: ["name"],
    properties: { tag: { $ref: "#/components/schemas/Tag" } },
  });
  source.components.schemas.Tag = { type: "string", pattern: "^tag-" };
  const resolved = resolveLocalReferences(source);
  const before = validate(source),
    after = validate(resolved);
  for (const value of [
    { next: { name: "a", next: { name: "b", tag: "tag-ok" } } },
    { next: { name: "a", next: { name: "b", tag: "bad" } } },
    { next: { name: "a", next: { name: "b", tag: 1 } } },
  ])
    assert.equal(after(value), before(value));
  const boundary =
    resolved.components.schemas.Node.properties.next.allOf[0].properties.next;
  assert.deepEqual(boundary.properties.tag, source.components.schemas.Tag);
  assert.deepEqual(boundary.example, { $ref: "literal-payload" });
  source.components.schemas.Node.properties.next.properties.tag.$ref =
    "https://example.invalid/schema";
  assert.throws(() => resolveLocalReferences(source), /不自动下载/);
  const deep = document();
  let current = deep.components.schemas.Node.properties.next;
  for (let i = 0; i < 55; i++) {
    current.properties = { child: { type: "object" } };
    current = current.properties.child;
  }
  assert.throws(() => resolveLocalReferences(deep), /层级过深/);
});

test("reference export preserves existing allOf and property-local constraints without flattening", () => {
  const source = document();
  source.components.schemas.Use = {
    $ref: ref,
    allOf: [{ required: ["name"] }],
    properties: { name: { type: "string" }, own: { type: "number" } },
    additionalProperties: false,
    description: "outer-note",
  };
  const exported = normalizeOpenAPI30Schemas(source);
  const use = exported.components.schemas.Use;
  assert.deepEqual(use.allOf, [{ $ref: ref }, { required: ["name"] }]);
  assert.equal(use.additionalProperties, false);
  assert.deepEqual(use.properties, source.components.schemas.Use.properties);
  assert.equal(use.description, "outer-note");
  const before = validate(source, { $ref: "#/components/schemas/Use" }),
    after = validate(exported, { $ref: "#/components/schemas/Use" });
  assert.equal(before({ name: "a", own: 1 }), true);
  assert.equal(before({ name: "a", next: {} }), false);
  for (const value of [
    {},
    { name: "a" },
    { name: "a", own: 1 },
    { own: 1 },
    { name: "a", next: {} },
  ])
    assert.equal(after(value), before(value));
});
