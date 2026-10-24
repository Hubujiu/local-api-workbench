import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  importDocument,
  exportOpenAPI,
  normalizeRequest,
} from "../src/core.mjs";

const source = (
  schema,
  example,
  mime = "application/x-www-form-urlencoded",
) => ({
  openapi: "3.1.0",
  paths: {
    "/form": {
      post: {
        requestBody: { content: { [mime]: { schema, example } } },
        responses: { 200: { description: "OK" } },
      },
    },
  },
});
const media = (request) =>
  Object.values(
    exportOpenAPI({ name: "Forms", requests: [request] }).paths["/form"].post
      .requestBody.content,
  )[0];

test("form root constraints and annotations survive export and reimport without broadening validation", () => {
  for (const mime of [
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ]) {
    const schema = {
      type: "object",
      title: "Closed form",
      description: "retain root",
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 2,
      properties: {
        a: { type: "string", minLength: 2 },
        b: { type: "number" },
      },
      required: ["a"],
      "x-note": { $ref: "literal" },
    };
    const [request] = importDocument(source(schema, { a: "ab", b: 1 }, mime));
    const exported = media(JSON.parse(JSON.stringify(request)));
    assert.deepEqual(exported.schema, schema);
    const ajv = new Ajv2020({ strict: false });
    const original = ajv.compile(schema),
      restored = ajv.compile(exported.schema);
    for (const value of [
      {},
      { a: "x" },
      { a: "ab" },
      { a: "ab", b: 1 },
      { a: "ab", extra: "x" },
      null,
      [],
    ])
      assert.equal(restored(value), original(value), JSON.stringify(value));
    assert.deepEqual(
      importDocument(source(exported.schema, exported.example, mime))[0].schema,
      schema,
    );
  }
});

test("example-only fields do not become schema declarations and relax a closed form", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  const [request] = importDocument(
    source(schema, { a: "x", extra: "payload only" }),
  );
  assert.equal(
    request.form.find((f) => f.key === "extra").schemaDefined,
    false,
  );
  const exported = media(request);
  assert.deepEqual(exported.schema, schema);
  assert.deepEqual(exported.example, { a: "x", extra: "payload only" });
  assert.equal(
    new Ajv2020({ strict: false }).compile(exported.schema)(exported.example),
    false,
  );
  assert.equal(
    importDocument(source(exported.schema, exported.example))[0].form.find(
      (f) => f.key === "extra",
    ).schemaDefined,
    false,
  );
  request.form.find((f) => f.key === "extra").schemaDefined = true;
  assert.deepEqual(media(request).schema.properties.extra, {});
});

test("unrepresented required names and absent object type are preserved", () => {
  const schema = {
    properties: { a: { type: "string" } },
    required: ["ghost"],
    additionalProperties: false,
  };
  const [request] = importDocument(source(schema, { a: "x" }));
  assert.deepEqual(media(request).schema, schema);
});

test("file schema constraints and extensions survive multipart export", () => {
  const file = {
    type: "string",
    format: "binary",
    minLength: 1,
    maxLength: 50,
    "x-purpose": "attachment",
  };
  const [request] = importDocument(
    source(
      {
        type: "object",
        properties: { upload: file },
        additionalProperties: false,
      },
      {},
      "multipart/form-data",
    ),
  );
  assert.equal(request.form[0].type, "file");
  assert.deepEqual(media(request).schema.properties.upload, file);
});

test("unsupported 3.1 form root keywords are rejected by 3.0 export rather than discarded", () => {
  const [request] = importDocument(
    source(
      {
        type: "object",
        properties: { a: { type: "string" } },
        unevaluatedProperties: false,
      },
      {},
    ),
  );
  assert.throws(() => media(request), /unevaluatedProperties/);
});

test("explicitly disabled or removed declared fields stay removed while root constraints remain", () => {
  const [request] = importDocument(
    source(
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a", "b"],
        minProperties: 1,
      },
      {},
    ),
  );
  request.form[0].enabled = false;
  let exported = media(request).schema;
  assert.deepEqual(exported.required, ["b"]);
  assert.equal(Object.hasOwn(exported.properties, "a"), false);
  assert.equal(exported.minProperties, 1);
  request.form = [];
  exported = media(request).schema;
  assert.equal(Object.hasOwn(exported, "required"), false);
  assert.equal(exported.minProperties, 1);
});

test("new native forms retain generated object schema and duplicate payload keys still fail", () => {
  const request = normalizeRequest({
    url: "http://localhost/form",
    method: "POST",
    bodyType: "urlencoded",
    form: [{ key: "a", value: "x" }],
  });
  assert.deepEqual(media(request).schema, {
    type: "object",
    properties: { a: { type: "string" } },
  });
  request.form = [
    { key: "x", value: "a", schemaDefined: false },
    { key: "x", value: "b", schemaDefined: false },
  ];
  assert.throws(() => media(request), /重复表单键/);
});

test("non-object form root types fail explicitly", () => {
  for (const type of ["string", "array", ["object", "null"]])
    assert.throws(() => importDocument(source({ type }, {})), /表单.*object/);
});
