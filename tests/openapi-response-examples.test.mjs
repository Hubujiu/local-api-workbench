import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, exportOpenAPI } from "../src/core.mjs";
import { editResponseExample } from "../public/response-example.js";
import { selectMockResponse } from "../src/mock.mjs";
const source = () => ({
  openapi: "3.1.0",
  info: { title: "Examples", version: "1" },
  servers: [{ url: "http://localhost" }],
  paths: {
    "/examples": {
      get: {
        responses: {
          200: {
            description: "Response docs",
            content: {
              "application/xml": { example: "<root>中文</root>" },
              "application/json": {
                schema: {},
                examples: {
                  nil: {
                    value: null,
                    description: "retain description",
                    "x-retained": true,
                  },
                  zero: { summary: "Zero case", value: 0 },
                  bool: { value: false },
                  external: {
                    externalValue: "https://example.invalid/not-fetched.json",
                  },
                },
              },
              "text/plain": {
                examples: { empty: { value: "" }, literal: { value: "false" } },
              },
            },
          },
        },
      },
    },
  },
});
const output = (request) =>
  exportOpenAPI({ name: "Examples", requests: [request] }).paths["/examples"]
    .get.responses;
const signature = (request) =>
  request.examples.map((e) => [
    e.name,
    e.status,
    e.headers["content-type"],
    e.body,
  ]);
test("all inline JSON and text/XML response examples are materialized without fetching external values", () => {
  const [request] = importDocument(source());
  assert.equal(request.examples.length, 6);
  assert.equal(request.openapiExampleBindingsVersion, 1);
  assert.deepEqual(
    request.examples.slice(0, 3).map((e) => e.body),
    ["null", "0", "false"],
  );
  assert(request.importNotes.some((note) => /外部/.test(note)));
  request.examples.forEach((example, index) => {
    const selected = selectMockResponse(request, {
      query: { example: String(index) },
    });
    assert.equal(selected.body, example.body);
    assert.equal(
      selected.headers["content-type"],
      example.headers["content-type"],
    );
  });
  assert.deepEqual(
    output(request)[200].content,
    source().paths["/examples"].get.responses[200].content,
  );
  const [roundtrip] = importDocument(
    exportOpenAPI({ name: "Examples", requests: [request] }),
  );
  assert.deepEqual(signature(roundtrip), signature(request));
});
test("editing, moving, deleting and adding bound response examples updates OpenAPI without stale source values", () => {
  const [request] = importDocument(source());
  const nil = request.examples.find((e) => e.name === "nil");
  request.examples[request.examples.indexOf(nil)] = editResponseExample(nil, {
    name: "Moved case",
    status: 201,
    body: '{"changed":true}',
    headers: { "content-type": "application/problem+json" },
    delayMs: 0,
  });
  request.examples = request.examples.filter((e) => e.name !== "Zero case");
  request.examples.push({
    name: "Manual text",
    status: 200,
    body: "new",
    headers: { "content-type": "text/plain" },
  });
  const responses = output(request);
  assert.equal(
    Object.hasOwn(responses[200].content["application/json"].examples, "nil"),
    false,
  );
  assert.equal(
    Object.hasOwn(responses[200].content["application/json"].examples, "zero"),
    false,
  );
  const moved = responses[201].content["application/problem+json"].examples.nil;
  assert.deepEqual(moved.value, { changed: true });
  assert.equal(moved.summary, "Moved case");
  assert.equal(moved.description, "retain description");
  assert.equal(moved["x-retained"], true);
  assert.equal(
    responses[200].content["application/json"].examples.external.externalValue,
    "https://example.invalid/not-fetched.json",
  );
  const [roundtrip] = importDocument(
    exportOpenAPI({ name: "Examples", requests: [request] }),
  );
  assert.equal(roundtrip.examples.length, 6);
  assert(
    roundtrip.examples.some(
      (e) =>
        e.name === "Moved case" &&
        e.status === 201 &&
        JSON.parse(e.body).changed,
    ),
  );
  assert(
    roundtrip.examples.some(
      (e) => e.name === "Manual text" && e.body === "new",
    ),
  );
  assert(!roundtrip.examples.some((e) => e.name === "Zero case"));
});
test("all manual examples survive export/import even with identical labels", () => {
  const [request] = importDocument(source());
  request.responses = [];
  request.openapiExampleBindingsVersion = undefined;
  request.examples = [false, 0].map((value) => ({
    name: "Same label",
    status: 200,
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
  }));
  const [roundtrip] = importDocument(
    exportOpenAPI({ name: "manual", requests: [request] }),
  );
  assert.deepEqual(
    roundtrip.examples.map((e) => [e.name, e.body]),
    [
      ["Same label", "false"],
      ["Same label", "0"],
    ],
  );
});
test("response example import rejects ambiguous, malformed, oversized and unsupported inline data", () => {
  for (const media of [
    { example: false, examples: { extra: { value: true } } },
    {
      examples: {
        wrong: { value: false, externalValue: "https://example.invalid" },
      },
    },
    { examples: [] },
    { examples: { wrong: false } },
  ]) {
    const doc = source();
    doc.paths["/examples"].get.responses[200].content = {
      "application/json": media,
    };
    assert.throws(() => importDocument(doc), /示例/);
  }
  for (const [type, value] of [
    ["application/octet-stream", "bytes"],
    ["text/plain", {}],
  ]) {
    const doc = source();
    doc.paths["/examples"].get.responses[200].content = {
      [type]: { example: value },
    };
    assert.throws(() => importDocument(doc), /示例/);
  }
  const many = source();
  many.paths["/examples"].get.responses[200].content = {
    "application/json": {
      examples: Object.fromEntries(
        Array.from({ length: 1001 }, (_, i) => [String(i), { value: i }]),
      ),
    },
  };
  assert.throws(() => importDocument(many), /1000/);
});
test("stale or duplicate managed bindings and invalid JSON wire bodies fail instead of losing data", () => {
  const [request] = importDocument(source());
  request.examples.push(structuredClone(request.examples[0]));
  assert.throws(() => output(request), /绑定/);
  request.examples.pop();
  request.examples[0].openapiExampleSource.key = "missing";
  assert.throws(() => output(request), /绑定/);
  request.examples = [
    {
      name: "invalid JSON",
      status: 200,
      body: "{bad",
      headers: { "content-type": "application/json" },
    },
  ];
  assert.throws(() => output(request), /JSON/);
});

test("raw source annotation conflicts are detected even when its flat example was deleted", () => {
  const [request] = importDocument(source());
  request.examples = request.examples.filter(
    (example) => example.name !== "nil",
  );
  request.responses[0].content["application/json"].examples.nil.value =
    "changed outside editor";
  assert.throws(() => output(request), /绑定已变化/);
});
test("visual status changes move managed bindings atomically without changing explicit per-example overrides", async () => {
  const { editRequestResponseDefinition } = await import(
    "../public/schema-editor.js"
  );
  const [request] = importDocument(source());
  request.examples[0].status = 202;
  const before = structuredClone(request);
  Object.assign(
    request,
    editRequestResponseDefinition(request, 0, {
      status: "201",
      mediaType: "application/json",
      description: "Moved response",
      schema: {},
    }),
  );
  assert.equal(before.responses[0].status, "200");
  assert.equal(request.examples[0].status, 202);
  assert(request.examples.slice(1).every((example) => example.status === 201));
  const exported = output(request);
  assert(exported[201]);
  assert(exported[202]);
  assert.throws(
    () =>
      editRequestResponseDefinition(request, 0, {
        status: "2XX",
        mediaType: "application/json",
        description: "Ambiguous",
        schema: {},
      }),
    /具体状态码/,
  );
  assert.equal(request.responses[0].status, "201");
});
test("Swagger 2 response examples retain their media and values", () => {
  const [request] = importDocument({
    swagger: "2.0",
    host: "localhost",
    schemes: ["http"],
    paths: {
      "/examples": {
        get: {
          produces: ["application/json", "text/plain"],
          responses: {
            200: {
              description: "Swagger",
              schema: { type: "string" },
              examples: { "application/json": false, "text/plain": "" },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(
    request.examples.map((example) => [
      example.headers["content-type"],
      example.body,
    ]),
    [
      ["application/json", "false"],
      ["text/plain", ""],
    ],
  );
  assert.equal(output(request)[200].content["text/plain"].example, "");
});

test("source metadata and prototype-looking example names remain data without pollution", () => {
  const doc = source(),
    response = doc.paths["/examples"].get.responses[200];
  response["x-response-note"] = { retained: true };
  response.links = {
    next: { operationId: "next", parameters: { id: "$response.body#/id" } },
  };
  response.content["application/json"].examples = JSON.parse(
    '{"__proto__":{"value":{"constructor":"literal"},"x-note":true}}',
  );
  const [request] = importDocument(doc);
  const exported = output(request)[200];
  assert.deepEqual(exported.links, response.links);
  assert.deepEqual(exported["x-response-note"], response["x-response-note"]);
  assert.deepEqual(
    exported.content["application/json"].examples["__proto__"],
    response.content["application/json"].examples["__proto__"],
  );
  assert.equal(Object.hasOwn(Object.prototype, "x-note"), false);
});
test("aggregate response body budget and explicit empty labels are preserved", () => {
  const doc = source();
  doc.paths["/examples"].get.responses[200].content = {
    "text/plain": {
      examples: {
        a: { value: "x".repeat(4 * 1024 * 1024 + 1) },
        b: { value: "y".repeat(4 * 1024 * 1024 + 1) },
      },
    },
  };
  assert.throws(() => importDocument(doc), /8MiB/);
  const [request] = importDocument(source());
  request.openapiExampleBindingsVersion = undefined;
  request.responses = [];
  request.examples = [
    {
      name: "",
      status: 200,
      body: "0",
      headers: { "content-type": "application/json" },
    },
  ];
  const [roundtrip] = importDocument(
    exportOpenAPI({ name: "empty name", requests: [request] }),
  );
  assert.equal(roundtrip.examples[0].name, "");
});
test("every imported named/text/XML example is selectable over actual HTTP after persistence", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "response-examples-"));
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
  const project = await app.store.create("Response example fixture");
  project.requests = importDocument(source());
  await app.store.save(project);
  const stored = await app.store.get(project.id),
    request = stored.requests[0];
  assert.equal(request.openapiExampleBindingsVersion, 1);
  assert.equal(request.openapiExampleSources.length, 6);
  for (const [index, example] of request.examples.entries()) {
    const response = await fetch(
      `${app.url}/mock/${project.id}/${request.id}?example=${index}`,
    );
    assert.equal(response.status, example.status);
    assert.equal(
      response.headers.get("content-type"),
      example.headers["content-type"],
    );
    assert.equal(await response.text(), example.body);
  }
  assert.deepEqual(
    output(request)[200].content,
    source().paths["/examples"].get.responses[200].content,
  );
});

test("binding versions, response shapes and empty Swagger media fail clearly while annotation key ordering is harmless", () => {
  const [request] = importDocument(source());
  assert.throws(
    () => output({ ...request, openapiExampleBindingsVersion: 2 }),
    /绑定版本/,
  );
  request.responses[0].content["application/json"].examples.nil = {
    "x-retained": true,
    description: "retain description",
    value: null,
  };
  assert.equal(
    output(request)[200].content["application/json"].examples.nil.value,
    null,
  );
  const malformed = source();
  malformed.paths["/examples"].get.responses[200] = false;
  assert.throws(() => importDocument(malformed), /响应定义/);
  assert.throws(
    () =>
      importDocument({
        swagger: "2.0",
        paths: {
          "/empty": {
            get: {
              produces: [],
              responses: { 200: { schema: { type: "string" } } },
            },
          },
        },
      }),
    /媒体/,
  );
});

test("retained external definitions and newly added cases share the export count budget", () => {
  const doc = source();
  doc.paths["/examples"].get.responses[200].content = {
    "application/json": {
      examples: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [
          String(i),
          { externalValue: "https://example.invalid/" + i },
        ]),
      ),
    },
  };
  const [request] = importDocument(doc);
  request.examples.push({
    name: "extra",
    status: 200,
    body: "0",
    headers: { "content-type": "application/json" },
  });
  assert.throws(() => output(request), /1000/);
});
