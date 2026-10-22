import test from "node:test";
import assert from "node:assert/strict";
import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";
const document = {
  openapi: "3.0.3",
  servers: [{ url: "https://example.test" }],
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        tags: ["group"],
        responses: { 200: { description: "OK" } },
      },
    },
  },
};
const project = () => ({
  requests: [],
  folders: ["target"],
  environments: [],
  openapiComponents: {},
});
test("sync accepts JSON strings, preserves IDs by method URL folder and attaches mapped scripts", () => {
  const p = project();
  const first = syncMCPOpenAPI(p, {
    document: JSON.stringify(document),
    folder: "target",
    apiScripts: [
      {
        method: "GET",
        url: "/ping",
        beforeScript: 'apt.environment.set("fixture", 1)',
        afterScript: 'apt.test("ok", () => true)',
      },
    ],
  });
  assert.equal(first[0].folder, "target/group");
  assert.match(first[0].beforeScript, /fixture/);
  const next = structuredClone(document);
  next.paths["/ping"].get.operationId = "renamed";
  assert.equal(
    syncMCPOpenAPI(p, { document: next, folder: "target" })[0].id,
    first[0].id,
  );
  assert.equal(p.requests.length, 1);
});
test("explicit cover modes distinguish folder overwrite, URL overwrite, skip and append", () => {
  const p = project();
  const a = syncMCPOpenAPI(p, { document })[0];
  syncMCPOpenAPI(p, { document, folder: "target" });
  assert.equal(p.requests.length, 2);
  assert.equal(syncMCPOpenAPI(p, { document, coverMode: "ignore" }).length, 0);
  syncMCPOpenAPI(p, { document, coverMode: "both" });
  assert.equal(p.requests.length, 3);
  assert.equal(
    syncMCPOpenAPI(p, { document, folder: "target", coverMode: "url" })[0].id,
    a.id,
  );
  assert.equal(p.requests.length, 3);
});
test("invalid sync inputs fail atomically and clear is deliberately unavailable", () => {
  for (const extra of [
    { folder: "missing" },
    { coverMode: "clear" },
    { apiScripts: [{ method: "GET", url: "/missing", beforeScript: "x" }] },
    { apiScripts: [{ method: "GET", url: "/ping", beforeScript: 7 }] },
    {
      apiScripts: [
        { method: "GET", url: "/ping" },
        { method: "get", url: "/ping" },
      ],
    },
  ]) {
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => syncMCPOpenAPI(p, { document, ...extra }));
    assert.deepEqual(p, before);
  }
  assert.throws(() =>
    syncMCPOpenAPI(project(), { document: { swagger: "2.0", paths: {} } }),
  );
});

test("local path references map scripts and component updates without mutating the source document", () => {
  const p = project();
  p.openapiComponents = { schemas: { Old: { type: "string" } } };
  const doc = {
    openapi: "3.1.0",
    paths: { "/linked": { $ref: "#/components/pathItems/Linked" } },
    components: {
      pathItems: {
        Linked: { get: { responses: { 200: { description: "OK" } } } },
      },
      schemas: { Added: { type: "integer" } },
    },
  };
  const before = structuredClone(doc);
  const [r] = syncMCPOpenAPI(p, {
    document: doc,
    apiScripts: [
      {
        method: "get",
        url: "/linked",
        afterScript: 'apt.environment.set("linked",true)',
      },
    ],
  });
  assert.match(r.afterScript, /linked/);
  assert.deepEqual(doc, before);
  assert.equal(p.openapiComponents.schemas.Old.type, "string");
  assert.equal(p.openapiComponents.schemas.Added.type, "integer");
  const state = structuredClone(p);
  assert.throws(() =>
    syncMCPOpenAPI(p, {
      document: {
        ...doc,
        paths: { "/bad": { $ref: "https://example.invalid/external.json" } },
      },
    }),
  );
  assert.deepEqual(p, state);
});

test("append mode never reuses IDs when source operation IDs collide", () => {
  const p = project(),
    doc = structuredClone(document);
  doc.paths["/other"] = structuredClone(doc.paths["/ping"]);
  const imported = syncMCPOpenAPI(p, { document: doc, coverMode: "both" });
  assert.equal(imported.length, 2);
  assert.equal(new Set(imported.map((r) => r.id)).size, 2);
  assert.equal(p.requests.length, 2);
});
