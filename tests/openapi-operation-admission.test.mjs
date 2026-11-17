import test from "node:test";
import assert from "node:assert/strict";
import { supportedOpenAPIPathItems } from "../src/openapi-operation-admission.mjs";
import { referenceChildMode } from "../src/openapi-reference-context.mjs";

test("TRACE presence rejects the entire mixed Path Item set without mutation", () => {
  for (const trace of [{}, null, false, [], undefined]) {
    const document = {
      openapi: "3.0.3",
      paths: { "/first": { get: {} }, "/second": { trace } },
    };
    const before = structuredClone(document);
    assert.throws(() => supportedOpenAPIPathItems(document), /TRACE/);
    assert.deepEqual(document, before);
  }
});

test("only request Path Items participate; empty items and literal metadata remain allowed", () => {
  const document = {
    openapi: "3.1.0",
    paths: {
      "/empty": {},
      "/request": {
        summary: "trace",
        description: "trace",
        servers: [{ url: "https://example.test" }],
        parameters: [],
        "x-meta": { trace: {} },
        get: { "x-meta": { trace: {} } },
      },
      "x-null": null,
      "x-meta": { get: {}, trace: {}, $ref: "literal" },
    },
    components: { pathItems: { unused: { trace: {} } } },
  };
  const before = structuredClone(document);
  assert.deepEqual(supportedOpenAPIPathItems(document), [
    ["/empty", document.paths["/empty"]],
    ["/request", document.paths["/request"]],
  ]);
  assert.deepEqual(supportedOpenAPIPathItems({ paths: {} }), []);
  assert.deepEqual(document, before);
});

test("Paths Object extensions are literal; reusable x-prefixed Path Items still resolve", () => {
  const pathsMode = referenceChildMode("document", "paths");
  assert.equal(referenceChildMode(pathsMode, "/real"), "pathItem");
  assert.equal(referenceChildMode(pathsMode, "x-meta"), "literal");
  assert.equal(referenceChildMode("components", "pathItems"), "map:pathItem");
  assert.equal(referenceChildMode("map:pathItem", "x-reusable"), "pathItem");
});
