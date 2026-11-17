import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
  normalizeRequest,
  restoreProject,
} from "../src/core.mjs";
import { normalizeOpenAPI30Schemas } from "../src/openapi-schema-export.mjs";
import { schemaSourceKey } from "../src/openapi-schema-source.mjs";
const doc = (version, schema, path = "/item", name = "S") => ({
  openapi: version,
  info: { title: "test", version: "1" },
  paths: {
    [path]: {
      post: {
        requestBody: {
          content: { "application/json": { schema, example: "value" } },
        },
        responses: {
          200: {
            description: "ok",
            content: { "application/json": { schema } },
          },
        },
      },
    },
  },
  components: { schemas: { [name]: schema } },
});
const project = () => ({
  version: 1,
  name: "test",
  requests: [],
  environments: [],
});
const body = (out, path = "/item") =>
  out.paths[path].post.requestBody.content["application/json"].schema;
test("known source versions retain 3.0 nullable and remove inert 3.1 nullable", () => {
  for (const value of [true, false, "ignored", null, { nested: true }]) {
    const source = doc("3.1.0", { type: "string", nullable: value });
    const before = structuredClone(source);
    const p = project();
    importIntoProject(p, source);
    const out = exportOpenAPI(p);
    assert.deepEqual(body(out), { type: "string" });
    assert.deepEqual(out.components.schemas.S, { type: "string" });
    assert.deepEqual(
      out.paths["/item"].post.responses[200].content["application/json"].schema,
      { type: "string" },
    );
    assert.deepEqual(source, before);
    assert.equal(JSON.stringify(out).includes(schemaSourceKey), false);
  }
  for (const value of [true, false]) {
    const p = project();
    importIntoProject(p, doc("3.0.3", { type: "string", nullable: value }));
    assert.deepEqual(body(exportOpenAPI(p)), {
      type: "string",
      nullable: value,
    });
  }
});
test("mixed-source requests and components retain their own semantics", () => {
  const p = project();
  importIntoProject(
    p,
    doc("3.0.3", { type: "string", nullable: true }, "/old", "Old"),
  );
  importIntoProject(
    p,
    doc("3.1.0", { type: "string", nullable: true }, "/new", "New"),
  );
  const out = exportOpenAPI(p);
  assert.equal(body(out, "/old").nullable, true);
  assert.equal(Object.hasOwn(body(out, "/new"), "nullable"), false);
  assert.equal(out.components.schemas.Old.nullable, true);
  assert.equal(Object.hasOwn(out.components.schemas.New, "nullable"), false);
  const before = structuredClone(p);
  assert.throws(
    () =>
      importIntoProject(
        p,
        doc("3.1.0", { type: "string", nullable: true }, "/conflict", "Old"),
      ),
    /冲突/,
  );
  assert.deepEqual(p, before);
});
test("nested schemas and references preserve origins without interpreting literal examples", () => {
  const literal = { nullable: true, [schemaSourceKey]: "literal" };
  const schema = {
    type: "object",
    properties: { nested: { type: "string", nullable: true } },
    example: literal,
  };
  const source = doc("3.1.0", schema);
  source.paths["/item"].post.requestBody.content["application/json"].schema = {
    $ref: "#/components/schemas/S",
  };
  const p = project();
  importIntoProject(p, source);
  const out = exportOpenAPI(p);
  assert.equal(Object.hasOwn(body(out).properties.nested, "nullable"), false);
  assert.deepEqual(body(out).example, literal);
});
test("source metadata survives normalization and JSON restore; export/reimport is stable", () => {
  const p = project();
  importIntoProject(p, doc("3.0.3", { type: "string", nullable: true }));
  p.requests = p.requests.map(normalizeRequest);
  const restored = restoreProject(JSON.parse(JSON.stringify(p)));
  assert.equal(body(exportOpenAPI(restored)).nullable, true);
  const q = { ...project(), name: restored.name };
  importIntoProject(q, exportOpenAPI(restored));
  assert.deepEqual(exportOpenAPI(q), exportOpenAPI(restored));
});
test("external reserved-extension collisions reject rather than overwrite data", () => {
  for (const value of [
    "user data",
    { version: 1, dialect: "3.0", nullable: true },
  ]) {
    const source = doc("3.1.0", {
      type: "string",
      nullable: true,
      [schemaSourceKey]: value,
    });
    assert.throws(() => importDocument(source), /冲突/);
    assert.throws(() => importIntoProject(project(), source), /冲突/);
  }
});
test("old ambiguous schemas and stale metadata fail closed; unambiguous old data remains supported", () => {
  const old = {
    ...project(),
    requests: [
      normalizeRequest({
        method: "POST",
        url: "https://example.invalid/item",
        schema: { type: "string", nullable: true },
        bodyType: "json",
        body: '"value"',
      }),
    ],
  };
  assert.throws(() => exportOpenAPI(old), /来源版本不明/);
  delete old.requests[0].schema.nullable;
  assert.doesNotThrow(() => exportOpenAPI(old));
  const p = project();
  importIntoProject(p, doc("3.0.3", { type: "string", nullable: true }));
  p.requests[0].schema.nullable = false;
  assert.throws(() => exportOpenAPI(p), /过期/);
  const q = project();
  importIntoProject(q, doc("3.1.0", { type: "string" }));
  q.requests[0].schema.nullable = true;
  assert.throws(() => exportOpenAPI(q), /来源版本不明/);
});
test("direct conversion uses the real input dialect, not the target dialect", () => {
  assert.deepEqual(
    normalizeOpenAPI30Schemas(doc("3.1.0", { type: "string", nullable: true }))
      .components.schemas.S,
    { type: "string" },
  );
  assert.equal(
    normalizeOpenAPI30Schemas(doc("3.0.3", { type: "string", nullable: true }))
      .components.schemas.S.nullable,
    true,
  );
});

test("MCP detached conversion preserves sources and rejects cross-dialect component replacement atomically", () => {
  const p = project();
  syncMCPOpenAPI(p, {
    document: doc("3.0.3", { type: "string", nullable: true }, "/old", "Old"),
  });
  syncMCPOpenAPI(p, {
    document: doc("3.1.0", { type: "string", nullable: true }, "/new", "New"),
  });
  assert.equal(body(exportOpenAPI(p), "/old").nullable, true);
  assert.equal(
    Object.hasOwn(body(exportOpenAPI(p), "/new"), "nullable"),
    false,
  );
  const before = structuredClone(p);
  assert.throws(
    () =>
      syncMCPOpenAPI(p, {
        document: doc(
          "3.1.0",
          { type: "string", nullable: true },
          "/conflict",
          "Old",
        ),
      }),
    /冲突/,
  );
  assert.deepEqual(p, before);
});

test("nullable provenance covers every component category containing schemas", () => {
  for (const version of ["3.0.3", "3.1.0"]) {
    const schema = { type: "string", nullable: true };
    const media = { "application/json": { schema } };
    const parameter = { name: "q", in: "query", schema, example: "value" };
    const response = {
      description: "ok",
      content: media,
      headers: { H: { schema } },
    };
    const source = doc(version, { type: "string" });
    source.components = {
      schemas: { S: schema },
      parameters: { P: parameter },
      headers: { H: { schema } },
      requestBodies: { B: { content: media } },
      responses: { R: response },
      callbacks: {
        C: {
          "{$request.body#/url}": {
            post: {
              parameters: [parameter],
              requestBody: { content: media },
              responses: { 200: response },
            },
          },
        },
      },
    };
    const p = project();
    importIntoProject(p, source);
    const c = exportOpenAPI(p).components;
    const schemas = [
      c.schemas.S,
      c.parameters.P.schema,
      c.headers.H.schema,
      c.requestBodies.B.content["application/json"].schema,
      c.responses.R.content["application/json"].schema,
      c.responses.R.headers.H.schema,
      c.callbacks.C["{$request.body#/url}"].post.parameters[0].schema,
    ];
    for (const value of schemas)
      assert.deepEqual(
        value,
        version === "3.0.3" ? schema : { type: "string" },
      );
  }
});

test("3.0 nullable reference siblings are refused instead of reinterpreted", () => {
  const source = doc("3.0.3", { type: "string", nullable: true });
  source.paths["/item"].post.requestBody.content["application/json"].schema = {
    $ref: "#/components/schemas/S",
    nullable: true,
  };
  assert.throws(() => importDocument(source), /Reference Object/);
  delete source.paths["/item"].post.requestBody.content["application/json"]
    .schema.nullable;
  assert.equal(
    body(exportOpenAPI({ ...project(), requests: importDocument(source) }))
      .nullable,
    true,
  );
});

test("3.1 reusable pathItems cannot leak unconverted schemas or internal origins into 3.0", () => {
  const source = doc("3.1.0", { type: "string", nullable: true });
  source.components.pathItems = { Reusable: source.paths["/item"] };
  const p = project();
  importIntoProject(p, source);
  const before = structuredClone(p);
  assert.throws(() => exportOpenAPI(p), /components.pathItems/);
  assert.deepEqual(p, before);
  assert.throws(
    () => normalizeOpenAPI30Schemas(source),
    /components.pathItems/,
  );
  source.components.pathItems = {};
  assert.throws(
    () => normalizeOpenAPI30Schemas(source),
    /components.pathItems/,
  );
});

test("unsupported top-level schema locations fail rather than pass through unconverted", () => {
  for (const key of ["webhooks", "definitions", "parameters", "responses"]) {
    const source = doc("3.1.0", { type: "string" });
    source[key] = { Entry: { schema: { type: "string", nullable: true } } };
    assert.throws(() => normalizeOpenAPI30Schemas(source), new RegExp(key));
  }
});
