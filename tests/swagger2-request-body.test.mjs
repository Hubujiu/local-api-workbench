import test from "node:test";
import assert from "node:assert/strict";
import { convertSwagger2Operation } from "../src/swagger2-request-body.mjs";
import { importOpenAPIBody, exportOpenAPIBody } from "../src/openapi-body.mjs";

const body = (schema, extra = {}) => ({
  name: "payload",
  in: "body",
  schema,
  ...extra,
});
const form = (name, type, extra = {}) => ({ name, in: "formData", type, ...extra });
const convert = (parameters, options = {}) =>
  convertSwagger2Operation(
    { swagger: "2.0", consumes: ["application/json"], ...options.document },
    options.pathItem || {},
    { parameters, ...options.operation },
  );
const imported = (parameters, options) =>
  importOpenAPIBody(convert(parameters, options).requestBody);

test("Swagger JSON bodies preserve explicit schema examples including false, zero, null and empty text", () => {
  for (const example of [false, 0, null, "", [0, false], { literal: { $ref: "#/not-a-reference" } }]) {
    const schema = { example, default: "not-the-example" };
    const source = [body(schema, { required: true, description: "Payload", "x-body": { kept: true } })];
    const before = structuredClone(source);
    const result = convert(source);
    const request = importOpenAPIBody(result.requestBody);
    assert.equal(request.bodyType, "json");
    assert.deepEqual(JSON.parse(request.body), example);
    assert.deepEqual(request.schema, schema);
    assert.equal(result.requestBody.required, true);
    assert.equal(result.requestBody.description, "Payload");
    assert.deepEqual(result.requestBody["x-body"], { kept: true });
    assert.deepEqual(source, before);
  }
});

test("Swagger absent examples retain editable JSON/text drafts, not generated or default-substituted payloads", () => {
  const json = imported([body({ type: "object", default: { server: "default" } })]);
  assert.equal(json.body, "{}");
  assert.deepEqual(json.schema.default, { server: "default" });
  const text = imported([body({ type: "string", default: "server default" })], {
    document: { consumes: ["text/plain"] },
  });
  assert.equal(text.bodyType, "raw");
  assert.equal(text.body, "");
  assert.equal(text.schema.default, "server default");
});

test("Swagger path and operation parameters override by location plus name without removing inherited entries", () => {
  const inherited = body({ example: { source: "path" } });
  const result = convert([body({ example: { source: "operation" } }), { name: "id", in: "query", type: "integer" }], {
    pathItem: { parameters: [inherited, { name: "id", in: "path", type: "string", required: true }] },
  });
  assert.equal(result.parameters.length, 3);
  assert.deepEqual(JSON.parse(importOpenAPIBody(result.requestBody).body), { source: "operation" });
  assert.equal(result.parameters[1].in, "path");
  assert.equal(result.parameters[2].in, "query");
  assert.equal(imported([], { pathItem: { parameters: [inherited] } }).body.includes("path"), true);
  for (const options of [
    { pathItem: { parameters: [inherited, inherited] } },
    { operation: { parameters: [inherited, inherited] } },
  ]) assert.throws(() => convert([], options), /Swagger.*重复/);
  assert.throws(() => convert([body({}), body({}, { name: "other" })]), /Swagger.*body/);
  assert.throws(() => convert([form("a", "string")], { pathItem: { parameters: [inherited] } }), /Swagger.*body.*formData/);
});

test("Swagger consumes uses own operation override, JSON preference and otherwise the first media without silent fallback", () => {
  const value = [body({ example: "hello" })];
  const text = imported(value, { operation: { consumes: ["text/plain; charset=utf-8"] } });
  assert.equal(text.body, "hello");
  assert.equal(text.contentType, "text/plain; charset=utf-8");
  const preferred = convert(value, { document: { consumes: ["application/octet-stream", "application/json"] } });
  assert.equal(importOpenAPIBody(preferred.requestBody).body, '"hello"');
  assert(preferred.importNotes.some((note) => note.includes("application/json")));
  assert.equal(imported(value, { document: { consumes: ["application/problem+json"] } }).bodyType, "json");
  for (const options of [
    { document: { consumes: undefined } },
    { operation: { consumes: [] } },
    { operation: { consumes: null } },
    { operation: { consumes: "application/json" } },
    { operation: { consumes: ["application/octet-stream", "text/plain"] } },
    { operation: { consumes: ["text/plain\r\nx-bad: 1"] } },
    { operation: { schemes: ["https"] } },
  ]) assert.throws(() => convert(value, options), /Swagger/);
  assert.throws(() => convert([body({ example: { not: "text" } })], { operation: { consumes: ["text/plain"] } }), /Swagger/);
});

test("Swagger scalar form defaults, required flags and constraints feed the existing form body and export pipeline", () => {
  const parameters = [
    form("name", "string", { default: "a b", required: true, description: "Person", minLength: 1, maxLength: 12, pattern: "^[a-z ]+$", "x-field": 1 }),
    form("enabled", "boolean", { default: false }),
    form("count", "integer", { default: 0, minimum: 0, maximum: 9, enum: [0, 1] }),
    form("ratio", "number", { default: 0.5, multipleOf: 0.5 }),
    form("empty", "string", { default: "" }),
  ];
  for (const media of ["application/x-www-form-urlencoded", "multipart/form-data"]) {
    const converted = convert(parameters, { operation: { consumes: [media] } });
    const request = importOpenAPIBody(converted.requestBody);
    assert.deepEqual(request.form.map((row) => row.value), ["a b", "false", "0", "0.5", ""]);
    assert.equal(request.form[0].required, true);
    assert.equal(request.form[0].description, "Person");
    assert.equal(request.form[0].schema.pattern, "^[a-z ]+$");
    assert.equal(request.form[0].schema["x-field"], 1);
    assert.deepEqual(request.form[2].schema.enum, [0, 1]);
    const exported = exportOpenAPIBody({ ...request, headers: request.contentType ? [{ key: "Content-Type", value: request.contentType }] : [], openapiOperation: converted.operation });
    const again = importOpenAPIBody(exported);
    assert.deepEqual(again.form, request.form);
    assert.equal(again.bodyType, request.bodyType);
  }
});

test("Swagger multipart file becomes a selection-required placeholder, never a path or inline payload", () => {
  const converted = convert([form("attachment", "file", { required: true, description: "Select explicitly" })], {
    operation: { consumes: ["multipart/form-data"] },
  });
  const file = importOpenAPIBody(converted.requestBody).form[0];
  assert.equal(file.type, "file");
  assert.equal(file.requiresFile, true);
  assert.equal(file.required, true);
  assert.equal(file.value, "");
  assert.equal(file.filename, "attachment");
  assert.equal(file.filePath, undefined);
  assert.equal(file.fileBase64, undefined);
  for (const extra of [{ default: "/never-read" }, { src: "/never-read" }, { example: "never-read" }])
    assert.throws(() => convert([form("file", "file", extra)], { operation: { consumes: ["multipart/form-data"] } }), /Swagger/);
  assert.throws(() => convert([form("file", "file")], { operation: { consumes: ["application/x-www-form-urlencoded"] } }), /Swagger/);
});

test("Swagger unsupported serialization and malformed parameter contracts reject instead of dropping a body", () => {
  for (const parameter of [
    form("a", "array", { items: { type: "string" }, collectionFormat: "multi" }),
    form("a", "string", { collectionFormat: "csv" }),
    form("a", "string", { items: { type: "string" } }),
    form("a", "object"),
    form("a", "string", { default: { bad: true } }),
    form("a", "boolean", { default: "false" }),
    form("a", "integer", { default: 1.5 }),
    form("a", "string", { format: "binary" }),
    form("a", "string", { allowEmptyValue: true }),
    form("a", "string", { required: "true" }),
    form("__proto__", "string"),
  ]) assert.throws(() => convert([parameter], { operation: { consumes: ["multipart/form-data"] } }), /Swagger/);
  for (const parameter of [body(undefined), body([]), body({ $ref: "#/definitions/Unresolved" }), body({ discriminator: "kind" }), body({}, { example: "not-a-body-parameter-field" })])
    assert.throws(() => convert([parameter]), /Swagger/);
  assert.throws(() => convert([body({ example: "x" })], { operation: { requestBody: {} } }), /Swagger/);
});

test("Swagger operation projection removes legacy media and transport fields and retains canonical body annotations", () => {
  const source = { consumes: ["application/json"], produces: ["application/json"], operationId: "save", description: "Keep", "x-operation": { kept: true } };
  const before = structuredClone(source);
  const result = convert([body({ example: { ok: true } }, { required: true, description: "Body" })], { operation: source });
  for (const key of ["consumes", "produces", "schemes"]) assert.equal(Object.hasOwn(result.operation, key), false);
  assert.deepEqual(result.operation.requestBody, result.requestBody);
  assert.deepEqual(result.operation["x-operation"], { kept: true });
  assert.equal(result.operation.operationId, "save");
  assert.equal(result.operation.description, "Keep");
  assert.deepEqual(source, before);
  assert.equal(imported([]).bodyType, "none");
});
