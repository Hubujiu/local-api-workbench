import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManualImportSourceGraph,
  prepareManualImportSource,
  collectManualImportModelReferences,
} from "../src/manual-import-source.mjs";
import {
  manualImportCanonicalFixture as fixture,
  manualImportModernSourceFixture,
  manualImportDirectorySourceFixture,
} from "./fixtures/manual-import-source.mjs";
import { assembleApipostDirectory } from "../src/apipost-directory.mjs";
const context = {
  nonce: Buffer.alloc(32, 7).toString("base64url"),
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
};
const node = (graph, kind, index = 0) =>
  graph.nodes.filter((item) => item.kind === kind)[index];
const pathValue = (object, path) =>
  path.reduce((value, part) => value[part], object);

test("pure: source graph preserves every canonical resource in typed ownership paths", () => {
  const source = fixture(),
    before = structuredClone(source),
    graph = buildManualImportSourceGraph(source, context);
  assert.deepEqual(source, before);
  assert.deepEqual(
    new Set(graph.nodes.map((n) => n.kind)),
    new Set([
      "api",
      "folder",
      "document",
      "case",
      "case-folder",
      "model",
      "model-folder",
      "environment",
      "globals",
      "protocol-bundle",
      "plan-bundle",
      "collection-bundle",
      "artifacts",
    ]),
  );
  for (const item of graph.nodes) {
    assert.ok(item.paths.length);
    for (const path of item.paths)
      assert.notEqual(pathValue(graph.project, path), undefined);
    for (const dependency of item.dependencies)
      assert.ok(graph.nodes.some((n) => n.key === dependency));
  }
  assert.equal(node(graph, "model").paths.length, 2);
  assert.equal(graph.project.environments[0].variables.token, "current");
  assert.equal(
    graph.project.environments[0].variableDefinitions.token.initialValue,
    "initial",
  );
});

test("pure: generated IDs and business times are deterministic and references remain typed", () => {
  const first = fixture(),
    second = fixture();
  second.requests[0].id = "other-api";
  second.caseFolders.forEach((f) => {
    f.sourceRequestId = "other-api";
  });
  second.cases[0].sourceRequestId = "other-api";
  second.cases[0].request.id = "other-snapshot";
  second.cases[0].createdAt = "2025-01-01T00:00:00Z";
  second.plans[0].steps[0].request.id = "other-plan-snapshot";
  const a = buildManualImportSourceGraph(first, context),
    b = buildManualImportSourceGraph(second, context);
  assert.deepEqual(a, b);
  assert.equal(a.project.cases[0].sourceRequestId, a.project.requests[0].id);
  assert.equal(
    a.project.cases[0].createdAt,
    new Date(context.issuedAt).toISOString(),
  );
  assert.notEqual(a.project.requests[0].id, first.requests[0].id);
  assert.notEqual(
    a.project.requests[0].id,
    buildManualImportSourceGraph(first, {
      ...context,
      nonce: Buffer.alloc(32, 8).toString("base64url"),
    }).project.requests[0].id,
  );
  assert.equal(a.project.documents[0].content, first.documents[0].content);
  assert.deepEqual(
    a.project.documents[0].apipostSource,
    first.documents[0].apipostSource,
  );
  assert.deepEqual(
    a.project.plans[0].importedNativeFlowSource,
    first.plans[0].importedNativeFlowSource,
  );
});

test("pure: sample dependency includes owning API and groups, own models and conservative globals", () => {
  const graph = buildManualImportSourceGraph(fixture(), context),
    sample = node(graph, "case");
  for (const dependency of [
    node(graph, "api"),
    node(graph, "case-folder", 1),
    node(graph, "model", 1),
    node(graph, "globals"),
  ])
    assert.ok(sample.dependencies.includes(dependency.key));
  assert.ok(
    node(graph, "api").dependencies.includes(node(graph, "folder", 1).key),
  );
  assert.ok(
    node(graph, "environment").dependencies.includes(
      node(graph, "globals").key,
    ),
  );
  assert.ok(
    node(graph, "api").dependencies.includes(
      node(graph, "collection-bundle").key,
    ),
  );
});

test("pure: schema cycles are legal, model ancestors and transitive edges are complete, literals stay literal", () => {
  const graph = buildManualImportSourceGraph(fixture(), context),
    a = node(graph, "model"),
    b = node(graph, "model", 1);
  assert.ok(a.dependencies.includes(b.key));
  assert.ok(b.dependencies.includes(a.key));
  assert.ok(a.dependencies.includes(node(graph, "model-folder", 1).key));
  assert.equal(
    graph.project.dictionary[0].schema.example.$ref,
    "https://literal.invalid",
  );
  assert.equal(
    graph.project.requests[0].examples[0].body,
    '{"$ref":"unchanged"}',
  );
  assert.equal(
    graph.project.requests[0].schema.$ref,
    `#/components/schemas/${a.id}`,
  );
  assert.ok(
    node(graph, "api").references.some(
      (ref) => ref.kind === "schema" && ref.targetKey === a.key,
    ),
  );
});

test("pure: graph rejects duplicate IDs, dangling typed IDs, folder cycles and cross-API case parents", () => {
  for (const change of [
    (p) => p.requests.push({ ...p.requests[0] }),
    (p) => {
      p.cases[0].sourceRequestId = "missing";
    },
    (p) => {
      p.caseFolders[0].parentId = "case-child";
    },
    (p) => {
      p.modelFolders[0].parentId = "model-child";
    },
    (p) => {
      p.requests[0].serviceId = "missing";
    },
    (p) => {
      p.environments[0].serverUrls.missing = "https://invalid.invalid";
    },
    (p) => {
      p.requests[0].postmanCollectionId = "missing";
    },
    (p) => {
      p.dictionary[0].folderId = "missing";
    },
    (p) => {
      p.unknown = { retained: true };
    },
  ]) {
    const p = fixture();
    change(p);
    assert.throws(() => buildManualImportSourceGraph(p, context));
  }
});

test("pure: all source schemas are validated including unselected and literal-target pointer rejection", () => {
  for (const ref of [
    "#/components/schemas/Missing",
    "https://remote.invalid/schema",
    "#/components/schemas/A/example",
    "#/components/schemas/A/not-there",
  ]) {
    const p = fixture();
    p.dictionary[1].schema = { $ref: ref };
    p.openapiComponents.schemas.B = { $ref: ref };
    assert.throws(() => buildManualImportSourceGraph(p, context));
  }
});

test("pure: schema subpointer suffix and pure local refs preserve schema-position semantics", () => {
  const p = fixture();
  p.requests[0].schema = { $ref: "#/components/schemas/B/properties/self" };
  p.cases[0].request.schema = {
    $defs: { Value: { type: "string" } },
    properties: { x: { $ref: "#/$defs/Value" } },
    default: { $ref: "leave-alone" },
  };
  const graph = buildManualImportSourceGraph(p, context);
  assert.equal(
    node(graph, "api").references.find((ref) => ref.kind === "schema").suffix,
    "/properties/self",
  );
  assert.equal(
    graph.project.cases[0].request.schema.properties.x.$ref,
    "#/$defs/Value",
  );
  assert.equal(
    graph.project.cases[0].request.schema.default.$ref,
    "leave-alone",
  );
});

test("pure: input shape and options reject before application dependency loading", async () => {
  for (const input of [
    { format: "json5", document: {} },
    { format: "auto", document: {}, unknown: true },
    { format: "auto", document: {}, options: { inheritanceMode: "preserve" } },
    { format: "auto", document: {}, options: { sync: true } },
    { format: "auto", document: {}, options: { modelNameMode: "unknown" } },
  ])
    await assert.rejects(prepareManualImportSource(input, context), /手动导入/);
});

test("pure: globals retain deterministic native identities across preview nonces", () => {
  const p = fixture();
  const a = buildManualImportSourceGraph(p, context);
  const b = buildManualImportSourceGraph(p, {
    ...context,
    nonce: Buffer.alloc(32, 9).toString("base64url"),
  });
  for (const field of ["servers", "settings"])
    assert.deepEqual(a.project[field], b.project[field]);
  assert.equal(a.project.requests[0].serviceId, p.servers[0].id);
  assert.ok(
    node(a, "api").references.some(
      (ref) =>
        ref.kind === "server" &&
        ref.targetId === "server" &&
        ref.targetKey === node(a, "globals").key,
    ),
  );
});

test("pure: implicit API folders add ancestors but not sibling resources", () => {
  const p = {
    requests: [
      {
        id: "generated",
        name: "Only",
        method: "GET",
        url: "https://example.invalid",
        folder: "Root/Child",
      },
    ],
  };
  const graph = buildManualImportSourceGraph(p, context);
  assert.deepEqual(graph.project.folders, ["Root", "Root/Child"]);
  assert.deepEqual(node(graph, "folder", 1).dependencies, [
    node(graph, "folder").key,
  ]);
  assert.deepEqual(node(graph, "folder").dependencies, []);
  assert.ok(
    !node(graph, "folder", 1).dependencies.includes(node(graph, "api").key),
  );
});

test("pure: trusted converter output may omit undefined object fields, never execute accessors/toJSON or omit array entries", () => {
  const p = fixture();
  p.requests[0].optional = undefined;
  const output = buildManualImportSourceGraph(p, context);
  assert.ok(!Object.hasOwn(output.project.requests[0], "optional"));
  let calls = 0;
  for (const bad of [
    () => {
      const x = fixture();
      Object.defineProperty(x.requests[0], "danger", {
        enumerable: true,
        get() {
          calls++;
          return "secret";
        },
      });
      return x;
    },
    () => {
      const x = fixture();
      x.requests[0].toJSON = () => {
        calls++;
        return {};
      };
      return x;
    },
    () => {
      const x = fixture();
      x.requests[0].examples.push(undefined);
      return x;
    },
  ])
    assert.throws(() => buildManualImportSourceGraph(bad(), context));
  assert.equal(calls, 0);
});

test("pure: native mock response schemas are live dependencies and literal conditions remain unchanged", () => {
  const p = fixture();
  p.requests[0].nativeMock = {
    version: 1,
    sourceTargetId: "native-api",
    enabled: true,
    rules: [
      {
        id: "rule",
        conditions: [{ value: { $ref: "literal" } }],
        response: {
          schema: {
            type: "object",
            properties: { value: { $ref: "#/components/schemas/B" } },
          },
        },
      },
    ],
    fallback: {
      schema: {
        type: "object",
        properties: { value: { $ref: "#/components/schemas/A" } },
      },
    },
  };
  const graph = buildManualImportSourceGraph(p, context);
  assert.ok(
    node(graph, "api").references.some(
      (ref) => ref.path.includes("nativeMock") && ref.targetId === "B",
    ),
  );
  assert.deepEqual(
    graph.project.requests[0].nativeMock.rules[0].conditions,
    p.requests[0].nativeMock.rules[0].conditions,
  );
});

test("pure: schema refs cannot change declaration kind or use unresolved scopes", () => {
  for (const schema of [
    { $ref: "#/components/securitySchemes/bearer" },
    { $id: "https://remote.invalid/base", $ref: "#/components/schemas/A" },
    { $dynamicRef: "#node" },
    { $ref: "#anchor" },
  ]) {
    const p = fixture();
    p.requests[0].schema = schema;
    assert.throws(() => buildManualImportSourceGraph(p, context));
  }
});

test("pure: reverse reference collector scans current cases/plans/mock/schema definitions, not literal or retained evidence", () => {
  const p = fixture();
  p.runs = [
    {
      snapshot: {
        request: { schema: { $ref: "#/components/schemas/HISTORY" } },
      },
    },
  ];
  p.requestDefinitionHistory = {
    versions: [
      { request: { schema: { $ref: "#/components/schemas/HISTORY" } } },
    ],
  };
  p.requests[0].examples.push({
    body: "",
    schema: { example: { $ref: "#/components/schemas/LITERAL" } },
  });
  const before = structuredClone(p),
    refs = collectManualImportModelReferences(p);
  assert.deepEqual(p, before);
  assert.ok(
    refs.some((ref) => ref.ownerKind === "case" && ref.modelId === "B"),
  );
  assert.ok(
    refs.some((ref) => ref.ownerKind === "plan" && ref.modelId === "A"),
  );
  assert.ok(refs.some((ref) => ref.ownerKind === "api" && ref.modelId === "A"));
  assert.ok(!refs.some((ref) => ["HISTORY", "LITERAL"].includes(ref.modelId)));
});

test("pure: format mismatches and unknown/native test resource fields fail before converter loading", async () => {
  for (const input of [
    { format: "openapi", document: { apis: [] } },
    { format: "apipost", document: { openapi: "3.0.3", paths: {} } },
    { format: "apipost-directory", document: { apis: [] } },
    {
      format: "auto",
      document: { apis: [], test_cases: [{ id: "nonempty" }] },
    },
    {
      format: "auto",
      document: { apis: [], automated_testings: [{ id: "nonempty" }] },
    },
    { format: "auto", document: { apis: [], unknown: {} } },
    {
      format: "auto",
      document: { requests: [], settings: { mustNotDrop: true } },
    },
  ])
    await assert.rejects(prepareManualImportSource(input, context), /手动导入/);
});

test("pure: non-schema components retain their literal pointer and contribute typed dependency edges", () => {
  const p = fixture();
  p.openapiComponents.parameters = {
    P: { name: "q", in: "query", schema: { $ref: "#/components/schemas/B" } },
  };
  p.requests[0].openapiOperation = {
    parameters: [{ $ref: "#/components/parameters/P" }],
  };
  const graph = buildManualImportSourceGraph(p, context),
    globals = node(graph, "globals");
  assert.equal(
    graph.project.requests[0].openapiOperation.parameters[0].$ref,
    "#/components/parameters/P",
  );
  assert.ok(
    node(graph, "api").references.some(
      (ref) =>
        ref.kind === "component" &&
        ref.targetKey === globals.key &&
        ref.targetId === "P",
    ),
  );
  assert.ok(globals.dependencies.includes(node(graph, "model", 1).key));
});

test("pure: directory assembler retains supported samples, globals, model definitions and generated flow key", () => {
  const source = manualImportDirectorySourceFixture(),
    before = structuredClone(source);
  const assembled = assembleApipostDirectory(source);
  assert.deepEqual(source, before);
  assert.equal(assembled.samples.length, 5);
  assert.equal(assembled.models.length, 3);
  assert.equal(assembled.global.custom_func[0].func_body, "return text;");
  assert.equal(assembled.nativeExecutionFlows.length, 1);
  assert.equal(
    assembled.nativeExecutionFlows[0].steps[0].api_snapshot.target_id,
    "one",
  );
  for (const change of [
    (d) => {
      d.unknown = true;
    },
    (d) => {
      d.files.push({ path: "settings/unknown.json", text: "{}" });
    },
    (d) => {
      d.files[0].extra = "do not discard";
    },
  ]) {
    const bad = structuredClone(source);
    change(bad);
    assert.throws(() => assembleApipostDirectory(bad));
  }
});

// These are real converter composition gates, not mocks. In a checkout without
// the locked application dependencies they fail at module loading; report zero
// converter executions rather than treating the pure tests above as integration.
test("converter: modern samples/global/models survive conversion and dependency inventory", async () => {
  await import("../src/core.mjs");
  const document = manualImportModernSourceFixture(),
    before = structuredClone(document);
  const graph = await prepareManualImportSource(
    { format: "apipost", document },
    context,
  );
  assert.deepEqual(document, before);
  assert.equal(graph.project.requests.length, 2);
  assert.equal(graph.project.cases.length, 3);
  assert.equal(graph.project.caseFolders.length, 2);
  assert.equal(graph.project.dictionary.length, 2);
  assert.equal(graph.project.settings.functions[0].body, "return text;");
  assert.equal(graph.project.globalVariables.shared, "current");
  assert.equal(
    graph.project.globalVariableDefinitions.shared.initialValue,
    "global",
  );
  assert.equal(graph.project.environments[0].variables.id, "43");
  assert.equal(
    graph.project.environments[0].variableDefinitions.id.initialValue,
    "42",
  );
  const sample = graph.nodes.find(
    (entry) => entry.kind === "case" && entry.value.name === "root",
  );
  assert.ok(
    sample.dependencies.some(
      (key) => graph.nodes.find((n) => n.key === key)?.kind === "api",
    ),
  );
  assert.ok(
    sample.dependencies.some(
      (key) => graph.nodes.find((n) => n.key === key)?.kind === "model",
    ),
  );
  assert.deepEqual(
    await prepareManualImportSource({ format: "apipost", document }, context),
    graph,
  );
});

test("converter: directory flow/sample/artifact bundles are retained without rejecting assembled keys", async () => {
  await import("../src/core.mjs");
  const document = manualImportDirectorySourceFixture(),
    before = structuredClone(document);
  const graph = await prepareManualImportSource(
    { format: "apipost-directory", document },
    context,
  );
  assert.deepEqual(document, before);
  assert.equal(graph.project.cases.length, 3);
  assert.equal(graph.project.plans.length, 1);
  assert.equal(graph.project.plans[0].steps.length, 1);
  assert.ok(node(graph, "plan-bundle"));
  assert.ok(node(graph, "artifacts"));
  assert.equal(
    graph.project.settings.apipostDirectoryArtifacts[0].files[0].path,
    "settings/mock_inner_rules.json",
  );
  assert.deepEqual(
    await prepareManualImportSource(
      { format: "apipost-directory", document },
      context,
    ),
    graph,
  );
});

test("converter: unknown modern test_cases is rejected by the existing converter, never relabeled or discarded", async () => {
  await import("../src/core.mjs");
  const document = manualImportModernSourceFixture();
  document.test_cases = [{ sample_id: "unsupported", target_id: "one" }];
  const before = structuredClone(document);
  await assert.rejects(
    prepareManualImportSource({ format: "apipost", document }, context),
    /test_cases/,
  );
  assert.deepEqual(document, before);
});

test("converter: OpenAPI reference cycles, literal examples and deterministic generated request IDs compose", async () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Source", version: "1" },
    paths: {
      "/read": {
        get: {
          tags: ["Root/Child"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Value" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Value: {
          type: "object",
          properties: { next: { $ref: "#/components/schemas/Value" } },
          example: { $ref: "https://literal.invalid" },
        },
      },
    },
  };
  const before = structuredClone(document);
  const graph = await prepareManualImportSource(
    { format: "openapi", document },
    context,
  );
  assert.deepEqual(document, before);
  assert.equal(graph.project.requests.length, 1);
  assert.equal(
    node(graph, "model").value.schema.example.$ref,
    "https://literal.invalid",
  );
  assert.ok(node(graph, "api").dependencies.includes(node(graph, "model").key));
  assert.deepEqual(graph.project.folders, ["Root", "Root/Child"]);
  assert.deepEqual(
    await prepareManualImportSource({ format: "auto", document }, context),
    graph,
  );
});

test("converter: Postman collection registry and environment variable modes both preserve complete values", async () => {
  const document = {
    info: { name: "Postman source" },
    variable: [{ key: "baseUrl", value: "https://example.invalid" }],
    item: [
      { name: "Read", request: { method: "GET", url: "{{baseUrl}}/read" } },
    ],
  };
  const before = structuredClone(document);
  const collection = await prepareManualImportSource(
    {
      format: "auto",
      document,
      options: { postmanVariableMode: "collection" },
    },
    context,
  );
  assert.equal(
    collection.project.postmanCollections.items[0].variables.baseUrl,
    "https://example.invalid",
  );
  assert.equal(
    collection.project.requests[0].postmanCollectionId,
    collection.project.postmanCollections.items[0].id,
  );
  assert.ok(
    node(collection, "api").dependencies.includes(
      node(collection, "collection-bundle").key,
    ),
  );
  assert.deepEqual(
    await prepareManualImportSource(
      {
        format: "auto",
        document,
        options: { postmanVariableMode: "collection" },
      },
      context,
    ),
    collection,
  );
  const environment = await prepareManualImportSource(
    { format: "auto", document },
    context,
  );
  assert.equal(
    environment.project.environments[0].variables.baseUrl,
    "https://example.invalid",
  );
  assert.ok(
    node(environment, "api").dependencies.includes(
      node(environment, "environment").key,
    ),
  );
  assert.deepEqual(
    await prepareManualImportSource({ format: "auto", document }, context),
    environment,
  );
  assert.deepEqual(document, before);
});

test("converter: supported protocol definitions and source evidence stay atomic without generated drift", async () => {
  const { nativeProtocolFixture } = await import(
    "./fixtures/apipost-native-protocols.mjs"
  );
  const { extendedProtocolFixture } = await import(
    "./fixtures/apipost-extended-protocols.mjs"
  );
  for (const document of [nativeProtocolFixture(), extendedProtocolFixture()]) {
    const before = structuredClone(document);
    const graph = await prepareManualImportSource(
      { format: "apipost", document },
      context,
    );
    assert.ok(node(graph, "protocol-bundle"));
    assert.equal(
      graph.project.settings.apipostProtocolSources.length,
      document.apis.length,
    );
    assert.deepEqual(
      await prepareManualImportSource({ format: "apipost", document }, context),
      graph,
    );
    assert.deepEqual(document, before);
  }
});

test("pure: reverse references reject live discriminator bindings but ignore literal annotations", () => {
  const literal = fixture();
  literal.dictionary[0].schema.example = {
    discriminator: {
      propertyName: "type",
      mapping: { dog: "#/components/schemas/Dog" },
    },
  };
  literal.dictionary[0].schema.default = {
    discriminator: { propertyName: "type" },
  };
  assert.doesNotThrow(() => collectManualImportModelReferences(literal));
  for (const discriminator of [
    { propertyName: "type" },
    { propertyName: "type", mapping: { dog: "#/components/schemas/B" } },
  ]) {
    const project = fixture();
    project.dictionary[0].schema.discriminator = discriminator;
    assert.throws(
      () => collectManualImportModelReferences(project),
      /discriminator/,
    );
  }
});

test("converter: explicit and implicit OpenAPI discriminator bindings reject before schema identities can change", async () => {
  for (const discriminator of [
    { propertyName: "type", mapping: { dog: "#/components/schemas/Dog" } },
    { propertyName: "type" },
  ]) {
    const document = {
      openapi: "3.0.3",
      info: { title: "Discriminator source", version: "1" },
      paths: {},
      components: {
        schemas: {
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Dog" }],
            discriminator,
          },
          Dog: { type: "object", properties: { type: { type: "string" } } },
        },
      },
    };
    const before = structuredClone(document);
    await assert.rejects(
      prepareManualImportSource({ format: "openapi", document }, context),
      /discriminator/,
    );
    assert.deepEqual(document, before);
  }
});

test("converter: discriminator-shaped literal examples and defaults remain valid unchanged data", async () => {
  const literal = {
    discriminator: {
      propertyName: "type",
      mapping: { dog: "#/components/schemas/Dog" },
    },
  };
  const document = {
    openapi: "3.0.3",
    info: { title: "Literal source", version: "1" },
    paths: {},
    components: {
      schemas: {
        Data: {
          type: "object",
          example: literal,
          default: literal,
          "x-fixture": literal,
        },
      },
    },
  };
  const graph = await prepareManualImportSource(
    { format: "openapi", document },
    context,
  );
  assert.deepEqual(
    graph.project.openapiComponents.schemas.Data.example,
    literal,
  );
  assert.deepEqual(
    graph.project.openapiComponents.schemas.Data.default,
    literal,
  );
  assert.deepEqual(
    graph.project.openapiComponents.schemas.Data["x-fixture"],
    literal,
  );
});

test("pure: reverse reference collector refuses active OpenAPI Link targets but ignores literal link-shaped data", () => {
  for (const link of [
    { operationId: "other" },
    { operationRef: "#/paths/~1other/get" },
  ]) {
    const project = fixture();
    project.requests[0].responses = [{ status: "200", links: { next: link } }];
    assert.throws(() => collectManualImportModelReferences(project), /Link/);
  }
  const literal = fixture();
  literal.dictionary[0].schema.example = {
    links: { next: { operationId: "other" } },
  };
  assert.doesNotThrow(() => collectManualImportModelReferences(literal));
});

test("converter: OpenAPI Link operationId and operationRef reject before partial selection can lose the target", async () => {
  for (const link of [
    { operationId: "other" },
    { operationRef: "#/paths/~1other/get" },
  ]) {
    const document = {
      openapi: "3.0.3",
      info: { title: "Link source", version: "1" },
      paths: {
        "/read": {
          get: {
            operationId: "read",
            responses: { 200: { description: "OK", links: { next: link } } },
          },
        },
        "/other": {
          get: {
            operationId: "other",
            responses: { 200: { description: "OK" } },
          },
        },
      },
    };
    await assert.rejects(
      prepareManualImportSource({ format: "openapi", document }, context),
      /Link/,
    );
  }
});

test("converter: Link-shaped example values, defaults and extensions remain literal data", async () => {
  const literal = {
    links: {
      next: { operationId: "other", operationRef: "#/paths/~1other/get" },
    },
  };
  const document = {
    openapi: "3.0.3",
    info: { title: "Literal links", version: "1" },
    paths: {
      "/read": {
        get: {
          responses: {
            200: {
              description: "OK",
              "x-links": literal,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    example: literal,
                    default: literal,
                  },
                  examples: { sample: { value: literal } },
                },
              },
            },
          },
        },
      },
    },
  };
  const graph = await prepareManualImportSource(
    { format: "openapi", document },
    context,
  );
  assert.deepEqual(graph.project.requests[0].responses[0]["x-links"], literal);
  assert.deepEqual(
    graph.project.requests[0].responses[0].content["application/json"].schema
      .default,
    literal,
  );
});

test("pure: folder-scoped configuration owns typed folder keys and rejects dangling folders", () => {
  const project = fixture();
  project.settings.folderAuth = { "Root/Child": { type: "none" } };
  project.settings.folderScripts = {
    Root: { beforeScript: "const marker = 1;", afterScript: "" },
  };
  project.settings.folderParameters = {
    "Root/Child": {
      query: [{ key: "token", value: "literal", enabled: true }],
    },
  };
  project.settings.folderServices = { "Root/Child": "server" };
  const graph = buildManualImportSourceGraph(project, context),
    globals = node(graph, "globals");
  for (const field of [
    "folderAuth",
    "folderScripts",
    "folderParameters",
    "folderServices",
  ]) {
    assert.ok(
      globals.references.some(
        (ref) => ref.kind === "folder" && ref.key && ref.path[1] === field,
      ),
    );
  }
  assert.ok(
    globals.references.some(
      (ref) => ref.kind === "server" && ref.path[1] === "folderServices",
    ),
  );
  assert.ok(globals.dependencies.includes(node(graph, "folder", 1).key));
  for (const field of [
    "folderAuth",
    "folderScripts",
    "folderParameters",
    "folderServices",
  ]) {
    const bad = fixture();
    bad.settings[field] = {
      Missing: field === "folderServices" ? "server" : {},
    };
    assert.throws(() => buildManualImportSourceGraph(bad, context), /引用/);
  }
});

test("pure: shared folder/global scripts retain conservative environment dependencies", () => {
  for (const field of ["globalScripts", "folderScripts"]) {
    const project = {
      requests: [
        {
          id: "api",
          method: "GET",
          url: "https://example.invalid",
          folder: "Root",
        },
      ],
      folders: ["Root"],
      environments: [{ id: "apipost-env", name: "Env", variables: {} }],
      settings: {
        [field]:
          field === "folderScripts"
            ? { Root: { beforeScript: "pm.environment.get('x');" } }
            : { beforeScript: "pm.environment.get('x');" },
      },
    };
    const graph = buildManualImportSourceGraph(project, context);
    assert.ok(
      node(graph, "api").dependencies.includes(node(graph, "environment").key),
    );
  }
});
