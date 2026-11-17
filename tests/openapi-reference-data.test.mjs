import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { importDocument, resolveLocalReferences } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
const doc = (example) => ({
  openapi: "3.1.0",
  components: { schemas: { Text: { type: "string" } } },
  paths: {
    "/item": {
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { type: "object" }, example },
          },
        },
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { example } },
          },
        },
      },
    },
  },
});

test("literal reference-looking request and response examples are not resolved and reach the actual wire unchanged", async (t) => {
  const payload = {
    $ref: "#/components/schemas/Text",
    label: "literal payload",
  };
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const source = doc(payload);
  source.servers = [{ url: `http://127.0.0.1:${server.address().port}` }];
  const [request] = importDocument(source);
  assert.deepEqual(JSON.parse(request.body), payload);
  assert.deepEqual(JSON.parse(request.examples[0].body), payload);
  await executeRequest(request);
  assert.deepEqual(received, payload);
  assert.deepEqual(
    source.paths["/item"].post.requestBody.content["application/json"].example,
    payload,
  );
});

test("schema annotations are literal data while identically named properties remain real schema positions", () => {
  const payload = { $ref: "https://example.invalid/literal-not-a-reference" };
  const source = doc({});
  source.paths["/item"].post.requestBody.content["application/json"].schema = {
    type: "object",
    properties: {
      example: { $ref: "#/components/schemas/Text" },
      default: { $ref: "#/components/schemas/Text" },
      value: { $ref: "#/components/schemas/Text" },
      $ref: { type: "string" },
    },
    example: payload,
    default: payload,
    enum: [payload],
    "x-debug": payload,
  };
  const [request] = importDocument(source);
  for (const key of ["example", "default", "value"])
    assert.deepEqual(request.schema.properties[key], { type: "string" });
  assert.deepEqual(request.schema.properties.$ref, { type: "string" });
  assert.deepEqual(request.schema.example, payload);
  assert.deepEqual(request.schema.default, payload);
  assert.deepEqual(request.schema.enum, [payload]);
  assert.deepEqual(request.schema["x-debug"], payload);
});

test("named Example Object references resolve without interpreting their value as another reference", () => {
  const payload = { $ref: "https://example.invalid/payload" };
  const source = doc({});
  source.components.examples = {
    Actual: { summary: "fixture", value: payload },
  };
  source.paths["/item"].post.requestBody.content["application/json"] = {
    schema: { type: "object" },
    examples: { selected: { $ref: "#/components/examples/Actual" } },
  };
  assert.deepEqual(JSON.parse(importDocument(source)[0].body), payload);
});

test("path item, request body, response and header references still resolve in their typed positions", () => {
  const source = doc({});
  source.components.headers = { Trace: { schema: { type: "string" } } };
  source.components.responses = {
    OK: {
      description: "OK",
      headers: { "x-trace": { $ref: "#/components/headers/Trace" } },
    },
  };
  source.components.requestBodies = {
    Body: {
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Text" },
          example: "hello",
        },
      },
    },
  };
  source.components.pathItems = {
    Shared: {
      post: {
        requestBody: { $ref: "#/components/requestBodies/Body" },
        responses: { 200: { $ref: "#/components/responses/OK" } },
      },
    },
  };
  source.paths = { "/item": { $ref: "#/components/pathItems/Shared" } };
  const [request] = importDocument(source);
  assert.deepEqual(request.schema, { type: "string" });
  assert.equal(request.body, '"hello"');
  assert.deepEqual(request.responses[0].headers["x-trace"], {
    schema: { type: "string" },
  });
  const external = doc({});
  external.paths["/item"].post.requestBody.content["application/json"].schema =
    { $ref: "https://example.invalid/real-schema" };
  assert.throws(() => importDocument(external), /外部/);
});

test("Swagger response example maps remain literal while schema references resolve", () => {
  const payload = { $ref: "#/definitions/Text" };
  const source = {
    swagger: "2.0",
    definitions: { Text: { type: "string" } },
    paths: {
      "/item": {
        get: {
          responses: {
            200: {
              description: "OK",
              schema: { $ref: "#/definitions/Text" },
              examples: { "application/json": payload },
            },
          },
        },
      },
    },
  };
  const resolved = resolveLocalReferences(source);
  assert.deepEqual(resolved.paths["/item"].get.responses[200].schema, {
    type: "string",
  });
  assert.deepEqual(
    resolved.paths["/item"].get.responses[200].examples["application/json"],
    payload,
  );
});

test("reference expansion has a node budget even for a shallow acyclic fan-out graph", () => {
  const schemas = { Leaf: { type: "string" } };
  let previous = "Leaf";
  for (let depth = 0; depth < 8; depth++) {
    const name = "Level" + depth;
    schemas[name] = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          "field" + index,
          { $ref: "#/components/schemas/" + previous },
        ]),
      ),
    };
    previous = name;
  }
  assert.throws(
    () =>
      resolveLocalReferences({
        openapi: "3.1.0",
        components: { schemas },
        paths: {},
      }),
    /节点上限/,
  );
});
