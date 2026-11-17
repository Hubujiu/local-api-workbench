import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, importIntoProject } from "../src/core.mjs";

test("owner parser extraction retains curl, JSON, YAML and Postman routing", () => {
  const openapi = {
    openapi: "3.0.3",
    servers: [{ url: "https://example.test" }],
    paths: { "/ping": { get: { responses: { 200: { description: "OK" } } } } },
  };
  assert.equal(
    importDocument(JSON.stringify(openapi))[0].url,
    "https://example.test/ping",
  );
  assert.equal(
    importDocument(
      "openapi: 3.0.3\nservers: [{url: https://example.test}]\npaths: {/ping: {get: {responses: {'200': {description: OK}}}}}",
    )[0].url,
    "https://example.test/ping",
  );
  assert.equal(
    importDocument("curl https://example.test/ping")[0].url,
    "https://example.test/ping",
  );
  const postman = {
    info: {
      name: "test",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "ping",
        request: { method: "GET", url: "https://example.test/ping" },
      },
    ],
  };
  assert.equal(
    importDocument(JSON.stringify(postman))[0].url,
    "https://example.test/ping",
  );
  for (const source of [
    JSON.stringify(openapi),
    "curl https://example.test/ping",
  ]) {
    const project = { requests: [], environments: [], folders: [] };
    assert.equal(importIntoProject(project, source).length, 1);
    assert.equal(project.requests[0].url, "https://example.test/ping");
  }
  assert.throws(
    () => importDocument(JSON.stringify("openapi: 3.0.3")),
    /无法识别/,
  );
});
