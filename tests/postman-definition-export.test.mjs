import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";
import {
  normalizeRequest,
  importIntoProject,
  interpolate,
} from "../src/core.mjs";
import {
  exportPostmanDefinition,
  POSTMAN_DEFINITION_FORMAT as format,
} from "../src/postman-definition-export.mjs";
import {
  previewDefinitionExport,
  exportDefinitionSelection,
} from "../src/scoped-definition-export.mjs";
const make = () => ({
  id: "p",
  name: "Collection",
  configRevision: 1,
  requests: [
    normalizeRequest({
      id: "one",
      name: "One",
      description: "Retained documentation",
      method: "POST",
      url: "https://example.invalid/static?token=literal",
      bodyType: "raw",
      body: '{"text":"{{who}}"}',
      headers: [
        { key: "Content-Type", value: "application/json", enabled: true },
        {
          key: "Authorization",
          value: "Bearer synthetic-secret",
          enabled: true,
        },
      ],
      folder: "Accounts",
    }),
    normalizeRequest({
      id: "two",
      name: "Two",
      url: "https://example.invalid/second",
      bodyType: "none",
      folder: "Accounts",
    }),
  ],
  folders: ["Accounts", "Empty"],
  settings: {},
  environments: [
    { id: "dev", name: "Dev", variables: { who: "private-environment" } },
  ],
  globalVariables: { token: "private-global" },
});
const input = {
  format,
  selection: {
    mode: "explicit",
    resources: [{ kind: "folder", id: "Accounts" }],
  },
};
function exported(p, args = input) {
  const preview = previewDefinitionExport(p, args);
  return exportDefinitionSelection(p, {
    ...args,
    configRevision: preview.configRevision,
    scopeDigest: preview.scope.digest,
    acceptedDependencies: preview.scope.dependencies,
  });
}
test("Postman definition passes official pinned schema while retaining literal request values", async () => {
  const p = make(),
    before = structuredClone(p),
    output = exported(p).document;
  const ajv = addFormats(new Ajv({ strict: false }));
  const schema = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/postman-collection-v2.1.schema.json",
        import.meta.url,
      ),
    ),
  );
  const validate = ajv.compile(schema);
  assert.equal(validate(output), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    output.item[0].item.map((i) => i.name),
    ["One", "Two"],
  );
  assert.equal(output.item[0].item[0].request.url, p.requests[0].url);
  assert.equal(output.item[0].item[0].request.body.raw, p.requests[0].body);
  assert.deepEqual(p, before);
  const imported = { requests: [], environments: [], settings: {} };
  importIntoProject(imported, output);
  assert.equal(imported.requests[0].description, p.requests[0].description);
  const encoded = JSON.stringify(output);
  assert.doesNotMatch(encoded, /private-environment|private-global/);
  assert.match(encoded, /synthetic-secret/);
  const preview = previewDefinitionExport(p, input);
  assert.doesNotMatch(
    JSON.stringify(preview),
    /private-environment|private-global|synthetic-secret/,
  );
  assert.equal(preview.omittedConfiguration.independentlyReplayable, false);
});
test("definition subset fails closed for nonrepresentable policies, unknown fields, media, duplicates and order", () => {
  const changes = [
    (r) => (r.beforeScript = 'pm.test("x",()=>{})'),
    (r) => (r.after = [{ type: "script" }]),
    (r) => (r.auth = { type: "bearer", token: "x" }),
    (r) => (r.timeout = 30000),
    (r) => (r.proxy = "http://proxy.invalid"),
    (r) => (r.tls = { rejectUnauthorized: false }),
    (r) => (r.bodyType = "json"),
    (r) => (r.bodyType = "form-data"),
    (r) => (r.bodyType = "binary"),
    (r) => (r.bodyDynamic = { x: { source: "value" } }),
    (r) => (r.query = [{ key: "x", value: "y" }]),
    (r) => (r.path = [{ key: "who", value: "y" }]),
    (r) => (r.cookies = [{ key: "x", value: "y" }]),
    (r) => (r.examples = [{ name: "x" }]),
    (r) => (r.schema = { type: "object" }),
    (r) => (r.unknownFuturePolicy = true),
    (r) => (r.headers = []),
    (r) => r.headers.push({ key: "content-type", value: "text/plain" }),
    (r) => r.headers.push({ key: "Content-Length", value: "10" }),
    (r) => (r.url = "https://user:password@example.invalid/"),
    (r) => (r.url = "https://example.invalid/#fragment"),
    (r) => (r.url = "https://example.invalid/%xx"),
    (r) => (r.url = "https://example.invalid/{{$randomUUID}}"),
    (r) => (r.body = "{{$randomUUID}}"),
    (r) => (r.headers[1].value = "{{$randomUUID}}"),
    (r) => (r.method = "GET"),
  ];
  for (const change of changes) {
    const p = make();
    change(p.requests[0]);
    assert.throws(() => exported(p));
  }
  for (const settings of [
    { globalAuth: { type: "bearer", token: "x" } },
    { globalScripts: { before: "x" } },
    { folderParameters: { Accounts: {} } },
    { nativeInheritance: {} },
  ]) {
    const p = make();
    p.settings = settings;
    assert.throws(() => exported(p));
  }
  const order = make();
  order.requests.reverse();
  order.requests[0].folder = "";
  assert.throws(() => exported(order, { format, selection: { mode: "all" } }));
  assert.throws(() =>
    exported(make(), {
      format,
      selection: {
        mode: "explicit",
        resources: [{ kind: "environment", id: "dev" }],
      },
    }),
  );
  assert.throws(() =>
    previewDefinitionExport(make(), { ...input, modelNameMode: "preserve" }),
  );
});
test("descriptor-safe builder does not invoke getters, proxies, or mutate source; unknown metadata is not ignored", () => {
  let calls = 0;
  const p = make();
  Object.defineProperty(p.requests[0], "url", {
    get() {
      calls++;
      return "https://example.invalid";
    },
    enumerable: true,
  });
  assert.throws(() => exportPostmanDefinition(p));
  assert.equal(calls, 0);
  const proxy = new Proxy(make(), {
    ownKeys() {
      calls++;
      return [];
    },
  });
  assert.throws(() => exportPostmanDefinition(proxy));
  assert.equal(calls, 0);
  const unknown = make();
  unknown.hiddenFuturePolicy = { enabled: true };
  assert.throws(() => exported(unknown));
});

test("Postman artifact bound and unsupported selections fail before returning any document", () => {
  const p = make();
  p.requests[0].body = '"'.repeat(2200000);
  assert.throws(() => previewDefinitionExport(p, input), /上限/);
  for (const resource of [
    { kind: "globals", id: "configuration" },
    { kind: "environment", id: "dev" },
  ])
    assert.throws(() =>
      previewDefinitionExport(make(), {
        format,
        selection: { mode: "explicit", resources: [resource] },
      }),
    );
  const output = exported(make(), {
    format,
    selection: { mode: "all" },
  }).document;
  assert.deepEqual(
    output.item.map((item) => item.name),
    ["Accounts", "Empty"],
  );
  assert.deepEqual(output.item[1].item, []);
});

test("literal colon path has a real import wire mismatch and is now refused, while encoded colon round-trips", async (t) => {
  const paths = [];
  const peer = http.createServer((request, response) => {
    paths.push(request.url);
    response.end("ok");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
  });
  const base = `http://127.0.0.1:${peer.address().port}`;
  const original = normalizeRequest({
    name: "Literal",
    url: base + "/:id.json",
    bodyType: "none",
  });
  // Preserve the old exporter shape as a counterexample, not a new accepted artifact.
  const unsafe = {
    info: {
      name: "Counterexample",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: original.name,
        request: {
          method: "GET",
          url: original.url,
          header: [],
          auth: { type: "noauth" },
        },
      },
    ],
  };
  const imported = { requests: [], settings: {}, environments: [] };
  importIntoProject(imported, unsafe);
  assert.notEqual(imported.requests[0].url, original.url);
  await executeRequest(original);
  await executeRequest(imported.requests[0]);
  assert.equal(paths[0], "/:id.json");
  assert.notEqual(paths[1], paths[0]);
  const count = paths.length;
  for (const suffix of [
    "/:id.json",
    "/:user-id",
    "/prefix/:id",
    "/:id/../safe",
    "/{{part}}",
    "/prefix{{part}}",
    "/safe?query={{part}}",
  ])
    assert.throws(() =>
      exportPostmanDefinition({
        name: "Refuse",
        folders: [],
        requests: [
          normalizeRequest({
            name: "Refuse",
            url: base + suffix,
            bodyType: "none",
          }),
        ],
      }),
    );
  assert.throws(() =>
    exportPostmanDefinition({
      name: "Refuse",
      folders: [],
      requests: [
        normalizeRequest({
          name: "Refuse",
          url: "{{baseUrl}}/safe",
          bodyType: "none",
        }),
      ],
    }),
  );
  assert.equal(paths.length, count);
  // An ordinary variable can introduce a new colon-leading segment after resolution;
  // the exporter does not resolve it and conservatively refuses the whole URL template.
  await executeRequest(
    normalizeRequest({
      name: "Resolved example",
      url: interpolate(base + "/prefix{{part}}", { part: "/:introduced" }),
      bodyType: "none",
    }),
  );
  assert.equal(paths.at(-1), "/prefix/:introduced");
  for (const suffix of ["/%3Aid.json", "/normal:literal?value=:id"]) {
    const request = normalizeRequest({
      name: "Safe",
      url: base + suffix,
      bodyType: "none",
    });
    const document = exportPostmanDefinition({
      name: "Safe",
      folders: [],
      requests: [request],
    });
    const restored = { requests: [], settings: {}, environments: [] };
    importIntoProject(restored, document);
    await executeRequest(request);
    await executeRequest(restored.requests[0]);
    assert.equal(paths.at(-1), paths.at(-2));
    assert.equal(paths.at(-1), suffix);
  }
});
