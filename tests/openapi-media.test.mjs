import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, exportOpenAPI } from "../src/core.mjs";
const source = (content) => ({
  openapi: "3.1.0",
  paths: {
    "/send": {
      post: {
        requestBody: { content },
        responses: { 200: { description: "OK" } },
      },
    },
  },
});
test("OpenAPI text/XML and JSON-suffix media retain body and content type", () => {
  for (const [media, value, type] of [
    ["text/plain", "hello", "raw"],
    ["application/xml", "<a/>", "raw"],
    ["application/problem+json", false, "json"],
  ]) {
    const [r] = importDocument(source({ [media]: { example: value } }));
    assert.equal(r.bodyType, type);
    assert.equal(r.body, type === "json" ? "false" : value);
    assert.equal(
      r.headers.find((h) => h.key.toLowerCase() === "content-type").value,
      media,
    );
  }
});
test("OpenAPI scalar forms preserve examples and multipart files require selection", () => {
  for (const media of [
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ]) {
    const [r] = importDocument(
      source({
        [media]: {
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              enabled: { type: "boolean" },
            },
            required: ["name"],
          },
          example: { name: "fixture", enabled: false },
        },
      }),
    );
    assert.equal(
      r.bodyType,
      media.startsWith("multipart") ? "form-data" : "urlencoded",
    );
    assert.equal(r.form.find((f) => f.key === "enabled").value, "false");
    assert.equal(r.form.find((f) => f.key === "name").required, true);
  }
  const [file] = importDocument(
    source({
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { file: { type: "string", format: "binary" } },
        },
      },
    }),
  );
  assert.equal(file.form[0].type, "file");
  assert.equal(file.form[0].requiresFile, true);
});
test("unsupported binary media and complex encodings fail explicitly instead of sending fake JSON", () => {
  assert.throws(() =>
    importDocument(
      source({
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      }),
    ),
  );
  assert.throws(() =>
    importDocument(
      source({
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: { tags: { type: "array", items: { type: "string" } } },
          },
        },
      }),
    ),
  );
});

test("text and scalar form media survive OpenAPI export and reimport", () => {
  for (const [media, value] of [
    ["application/xml", "<ok/>"],
    ["application/problem+json", false],
    ["application/x-www-form-urlencoded", { enabled: false, name: "a" }],
    ["multipart/form-data", { enabled: false, name: "a" }],
  ]) {
    const isForm = typeof value === "object";
    const [r] = importDocument(
      source({
        [media]: {
          example: value,
          ...(isForm
            ? {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    name: { type: "string" },
                  },
                },
              }
            : {}),
        },
      }),
    );
    const exported = exportOpenAPI({ name: "fixture", requests: [r] });
    assert(
      Object.hasOwn(exported.paths["/send"].post.requestBody.content, media),
    );
    const [again] = importDocument(exported);
    assert.equal(again.bodyType, r.bodyType);
    assert.equal(again.body, r.body);
    assert.deepEqual(again.form, r.form);
  }
});
test("text and URL encoded imported bodies arrive at a real server; unselected file is rejected", async (t) => {
  const { createServer } = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    res.end(JSON.stringify({ body, type: req.headers["content-type"] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  for (const [media, example, expected] of [
    ["application/xml", "<a/>", "<a/>"],
    ["application/x-www-form-urlencoded", { name: "a b" }, "name=a+b"],
  ]) {
    const doc = source({ [media]: { example } });
    doc.servers = [{ url: `http://127.0.0.1:${server.address().port}` }];
    const response = await executeRequest(importDocument(doc)[0]);
    assert.deepEqual(JSON.parse(response.body), {
      body: expected,
      type: media,
    });
  }
  const doc = source({
    "multipart/form-data": {
      schema: {
        type: "object",
        properties: { file: { type: "string", format: "binary" } },
      },
    },
  });
  doc.servers = [{ url: `http://127.0.0.1:${server.address().port}` }];
  await assert.rejects(
    () => executeRequest(importDocument(doc)[0]),
    /重新选择/,
  );
});

test("OpenAPI request body annotations survive media regeneration without overriding its schema", () => {
  for (const media of [
    "application/json",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ]) {
    const doc = source({
      [media]: {
        schema: { type: "object", description: "schema only", properties: {} },
        example: media === "text/plain" ? "hello" : {},
      },
    });
    Object.assign(doc.paths["/send"].post.requestBody, {
      required: true,
      description: "Body **documentation**",
      "x-owner": { name: "fixture" },
    });
    const [request] = importDocument(doc);
    const exported = exportOpenAPI({ name: "fixture", requests: [request] });
    const body = exported.paths["/send"].post.requestBody;
    assert.equal(body.required, true);
    assert.equal(body.description, "Body **documentation**");
    assert.deepEqual(body["x-owner"], { name: "fixture" });
    assert(body.content[media]);
    assert.notEqual(body.content[media].schema.description, body.description);
    body["x-owner"].name = "changed";
    assert.equal(
      request.openapiOperation.requestBody["x-owner"].name,
      "fixture",
    );
  }
});

test("OpenAPI body annotations preserve explicit false and empty values but do not resurrect a removed body", () => {
  const doc = source({ "application/json": { example: false } });
  Object.assign(doc.paths["/send"].post.requestBody, {
    required: false,
    description: "",
    "x-empty": null,
  });
  const [request] = importDocument(doc);
  const body = exportOpenAPI({ name: "fixture", requests: [request] }).paths[
    "/send"
  ].post.requestBody;
  assert.equal(body.required, false);
  assert.equal(body.description, "");
  assert.equal(body["x-empty"], null);
  request.bodyType = "none";
  assert.equal(
    exportOpenAPI({ name: "fixture", requests: [request] }).paths["/send"].post
      .requestBody,
    undefined,
  );
});

test("OpenAPI local requestBody references retain their annotations on export", () => {
  const doc = source({ "application/json": { example: 0 } });
  const shared = {
    ...doc.paths["/send"].post.requestBody,
    required: true,
    description: "Shared body",
  };
  doc.components = { requestBodies: { Shared: shared } };
  doc.paths["/send"].post.requestBody = {
    $ref: "#/components/requestBodies/Shared",
  };
  const requests = importDocument(doc);
  const body = exportOpenAPI({ name: "fixture", requests }).paths["/send"].post
    .requestBody;
  assert.equal(body.required, true);
  assert.equal(body.description, "Shared body");
  assert.equal(body.content["application/json"].example, 0);
  assert.equal(body.$ref, undefined);
});

test("OpenAPI malformed request body annotations fail explicitly instead of coercing values", () => {
  for (const annotations of [
    { required: "false" },
    { required: 0 },
    { description: {} },
  ]) {
    const doc = source({ "application/json": {} });
    Object.assign(doc.paths["/send"].post.requestBody, annotations);
    assert.throws(() => importDocument(doc), /requestBody/);
  }
});
