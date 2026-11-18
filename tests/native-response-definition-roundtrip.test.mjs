import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeRequest, importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { exportApipostResponses } from "../src/apipost-response-export.mjs";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";

const definition = (status, description, schema = {}) => ({
  status: String(status),
  description,
  schema,
  content: { "application/json": { schema } },
});
function project() {
  const model = {
    type: "object",
    properties: {
      message: { type: "string" },
      extra: { oneOf: [{ type: "integer" }, { type: "null" }] },
    },
    required: ["message"],
    additionalProperties: false,
    example: { $ref: "literal-not-a-schema" },
  };
  const ref = { $ref: "#/components/schemas/failure" };
  return {
    id: "source",
    name: "Responses",
    settings: {},
    environments: [{ id: "env", name: "Local", variables: {} }],
    dictionary: [{ id: "failure", name: "Responses / Failure", schema: model }],
    openapiComponents: { schemas: { failure: model } },
    requests: [
      normalizeRequest({
        id: "api",
        name: "Definitions",
        method: "GET",
        url: "http://127.0.0.1:1/not-executed",
        responses: [
          definition(204, "Empty", {}),
          definition(400, "Bad request", ref),
          definition(503, "Try later", { allOf: [ref] }),
        ],
        examples: [
          {
            name: "Empty",
            status: 204,
            headers: { "content-type": "application/json" },
            body: "",
          },
        ],
      }),
    ],
  };
}
function verify(p) {
  const request = p.requests[0];
  assert.deepEqual(request.examples, [
    {
      name: "Empty",
      status: 204,
      headers: { "content-type": "application/json" },
      body: "",
    },
  ]);
  const byStatus = Object.fromEntries(
    request.responses.map((r) => [r.status, r]),
  );
  assert.deepEqual(Object.keys(byStatus), ["204", "400", "503"]);
  const model = p.dictionary.find((m) => m.name === "Responses / Failure");
  assert(model);
  assert.equal(byStatus["400"].schema.$ref, "#/components/schemas/" + model.id);
  assert.deepEqual(byStatus["503"].schema, {
    allOf: [{ $ref: "#/components/schemas/" + model.id }],
  });
  assert.deepEqual(model.schema, p.openapiComponents.schemas[model.id]);
  assert.deepEqual(model.schema.example, { $ref: "literal-not-a-schema" });
}
test("schema-only native responses round trip with models and explicit empty examples through JSON, directory, persistence and restore", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "response-definitions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  for (const exporter of [exportApipost, exportApipostDirectory]) {
    const source = project(),
      before = structuredClone(source);
    const document = exporter(source);
    assert.deepEqual(source, before);
    const response =
      exporter === exportApipost
        ? document.apis.find((a) => a.target_type === "api").response
        : JSON.parse(
            document.files.find(
              (f) => /^apis\//.test(f.path) && f.path !== "apis/index.json",
            ).text,
          ).data.response;
    assert.equal(response.example.length, 3);
    assert.equal(response.example[0].raw, "");
    for (const item of response.example.slice(1)) {
      assert.equal(Object.hasOwn(item, "raw"), false);
      assert.equal(Object.hasOwn(item, "headers"), false);
      assert.equal(Object.hasOwn(item.expect, "sleep"), false);
    }
    assert.equal(new Set(response.example.map((x) => x.example_id)).size, 3);
    const p = await store.create("Responses");
    importIntoProject(p, document);
    verify(p);
    await store.save(p);
    const q = await store.create("Responses");
    importIntoProject(q, exporter(p));
    verify(q);
    await store.save(q);
    const restored = await store.restore(q);
    verify(restored);
    const reopened = new Store(root);
    verify(await reopened.get(p.id));
    verify(await reopened.get(q.id));
    verify(await reopened.get(restored.id));
  }
});

test("definition-only output never invents body bytes and preserves supported media", () => {
  for (const [media, native] of [
    ["application/json", "json"],
    ["application/xml", "xml"],
    ["text/html", "html"],
    ["text/plain", "text"],
  ]) {
    const schema = { type: "string" };
    const value = {
      id: "request",
      responses: [
        {
          status: "200",
          description: "Definition",
          schema,
          content: { [media]: { schema } },
        },
      ],
    };
    const before = structuredClone(value);
    const output = exportApipostResponses(value);
    assert.deepEqual(value, before);
    assert.equal(output.example.length, 1);
    assert.equal(output.example[0].expect.content_type, native);
    assert.equal(Object.hasOwn(output.example[0], "raw"), false);
    assert.deepEqual(output.example[0].expect.schema, schema);
  }
});

test("unrepresentable response definitions and combined over-budget records reject without mutation", () => {
  const invalid = [
    { id: "x", responses: [definition(400, "")] },
    { id: "x", responses: [definition(400, " ".repeat(2))] },
    { id: "x", responses: [definition(400, "x".repeat(201))] },
    {
      id: "x",
      responses: [definition(400, "X"), definition(400, "Duplicate")],
    },
    {
      id: "x",
      responses: [{ ...definition(400, "X"), headers: { "x-value": {} } }],
    },
    {
      id: "x",
      responses: [{ ...definition(400, "X"), schema: { type: "string" } }],
    },
    {
      id: "x",
      responses: Array.from({ length: 100 }, (_, i) =>
        definition(200 + i, "Definition " + i),
      ),
      examples: [
        {
          name: "Extra",
          status: 500,
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ],
    },
  ];
  for (const value of invalid) {
    const before = structuredClone(value);
    assert.throws(() => exportApipostResponses(value));
    assert.deepEqual(value, before);
  }
});

test("owner JSON and directory export expose schema-only definitions without changing persisted examples", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "response-definition-owner-"),
  );
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Responses");
  const fixture = project();
  Object.assign(p, {
    requests: fixture.requests,
    dictionary: fixture.dictionary,
    openapiComponents: fixture.openapiComponents,
  });
  await app.store.save(p);
  const before = await app.store.get(p.id);
  for (const format of ["apipost", "apipost-directory"]) {
    const url = app.url + "/api/projects/" + p.id + "/export?format=" + format;
    assert.equal((await fetch(url)).status, 403);
    const response = await fetch(url, {
      headers: { "x-local-token": app.token },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const q = await app.store.create("Responses");
    importIntoProject(q, await response.json());
    verify(q);
    assert.deepEqual(await app.store.get(p.id), before);
  }
});
