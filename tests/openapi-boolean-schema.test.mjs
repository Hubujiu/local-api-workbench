import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  exportOpenAPI,
  normalizeRequest,
  resolveLocalReferences,
  sampleFromSchema,
} from "../src/core.mjs";
const document = (schema) => ({
  openapi: "3.1.0",
  paths: {
    "/item": {
      post: {
        requestBody: {
          content: { "application/json": { schema, example: null } },
        },
        responses: { 200: { description: "OK" } },
      },
    },
  },
});
const exportedBody = (request, extra = {}) =>
  exportOpenAPI({ name: "Boolean schema", requests: [request], ...extra })
    .paths["/item"].post.requestBody.content["application/json"];

test("boolean request schemas survive normalization, import and workbench JSON persistence", () => {
  for (const schema of [false, true]) {
    assert.equal(normalizeRequest({ schema }).schema, schema);
    const [request] = importDocument(document(schema));
    assert.equal(request.schema, schema);
    assert.equal(
      normalizeRequest(JSON.parse(JSON.stringify(request))).schema,
      schema,
    );
  }
  assert.throws(
    () => sampleFromSchema(importDocument(document(false))[0].schema),
    /禁止/,
  );
});

test("local boolean schema references retain their constraints and compatible siblings", () => {
  const base = {
    components: { schemas: { Never: false, Any: true } },
    never: {
      $ref: "#/components/schemas/Never",
      type: "string",
      description: "keep annotation",
    },
    any: { $ref: "#/components/schemas/Any" },
    limited: { $ref: "#/components/schemas/Any", type: "string" },
  };
  const resolved = resolveLocalReferences(base);
  assert.deepEqual(resolved.never, {
    allOf: [false, { type: "string", description: "keep annotation" }],
  });
  assert.equal(resolved.any, true);
  assert.deepEqual(resolved.limited, { type: "string" });
});

test("OpenAPI 3.0 export uses object equivalents instead of weakening boolean request schemas", () => {
  for (const [schema, expected] of [
    [false, { not: {} }],
    [true, {}],
  ]) {
    const [request] = importDocument(document(schema));
    const media = exportedBody(request);
    assert.deepEqual(media.schema, expected);
    assert.equal(media.example, null);
    assert.equal(request.schema, schema);
  }
});

test("schema conversion follows schema positions, preserving boolean data and permitted additionalProperties", () => {
  const schema = {
    type: "object",
    properties: {
      blocked: false,
      allowed: true,
      list: { type: "array", items: false },
    },
    allOf: [true],
    additionalProperties: false,
    example: { schema: false, properties: { x: true } },
  };
  const [request] = importDocument(document(schema));
  const converted = exportedBody(request).schema;
  assert.deepEqual(converted.properties.blocked, { not: {} });
  assert.deepEqual(converted.properties.allowed, {});
  assert.deepEqual(converted.properties.list.items, { not: {} });
  assert.deepEqual(converted.allOf, [{}]);
  assert.equal(converted.additionalProperties, false);
  assert.deepEqual(converted.example, schema.example);
  assert.deepEqual(request.schema, schema);
});

test("OpenAPI parameter, response, component and named callback schemas are converted without touching examples", () => {
  const doc = document(false);
  doc.paths["/item"].post.parameters = [
    { name: "blocked", in: "query", schema: false },
  ];
  doc.paths["/item"].post.responses[200].content = {
    "application/json": { schema: false, example: false },
  };
  doc.paths["/item"].post.callbacks = {
    schema: {
      "{$request.query.callback}": {
        post: {
          requestBody: { content: { "application/json": { schema: false } } },
          responses: { 200: { description: "ok" } },
        },
      },
    },
  };
  const requests = importDocument(doc);
  assert.equal(requests[0].query[0].schema, false);
  const out = exportOpenAPI({
    name: "fixture",
    requests,
    openapiComponents: {
      schemas: { Never: false },
      examples: { schema: { value: { schema: false } } },
    },
  });
  assert.deepEqual(out.paths["/item"].post.parameters[0].schema, { not: {} });
  assert.deepEqual(
    out.paths["/item"].post.responses[200].content["application/json"].schema,
    { not: {} },
  );
  assert.equal(
    out.paths["/item"].post.responses[200].content["application/json"].example,
    false,
  );
  assert.deepEqual(out.components.schemas.Never, { not: {} });
  assert.deepEqual(out.components.examples.schema.value, { schema: false });
  assert.deepEqual(
    out.paths["/item"].post.callbacks.schema["{$request.query.callback}"].post
      .requestBody.content["application/json"].schema,
    { not: {} },
  );
});

test("form schemas retain forbidden properties and explicit boolean root constraints", () => {
  for (const root of [
    false,
    true,
    { type: "object", properties: { blocked: false } },
  ]) {
    const doc = document(root);
    doc.paths["/item"].post.requestBody.content = {
      "application/x-www-form-urlencoded": { schema: root, example: {} },
    };
    const [request] = importDocument(doc);
    const schema = exportOpenAPI({ name: "forms", requests: [request] }).paths[
      "/item"
    ].post.requestBody.content["application/x-www-form-urlencoded"].schema;
    if (typeof root === "boolean")
      assert.deepEqual(schema, root ? {} : { not: {} });
    else assert.deepEqual(schema.properties.blocked, { not: {} });
  }
});

test("OpenAPI 3.0 export rejects unsupported schema dialect constructs instead of silently weakening them", () => {
  for (const schema of [
    { const: false },
    { type: ["string", "null"] },
    { exclusiveMinimum: 2 },
    { prefixItems: [false] },
  ]) {
    const [request] = importDocument(document(schema));
    assert.throws(() => exportedBody(request), /OpenAPI 3\.0/);
    assert.deepEqual(request.schema, schema);
  }
  const [legacy] = importDocument(
    document({ type: "number", minimum: 2, exclusiveMinimum: true }),
  );
  assert.deepEqual(exportedBody(legacy).schema, {
    type: "number",
    minimum: 2,
    exclusiveMinimum: true,
  });
});

test("schema conversion rejects cyclic/deep inputs with a bounded error and invalid local reference targets", () => {
  const recursive = { type: "object", properties: {} };
  recursive.properties.again = recursive;
  const request = normalizeRequest({
    url: "http://localhost/item",
    method: "POST",
    bodyType: "json",
    body: "{}",
    schema: recursive,
  });
  assert.throws(() => exportedBody(request), /上限/);
  assert.throws(
    () =>
      resolveLocalReferences({
        components: { schemas: { Invalid: 0 } },
        schema: { $ref: "#/components/schemas/Invalid" },
      }),
    /引用目标/,
  );
});

test("real project save, server restart and export retain a forbidden schema without broadening it", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "boolean-schema-persist-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    if (app.server.listening)
      await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", body) => {
    const result = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(result.ok, await result.clone().text());
    return result.json();
  };
  let project = await call("/api/projects", "POST", {
    name: "Boolean schema persistence",
  });
  project.requests = importDocument(document(false));
  project = await call("/api/projects/" + project.id, "PUT", project);
  const id = project.id;
  await new Promise((resolve) => app.server.close(resolve));
  app = await createApp({ root, port: 0 });
  const restored = await call("/api/projects/" + id);
  assert.equal(restored.requests[0].schema, false);
  const raw = await call("/api/projects/" + id + "/export");
  assert.equal(raw.requests[0].schema, false);
  const api = await call("/api/projects/" + id + "/export?format=openapi");
  assert.deepEqual(
    api.paths["/item"].post.requestBody.content["application/json"].schema,
    { not: {} },
  );
  assert.equal(api.openapi, "3.0.3");
});
