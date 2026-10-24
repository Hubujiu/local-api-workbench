import test from "node:test";
import assert from "node:assert/strict";
import { schemaMockResponse } from "../src/mock-fields.mjs";
import { selectMockResponse } from "../src/mock.mjs";
import { importDocument, exportOpenAPI } from "../src/core.mjs";
import { editResponseDefinition } from "../public/schema-editor.js";
const schema = {
  type: "object",
  properties: { source: { type: "string", enum: ["schema"] } },
  required: ["source"],
  additionalProperties: false,
};
function document(
  media = { schema },
  type = "application/json",
  status = "201",
) {
  return {
    openapi: "3.1.0",
    info: { title: "Mock schema", version: "1" },
    servers: [{ url: "http://localhost" }],
    paths: {
      "/result": {
        get: {
          responses: {
            [status]: { description: "result", content: { [type]: media } },
          },
        },
      },
    },
  };
}
test("visual and OpenAPI response content schemas drive automatic Mock without fabricated examples", () => {
  const responses = editResponseDefinition([], -1, {
    status: "201",
    mediaType: "application/json",
    description: "result",
    schema,
  });
  assert.deepEqual(JSON.parse(schemaMockResponse({}, { responses }).body), {
    source: "schema",
  });
  const [request] = importDocument(document());
  assert.deepEqual(request.examples, []);
  const result = selectMockResponse(request, {}, () =>
    schemaMockResponse({}, request),
  );
  assert.equal(result.status, 201);
  assert.deepEqual(JSON.parse(result.body), { source: "schema" });
  const exported = exportOpenAPI({ name: "test", requests: [request] });
  assert.equal(
    Object.hasOwn(
      exported.paths["/result"].get.responses[201].content["application/json"],
      "example",
    ),
    false,
  );
  assert.deepEqual(
    schemaMockResponse({}, { responses: [{ status: "202", schema }] }),
    {
      status: 202,
      body: '{"source":"schema"}',
      headers: { "content-type": "application/json" },
      delayMs: 0,
    },
  );
});
test("response schema media selection supports JSON suffixes, prefers application/json and rejects unsatisfiable or non-JSON schemas", () => {
  const response = {
    status: "201",
    content: {
      "text/plain": { schema: { type: "string" } },
      "application/problem+json": { schema },
    },
  };
  assert.equal(
    schemaMockResponse({}, { responses: [response] }).headers["content-type"],
    "application/problem+json",
  );
  response.content["application/json"] = {
    schema: { type: "boolean", const: false },
  };
  assert.equal(schemaMockResponse({}, { responses: [response] }).body, "false");
  response.content["application/json"].schema = false;
  assert.throws(() => schemaMockResponse({}, { responses: [response] }));
  for (const contentType of [
    "text/plain",
    "application/notjson",
    "application/json\r\nx: bad",
  ]) {
    assert.throws(() =>
      schemaMockResponse(
        {},
        { responses: [{ status: "200", contentType, schema }] },
      ),
    );
  }
  assert.throws(() =>
    schemaMockResponse(
      {},
      { responses: [{ status: "201", content: { "text/plain": { schema } } }] },
    ),
  );
});
test("explicit JSON falsy examples remain authoritative, while absent and wildcard-status examples are not invented as 200", () => {
  for (const value of [false, 0, null, "", {}]) {
    const [request] = importDocument(
      document({ schema, example: value }, "application/problem+json"),
    );
    assert.equal(request.examples.length, 1);
    assert.equal(request.examples[0].body, JSON.stringify(value, null, 2));
    assert.equal(
      request.examples[0].headers["content-type"],
      "application/problem+json",
    );
    const exported = exportOpenAPI({ name: "suffix", requests: [request] });
    assert.deepEqual(
      Object.keys(exported.paths["/result"].get.responses[201].content),
      ["application/problem+json"],
    );
  }
  for (const status of ["default", "2XX"]) {
    const [request] = importDocument(
      document({ example: { retained: true } }, "application/json", status),
    );
    assert.deepEqual(request.examples, []);
    assert.deepEqual(request.responses[0].content["application/json"].example, {
      retained: true,
    });
  }
});
test("imported schema-only responses are generated over actual HTTP with their status and JSON media type", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const root = await mkdtemp(join(tmpdir(), "mock-schema-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const project = await app.store.create("Schema Mock");
  project.requests = importDocument(
    document({ schema }, "application/problem+json"),
  );
  await app.store.save(project);
  const response = await fetch(
    `${app.url}/mock/${project.id}/${project.requests[0].id}`,
  );
  assert.equal(response.status, 201);
  assert.match(
    response.headers.get("content-type"),
    /^application\/problem\+json/,
  );
  const value = await response.json();
  assert.deepEqual(value, { source: "schema" });
  const validate = new Ajv().compile(schema);
  assert(validate(value), JSON.stringify(validate.errors));
});

test("OpenAPI export keeps named examples exclusive and literal text media literal", () => {
  const named = { examples: { first: { value: false }, second: { value: 0 } } };
  const [request] = importDocument(document(named));
  const out = exportOpenAPI({ name: "named", requests: [request] });
  assert.deepEqual(
    out.paths["/result"].get.responses[201].content["application/json"],
    named,
  );
  const text = exportOpenAPI({
    name: "text",
    requests: [
      {
        ...request,
        // This is an independent manual example, not a managed source edit.
        openapiExampleBindingsVersion: undefined,
        responses: [],
        examples: [
          {
            status: 200,
            body: "false",
            headers: { "Content-Type": "text/plain" },
          },
        ],
      },
    ],
  });
  assert.deepEqual(text.paths["/result"].get.responses[200].content, {
    "text/plain": { example: "false" },
  });
});

test("invalid media keys cannot reach inherited object properties during export", () => {
  const [request] = importDocument(document());
  for (const type of ["__proto__", "constructor", "application/json\r\nx: bad"])
    assert.throws(
      () =>
        exportOpenAPI({
          name: "invalid",
          requests: [
            {
              ...request,
              responses: [],
              examples: [
                {
                  status: 200,
                  body: "false",
                  headers: { "content-type": type },
                },
              ],
            },
          ],
        }),
      /Content-Type/,
    );
  assert.equal(Object.hasOwn(Object.prototype, "example"), false);
});
