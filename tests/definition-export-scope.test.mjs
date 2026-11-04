import test from "node:test";
import assert from "node:assert/strict";
import { prepareDefinitionExportScope } from "../src/definition-export-scope.mjs";

const choice = (...resources) => ({
  mode: "explicit",
  resources: resources.map(([kind, id]) => ({ kind, id })),
});
const base = () => ({
  version: 1,
  id: "p",
  name: "Scope",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-02T00:00:00Z",
  requests: [
    {
      id: "a",
      name: "API",
      folder: "Root/Sub",
      url: "https://example.test",
      schema: { $ref: "#/components/schemas/A" },
    },
    {
      id: "other",
      name: "Other",
      url: "https://example.test/other",
      folder: "Other",
    },
  ],
  folders: ["Root", "Root/Sub", "Other"],
  documents: [
    { id: "doc", title: "Doc", folder: "Root/Sub", content: "example" },
  ],
  modelFolders: [{ id: "mf", name: "Models" }],
  dictionary: [
    {
      id: "A",
      name: "A",
      folderId: "mf",
      schema: { properties: { b: { $ref: "#/components/schemas/B" } } },
    },
  ],
  openapiComponents: {
    schemas: {
      A: { properties: { b: { $ref: "#/components/schemas/B" } } },
      B: { type: "string" },
    },
  },
  cases: [
    {
      id: "c",
      name: "Case",
      sourceRequestId: "a",
      folderId: "cf",
      createdAt: "2025-01-01T12:00:00Z",
      request: {
        id: "snapshot",
        folder: "Root/Sub",
        url: "https://example.test",
        schema: { $ref: "#/components/schemas/B" },
        auth: { type: "none" },
      },
    },
  ],
  caseFolders: [{ id: "cf", sourceRequestId: "a", name: "Cases" }],
  environments: [
    { id: "env", name: "Environment", variables: { value: "secret" } },
  ],
  servers: [],
  globalVariables: {},
  globalVariableDefinitions: [],
  settings: {},
  protocols: [],
  plans: [],
  history: [],
  runs: [],
  protocolRuns: [],
});
const keys = (result) =>
  result.scope.included.map(({ kind, id }) => `${kind}:${id}`);
const projectKeys = (result, key) => result.project[key].map((row) => row.id);

test("case selection closes through live API, ancestors and recursive/schema-only models", () => {
  const input = base(),
    before = structuredClone(input);
  const result = prepareDefinitionExportScope(input, choice(["case", "c"]));
  assert.deepEqual(projectKeys(result, "requests"), ["a"]);
  assert.deepEqual(projectKeys(result, "cases"), ["c"]);
  assert.deepEqual(result.project.folders, ["Root", "Root/Sub"]);
  assert.deepEqual(Object.keys(result.project.openapiComponents.schemas), [
    "A",
    "B",
  ]);
  for (const key of [
    "case:c",
    "case-folder:cf",
    "api:a",
    "model:A",
    "model:B",
    "model-folder:mf",
    "globals:configuration",
  ])
    assert.ok(keys(result).includes(key), key);
  assert.deepEqual(input, before);
  result.project.requests[0].name = "Detached";
  assert.equal(input.requests[0].name, "API");
  assert.deepEqual(result.project.cases[0].request, before.cases[0].request);
});

test("explicit empty resources never silently exports everything", () => {
  assert.throws(
    () => prepareDefinitionExportScope(base(), choice()),
    /未选择|empty/i,
  );
});

test("folder subtree selects active API/document leaves, never sibling paths or tombstones", () => {
  const input = base();
  input.requests.push({
    id: "dead",
    folder: "Root/Sub",
    deletedAt: "2025-01-01",
    body: "secret",
  });
  input.requests.push({
    id: "similar",
    folder: "RootExtra",
    name: "Not descendant",
  });
  const result = prepareDefinitionExportScope(
    input,
    choice(["folder", "Root"]),
  );
  assert.deepEqual(projectKeys(result, "requests"), ["a"]);
  assert.deepEqual(projectKeys(result, "documents"), ["doc"]);
  assert.ok(
    result.scope.included.some(
      (entry) =>
        entry.id === "a" &&
        entry.reasons.some((reason) => reason.includes("subtree")),
    ),
  );
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "dead"])),
    /不存在|unknown|live/i,
  );
});

test("API dependency ancestors do not select unrelated sibling leaves", () => {
  const input = base();
  input.requests.push({ id: "sibling", folder: "Root/Sub", name: "Sibling" });
  const result = prepareDefinitionExportScope(input, choice(["api", "a"]));
  assert.deepEqual(projectKeys(result, "requests"), ["a"]);
  assert.deepEqual(result.project.documents, []);
});

test("model/case folder subtree closure is explicit and ancestor dependency is narrow", () => {
  const input = base();
  input.modelFolders.push({ id: "nested", name: "Nested", parentId: "mf" });
  input.dictionary.push({
    id: "C",
    name: "C",
    folderId: "nested",
    schema: { type: "integer" },
  });
  input.openapiComponents.schemas.C = { type: "integer" };
  assert.ok(
    keys(
      prepareDefinitionExportScope(input, choice(["model-folder", "mf"])),
    ).includes("model:C"),
  );
  assert.ok(
    !keys(prepareDefinitionExportScope(input, choice(["model", "A"]))).includes(
      "model:C",
    ),
  );
  assert.ok(
    keys(
      prepareDefinitionExportScope(input, choice(["case-folder", "cf"])),
    ).includes("case:c"),
  );
});

test("literal schema data permits deceptive refs, discriminator, prototype keys and annotations", () => {
  const input = base();
  input.requests[0].schema = JSON.parse(
    '{"type":"object","properties":{"constructor":{"type":"string"},"__proto__":{"type":"string"}},"example":{"$ref":"https://evil.test","discriminator":{"mapping":{"a":"external"}},"constructor":{"prototype":1}},"default":{"$dynamicRef":"#outside"},"x-extra":{"$ref":"#not-a-schema"}}',
  );
  const result = prepareDefinitionExportScope(input, choice(["api", "a"]));
  assert.deepEqual(result.project.requests[0].schema, input.requests[0].schema);
  assert.deepEqual(result.project.dictionary, []);
});

test("all true schema positions close references, including nativeMock and snapshots", () => {
  for (const modify of [
    (api) => {
      api.query = [{ key: "q", schema: { $ref: "#/components/schemas/A" } }];
    },
    (api) => {
      api.responses = [
        {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/A" } },
          },
        },
      ];
    },
    (api) => {
      api.examples = [{ schema: { $ref: "#/components/schemas/A" } }];
    },
    (api) => {
      api.nativeMock = {
        fallback: { schema: { $ref: "#/components/schemas/A" } },
        rules: [],
      };
    },
    (api) => {
      api.openapiOperation = {
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/A" } },
          },
        },
      };
    },
  ]) {
    const input = base();
    delete input.requests[0].schema;
    modify(input.requests[0]);
    assert.ok(
      keys(prepareDefinitionExportScope(input, choice(["api", "a"]))).includes(
        "model:B",
      ),
    );
  }
});

test("model cycles are retained without expanding references; missing targets fail closed", () => {
  const input = base();
  input.openapiComponents.schemas.B = { $ref: "#/components/schemas/A" };
  const result = prepareDefinitionExportScope(input, choice(["model", "A"]));
  assert.deepEqual(Object.keys(result.project.openapiComponents.schemas), [
    "A",
    "B",
  ]);
  delete input.openapiComponents.schemas.B;
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["model", "A"])),
    /引用|reference/i,
  );
});

test("external, dynamic, discriminator and Link references reject only at declaration positions", () => {
  for (const schema of [
    { $ref: "https://example.test/model" },
    { $dynamicRef: "#a" },
    { $anchor: "a" },
    { discriminator: { propertyName: "kind" } },
  ]) {
    const input = base();
    input.requests[0].schema = schema;
    assert.throws(
      () => prepareDefinitionExportScope(input, choice(["api", "a"])),
      /引用|discriminator|anchor|作用域/i,
    );
  }
  const input = base();
  input.requests[0].responses = [{ links: { next: { operationId: "other" } } }];
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /Link|引用/i,
  );
});

test("non-schema components use atomic globals and preserve typed nested pointers", () => {
  const input = base();
  input.openapiComponents.responses = {
    Shared: {
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/A" } },
      },
    },
  };
  input.requests[0].responses = [{ $ref: "#/components/responses/Shared" }];
  delete input.requests[0].schema;
  const result = prepareDefinitionExportScope(input, choice(["api", "a"]));
  assert.deepEqual(
    result.project.requests[0].responses,
    input.requests[0].responses,
  );
  assert.deepEqual(
    result.project.openapiComponents.responses,
    input.openapiComponents.responses,
  );
  assert.ok(keys(result).includes("model:B"));
  input.requests[0].schema = { $ref: "#/components/responses/Shared" };
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /类型|声明/i,
  );
});

test("references into literals reject, schema nested pointers remain exact", () => {
  const input = base();
  input.requests[0].schema = { $ref: "#/components/schemas/A/properties/b" };
  assert.equal(
    prepareDefinitionExportScope(input, choice(["api", "a"])).project
      .requests[0].schema.$ref,
    input.requests[0].schema.$ref,
  );
  input.openapiComponents.schemas.B = { example: { $ref: "literal" } };
  input.requests[0].schema = { $ref: "#/components/schemas/B/example" };
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /声明|引用/i,
  );
});

test("required globals and dynamic environment exclusions conflict explicitly", () => {
  const input = base();
  assert.throws(
    () =>
      prepareDefinitionExportScope(input, {
        ...choice(["api", "a"]),
        exclude: [{ kind: "globals", id: "configuration" }],
      }),
    /排除|exclude/i,
  );
  input.requests[0].url = "{{baseUrl}}/a";
  assert.ok(
    keys(prepareDefinitionExportScope(input, choice(["api", "a"]))).includes(
      "environment:env",
    ),
  );
  assert.throws(
    () =>
      prepareDefinitionExportScope(input, {
        ...choice(["api", "a"]),
        exclude: [{ kind: "environment", id: "env" }],
      }),
    /排除|exclude/i,
  );
});

test("scripts and dynamic global config conservatively require all environments", () => {
  for (const edit of [
    (p) => {
      p.requests[0].beforeScript = "apt.setVar('x', 1)";
    },
    (p) => {
      p.settings.globalScripts = { before: "script" };
    },
    (p) => {
      p.globalVariables.value = "{{dynamic}}";
    },
  ]) {
    const input = base();
    edit(input);
    assert.ok(
      keys(prepareDefinitionExportScope(input, choice(["api", "a"]))).includes(
        "environment:env",
      ),
    );
  }
});

test("typed globals refs validate service/status/attribute and collection IDs", () => {
  for (const [field, value] of [
    ["serviceId", "missing"],
    ["statusId", "missing"],
    ["attributes", { missing: "x" }],
    ["postmanCollectionId", "missing"],
  ]) {
    const input = base();
    input.requests[0][field] = value;
    assert.throws(
      () => prepareDefinitionExportScope(input, choice(["api", "a"])),
      /引用|不存在/i,
    );
  }
  const input = base();
  input.servers = [
    { id: "server", name: "Server", url: "https://example.test" },
  ];
  input.settings.statuses = [{ id: "status", name: "Ready" }];
  input.settings.attributes = [{ key: "tag", name: "Tag" }];
  input.requests[0].serviceId = "server";
  input.requests[0].statusId = "status";
  input.requests[0].attributes = { tag: "value" };
  input.postmanCollections = {
    version: 1,
    items: [{ id: "collection", name: "Collection" }],
  };
  input.requests[0].postmanCollectionId = "collection";
  assert.ok(
    keys(prepareDefinitionExportScope(input, choice(["api", "a"]))).includes(
      "collection-bundle:registry",
    ),
  );
});

test("folder-scoped globals retain their folder owners and server references", () => {
  const input = base();
  input.settings.folderAuth = { Other: { type: "none" } };
  input.settings.folderServices = { Other: "s" };
  input.servers = [{ id: "s", name: "Server", url: "https://example.test" }];
  const result = prepareDefinitionExportScope(input, choice(["api", "a"]));
  assert.ok(keys(result).includes("folder:Other"));
  assert.deepEqual(projectKeys(result, "requests"), ["a"]);
  input.settings.folderServices.Other = "missing";
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /引用|不存在/i,
  );
});

test("duplicate or malformed/unknown selection and unsupported plan kind reject", () => {
  for (const selection of [
    { mode: "all", resources: [] },
    { mode: "explicit", resources: [{ kind: "api", id: "a", extra: 1 }] },
    choice(["api", "a"], ["api", "a"]),
    choice(["api", "missing"]),
    choice(["plan-bundle", "plans"]),
    { mode: "explicit", resources: [{ kind: "api", id: 1 }] },
  ]) {
    assert.throws(
      () => prepareDefinitionExportScope(base(), selection),
      /范围|选择|资源|字段|重复|标识/i,
    );
  }
  const input = base();
  input.requests.push({ ...input.requests[0] });
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["model", "A"])),
    /重复/i,
  );
});

test("selected values and selection reject getters, proxies, toJSON, hidden fields without invocation", () => {
  let hits = 0;
  for (const bad of [
    Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        hits++;
        return 1;
      },
    }),
    new Proxy(
      {},
      {
        ownKeys() {
          hits++;
          return [];
        },
      },
    ),
    {
      toJSON() {
        hits++;
        return {};
      },
    },
    Object.defineProperty({}, "hidden", { value: 1 }),
  ]) {
    const input = base();
    input.requests[0].extra = bad;
    assert.throws(
      () => prepareDefinitionExportScope(input, choice(["api", "a"])),
      /JSON|访问器|原型|代理|字段/i,
    );
  }
  const selection = Object.defineProperty({}, "mode", {
    enumerable: true,
    get() {
      hits++;
      return "all";
    },
  });
  assert.throws(
    () => prepareDefinitionExportScope(base(), selection),
    /JSON|访问器|字段/i,
  );
  assert.equal(hits, 0);
});

test("unselected huge/unsupported resources and activity data are not deep scanned or size limited", () => {
  const input = base();
  input.requests[1].body = "x".repeat(33 * 1024 * 1024);
  input.requests[1].schema = { $ref: "https://unsupported.test" };
  input.plans = new Proxy([], {
    ownKeys() {
      throw Error("must not scan plans");
    },
  });
  input.runs = new Proxy([], {
    ownKeys() {
      throw Error("must not scan runs");
    },
  });
  input.requestDefinitionHistory = {
    invalid: () => {
      throw Error("must not scan history");
    },
  };
  const result = prepareDefinitionExportScope(input, choice(["api", "a"]));
  assert.deepEqual(projectKeys(result, "requests"), ["a"]);
  assert.equal(result.project.plans, undefined);
  assert.equal(result.project.runs, undefined);
  assert.equal(result.project.requestDefinitionHistory, undefined);
});

test("selected projection byte/depth/node budgets reject rather than truncate", () => {
  const input = base();
  input.requests[0].body = "汉".repeat(12 * 1024 * 1024);
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /超限|上限|字节/i,
  );
  input.requests[0].body = Array.from({ length: 200001 }, () => 0);
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /超限|上限/i,
  );
  let deep = {};
  for (let i = 0; i < 65; i++) deep = { next: deep };
  input.requests[0].body = deep;
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /超限|上限/i,
  );
});

test("digest binds definitions/selection but ignores activity, config revision and root update time", () => {
  const input = base(),
    selection = choice(["api", "a"]);
  input.requests[0].nativeMockRoute = {
    sourceTargetId: "source-marker",
    enabled: false,
  };
  input.requests[0].auth = { type: "bearer", token: "saved" };
  const first = prepareDefinitionExportScope(input, selection);
  assert.match(first.scope.digest, /^[a-f0-9]{64}$/);
  input.history.push({ secret: 1 });
  input.runs.push({ result: 1 });
  input.configRevision = 100;
  input.revision = 200;
  input.updatedAt = "2026-01-01T00:00:00Z";
  assert.equal(
    prepareDefinitionExportScope(input, selection).scope.digest,
    first.scope.digest,
  );
  assert.deepEqual(first.project.requests[0].auth, {
    type: "bearer",
    token: "saved",
  });
  assert.deepEqual(
    first.project.requests[0].nativeMockRoute,
    input.requests[0].nativeMockRoute,
  );
  input.requests[0].auth.token = "changed";
  assert.notEqual(
    prepareDefinitionExportScope(input, selection).scope.digest,
    first.scope.digest,
  );
});

test("selection order and object property order do not alter stable digest", () => {
  const input = base();
  const first = prepareDefinitionExportScope(
    input,
    choice(["api", "a"], ["model", "B"]),
  );
  input.requests[0] = Object.fromEntries(
    Object.entries(input.requests[0]).reverse(),
  );
  assert.equal(
    prepareDefinitionExportScope(input, choice(["model", "B"], ["api", "a"]))
      .scope.digest,
    first.scope.digest,
  );
});

test("native inheritance is indivisible and never erased to make an export pass", () => {
  const input = base();
  input.settings.nativeInheritance = {
    version: 1,
    sourceProjectId: "source",
    folders: [],
    bindings: [],
  };
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /继承|完整|不可拆/i,
  );
  assert.deepEqual(
    prepareDefinitionExportScope(input, { mode: "all" }).project.settings
      .nativeInheritance,
    input.settings.nativeInheritance,
  );
});

test("all retains unsupported settings and definitions but omits histories, plans, trash, archives", () => {
  const input = base();
  input.settings.unsupported = { enabled: true };
  input.settings.apipostDirectoryArtifacts = [{ name: "archive" }];
  input.apiResourceTrash = { batches: [{ private: "trash" }] };
  input.plans = [{ id: "plan", snapshot: "preserve only in backup" }];
  input.requests.push({ id: "dead", deletedAt: "2025-01-01" });
  const result = prepareDefinitionExportScope(input, { mode: "all" });
  assert.deepEqual(result.project.settings.unsupported, { enabled: true });
  assert.equal(result.project.settings.apipostDirectoryArtifacts, undefined);
  for (const field of [
    "plans",
    "history",
    "runs",
    "protocolRuns",
    "requestDefinitionHistory",
    "apiResourceTrash",
  ])
    assert.equal(result.project[field], undefined);
  assert.ok(!keys(result).includes("api:dead"));
  assert.ok(result.scope.omitted.includes("plans"));
});

test("protocol definitions and source-backed message groups are atomic", () => {
  const input = base();
  input.protocols = [
    { id: "p1", type: "websocket", folder: "Root/Sub", message: "one" },
    { id: "p2", type: "websocket", folder: "Other", message: "two" },
  ];
  input.settings.apipostProtocolSources = [
    {
      id: "source",
      source: { message: [{ param_id: "one" }, { param_id: "two" }] },
    },
  ];
  const result = prepareDefinitionExportScope(
    input,
    choice(["protocol-bundle", "definitions"]),
  );
  assert.deepEqual(result.project.protocols, input.protocols);
  assert.deepEqual(
    result.project.settings.apipostProtocolSources,
    input.settings.apipostProtocolSources,
  );
  assert.deepEqual(result.project.requests, []);
});

test("case ownership and folder ancestry fail on missing/cross-owner/cyclic references", () => {
  for (const modify of [
    (p) => {
      p.cases[0].sourceRequestId = "missing";
    },
    (p) => {
      p.caseFolders[0].sourceRequestId = "other";
    },
    (p) => {
      p.caseFolders[0].parentId = "cf";
    },
    (p) => {
      p.modelFolders[0].parentId = "mf";
    },
  ]) {
    const input = base();
    modify(input);
    assert.throws(
      () => prepareDefinitionExportScope(input, choice(["case", "c"])),
      /引用|目录|循环|跨接口/i,
    );
  }
});

test("malformed truthy deletion markers never become selectable live resources", () => {
  for (const deletedAt of [{}, [], true, 1]) {
    const input = base();
    input.requests[0].deletedAt = deletedAt;
    assert.throws(
      () => prepareDefinitionExportScope(input, choice(["api", "a"])),
      /不存在|live/i,
    );
  }
});

test("inventory counts tombstones as inspected resources and never executes identity accessors", () => {
  const input = base();
  let hits = 0;
  Object.defineProperty(input.requests[1], "id", {
    enumerable: true,
    get() {
      hits++;
      return "other";
    },
  });
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["model", "A"])),
    /访问器/i,
  );
  assert.equal(hits, 0);
  const huge = base();
  huge.requests = Array.from({ length: 9999 }, (_, index) => ({
    id: `dead${index}`,
    deletedAt: "2025-01-01",
  }));
  assert.throws(
    () => prepareDefinitionExportScope(huge, choice(["model", "A"])),
    /inventory|资源.*超限/i,
  );
});

test("unselected identity additions do not change the exported-definition digest", () => {
  const input = base();
  const before = prepareDefinitionExportScope(input, choice(["model", "A"]));
  input.requests.push({ id: "new", name: "Not selected" });
  assert.equal(
    prepareDefinitionExportScope(input, choice(["model", "A"])).scope.digest,
    before.scope.digest,
  );
});

test("scoped native JSON and directory adapters roundtrip only the selected HTTP definitions", async () => {
  const { normalizeRequest, importIntoProject } = await import(
    "../src/core.mjs"
  );
  const { exportApipost } = await import("../src/apipost-export.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  const source = {
    id: "p",
    name: "P",
    createdAt: "2025-01-01T00:00:00Z",
    requests: [
      normalizeRequest({
        id: "a",
        name: "Chosen",
        url: "https://example.test/chosen",
        folder: "A/B",
        auth: { type: "basic", username: "static", password: "fixture" },
      }),
      normalizeRequest({
        id: "b",
        name: "Other",
        url: "https://example.test/other",
      }),
    ],
    folders: ["A", "A/B"],
    environments: [],
    settings: {},
  };
  const before = structuredClone(source);
  const selected = prepareDefinitionExportScope(source, choice(["api", "a"]));
  for (const encode of [exportApipost, exportApipostDirectory]) {
    const target = {
      id: "target",
      name: "target",
      requests: [],
      environments: [],
      settings: {},
    };
    importIntoProject(target, encode(selected.project));
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].name, "Chosen");
    assert.equal(target.requests[0].folder, "A/B");
    assert.deepEqual(target.requests[0].auth, source.requests[0].auth);
  }
  assert.deepEqual(source, before);
});

test("scoped sample fixture retains frozen request identity and passes existing exporters", async () => {
  const { importIntoProject } = await import("../src/core.mjs");
  const { exportApipost } = await import("../src/apipost-export.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  const { nativeSampleExportFixture } = await import(
    "./fixtures/apipost-sample-export.mjs"
  );
  const source = {
    id: "p",
    name: "P",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(source, nativeSampleExportFixture());
  const item = source.cases[0];
  const selected = prepareDefinitionExportScope(
    source,
    choice(["case", item.id]),
  );
  assert.deepEqual(selected.project.cases[0], item);
  for (const encode of [exportApipost, exportApipostDirectory]) {
    const target = {
      id: "target",
      name: "target",
      requests: [],
      environments: [],
      settings: {},
    };
    importIntoProject(target, encode(selected.project));
    assert.equal(target.cases.length, 1);
    assert.equal(target.cases[0].name, item.name);
    assert.equal(target.requests.length, 1);
  }
});

test("scoped WS bundle keeps all source-backed messages and passes existing exporters", async () => {
  const { importIntoProject } = await import("../src/core.mjs");
  const { exportApipost } = await import("../src/apipost-export.mjs");
  const { exportApipostDirectory } = await import(
    "../src/apipost-directory-export.mjs"
  );
  const { nativeProtocolFixture } = await import(
    "./fixtures/apipost-native-protocols.mjs"
  );
  const native = nativeProtocolFixture();
  native.apis = [native.apis[0]];
  native.apis[0].message.push({
    param_id: "second",
    name: "Second",
    request: { mode: "text", raw: "two" },
    response: { mode: "text", raw: "inert" },
  });
  const source = {
    id: "p",
    name: "P",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(source, native);
  // The owner boundary receives persisted JSON, not pre-persistence optional undefined fields.
  const persisted = JSON.parse(JSON.stringify(source));
  const selected = prepareDefinitionExportScope(
    persisted,
    choice(["protocol-bundle", "definitions"]),
  );
  for (const encode of [exportApipost, exportApipostDirectory]) {
    const target = {
      id: "target",
      name: "target",
      requests: [],
      environments: [],
      settings: {},
    };
    importIntoProject(target, encode(selected.project));
    assert.equal(target.protocols.length, 2);
    assert.deepEqual(
      target.settings.apipostProtocolSources[0].source.message,
      native.apis[0].message,
    );
  }
});

test("selected unsupported settings reach existing exporters without being dropped", async () => {
  const { normalizeRequest } = await import("../src/core.mjs");
  const { exportApipost } = await import("../src/apipost-export.mjs");
  const source = {
    id: "p",
    name: "P",
    requests: [normalizeRequest({ id: "a", url: "https://example.test" })],
    settings: { mockEnabled: false },
    environments: [],
  };
  const selected = prepareDefinitionExportScope(source, choice(["api", "a"]));
  assert.equal(selected.project.settings.mockEnabled, false);
  assert.throws(() => exportApipost(selected.project), /Mock关闭/);
});

test("reference target proxies are rejected before any own-property or prototype trap", () => {
  const input = base();
  let hits = 0;
  input.openapiComponents.schemas.B = new Proxy(
    { properties: { nested: { type: "string" } } },
    {
      getOwnPropertyDescriptor(target, key) {
        hits++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        hits++;
        return Reflect.getPrototypeOf(target);
      },
    },
  );
  input.requests[0].schema = {
    $ref: "#/components/schemas/B/properties/nested",
  };
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /JSON|代理/i,
  );
  assert.equal(hits, 0);
});

test("native empty folder auth cannot disappear by omitting its inheritance graph", async () => {
  const { importIntoProject } = await import("../src/core.mjs");
  const { nativeInheritanceFixture } = await import(
    "./fixtures/native-inheritance.mjs"
  );
  const native = nativeInheritanceFixture();
  native.apis.push({
    target_id: "empty",
    target_type: "folder",
    parent_id: "0",
    name: "Empty",
    request: {
      auth: {
        type: "basic",
        basic: { username: "fixture", password: "secret" },
      },
    },
  });
  const source = {
    id: "p",
    name: "P",
    requests: [],
    environments: [],
    settings: {},
  };
  importIntoProject(source, native, { inheritanceMode: "preserve" });
  assert.throws(
    () => prepareDefinitionExportScope(source, choice(["folder", "Empty"])),
    /继承|完整|不可拆/i,
  );
  const selected = prepareDefinitionExportScope(source, { mode: "all" });
  assert.deepEqual(
    selected.project.settings.nativeInheritance,
    source.settings.nativeInheritance,
  );
});

test("ordinary empty API folders retain global auth and Mock policy for fail-closed export", async () => {
  const { exportApipost } = await import("../src/apipost-export.mjs");
  for (const settings of [
    { globalAuth: { type: "basic", username: "fixture", password: "secret" } },
    { mockEnabled: false },
  ]) {
    const source = {
      id: "p",
      name: "P",
      folders: ["Empty"],
      requests: [],
      environments: [],
      settings,
    };
    const selected = prepareDefinitionExportScope(
      source,
      choice(["folder", "Empty"]),
    );
    assert.ok(keys(selected).includes("globals:configuration"));
    assert.deepEqual(selected.project.settings, settings);
    assert.throws(() => exportApipost(selected.project), /全局|设置|Mock关闭/);
  }
});

test("pointer segments are bounded before allocation or target traversal", () => {
  const input = base();
  for (const ref of [
    "#/" + "missing/".repeat(1000),
    "#" + "%2fmissing".repeat(1000),
  ]) {
    input.requests[0].schema = { $ref: ref };
    assert.throws(
      () => prepareDefinitionExportScope(input, choice(["api", "a"])),
      /引用.*超限/i,
    );
  }
});

test("reference byte limit is UTF-8 and never applies to literal example data", () => {
  const input = base();
  const longRef = "#/components/schemas/B/properties/" + "汉".repeat(3000);
  input.requests[0].schema = { $ref: longRef };
  assert.throws(
    () => prepareDefinitionExportScope(input, choice(["api", "a"])),
    /引用.*字节超限/,
  );
  input.requests[0].schema = {
    type: "object",
    example: { $ref: longRef },
    default: { $ref: "#/" + "missing/".repeat(1000) },
  };
  assert.deepEqual(
    prepareDefinitionExportScope(input, choice(["api", "a"])).project
      .requests[0].schema,
    input.requests[0].schema,
  );
});
