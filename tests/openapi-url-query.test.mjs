import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequest,
  exportOpenAPI,
  importDocument,
} from "../src/core.mjs";

test("OpenAPI includes literal URL query values instead of silently dropping them", () => {
  const request = normalizeRequest({
    url: "https://example.test/items?q=one+two&empty=&slash=%2f",
    query: [
      { key: "table", value: "a+b" },
      { key: "hidden", value: "off", enabled: false },
    ],
  });
  const original = structuredClone(request);
  const exported = exportOpenAPI({ name: "URL query", requests: [request] });
  const parameters = exported.paths["/items"].get.parameters.filter(
    (item) => item.in === "query",
  );
  assert.deepEqual(
    parameters.map((item) => [item.name, item.example]),
    [
      ["q", "one two"],
      ["empty", ""],
      ["slash", "/"],
      ["table", "a+b"],
    ],
  );
  assert.equal(
    parameters.find((item) => item.name === "empty").allowEmptyValue,
    true,
  );
  const imported = importDocument(exported)[0];
  assert.deepEqual(
    imported.query.map((item) => [item.key, item.value]),
    parameters.map((item) => [item.name, item.example]),
  );
  const reexported = exportOpenAPI({ name: "Roundtrip", requests: [imported] });
  assert.equal(
    reexported.paths["/items"].get.parameters.find(
      (item) => item.name === "empty",
    ).allowEmptyValue,
    true,
  );
  assert.deepEqual(request, original);
});

test("OpenAPI refuses ambiguous query definitions instead of emitting duplicate or lost parameters", () => {
  for (const change of [
    { url: "https://example.test/items?flag" },
    {
      url: "https://example.test/items",
      query: [{ key: "x", value: "", allowEmptyValue: "true" }],
    },
    { url: "https://example.test/items?x=1&x=2" },
    {
      url: "https://example.test/items?x=1",
      query: [{ key: "x", value: "2" }],
    },
    { url: "https://example.test/items?=empty" },
    { url: "https://example.test/items?x=%zz" },
    { url: "https://example.test/items?x=%7B%7Bliteral%7D%7D" },
    { url: "https://example.test/items?%7B%7Bliteral%7D%7D=x" },
    { url: "https://example.test/items?x={{runtime}}" },
  ])
    assert.throws(
      () =>
        exportOpenAPI({
          name: "Ambiguous",
          requests: [normalizeRequest(change)],
        }),
      /OpenAPI.*Query/,
    );
});

test("OpenAPI separates query and fragment from relative or templated base paths", () => {
  for (const url of [
    "/items?q=one#view",
    "{{base}}/items?q=one#view",
    "{{base?opaque}}/items?q=one#view",
  ]) {
    const result = exportOpenAPI({
      name: "Relative",
      requests: [normalizeRequest({ url, serviceId: "fixture-service" })],
    });
    assert.deepEqual(Object.keys(result.paths), ["/items"]);
    assert.equal(result.paths["/items"].get.parameters[0].example, "one");
  }
  const result = exportOpenAPI({
    name: "Disabled",
    requests: [
      normalizeRequest({
        url: "https://example.test/items?q=one",
        query: [{ key: "q", value: "ignored", enabled: false }],
      }),
    ],
  });
  assert.equal(result.paths["/items"].get.parameters.length, 1);
});

test("fragment-only runtime templates do not block OpenAPI export or change the reimported target", () => {
  for (const base of [
    "{{baseUrl}}",
    "{{base?opaque}}",
    "https://example.test",
  ]) {
    const request = normalizeRequest({ url: base + "/pets#{{view}}" });
    const original = structuredClone(request);
    const exported = exportOpenAPI({ name: "Fragment", requests: [request] });
    assert.deepEqual(Object.keys(exported.paths), ["/pets"]);
    assert.deepEqual(exported.paths["/pets"].get.servers, [{ url: base }]);
    assert.equal(importDocument(exported)[0].url, base + "/pets");
    assert.deepEqual(request, original);
  }
  for (const url of [
    "https://{{host}}/pets#{{view}}",
    "{{baseUrl}}/{{path}}#{{view}}",
  ]) {
    assert.throws(
      () =>
        exportOpenAPI({
          name: "Unresolved path",
          requests: [normalizeRequest({ url })],
        }),
      /OpenAPI.*base/,
    );
  }
});

test("exported and reimported literal Query definitions send the same decoded values over real HTTP", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const received = [];
  const server = http.createServer((req, res) => {
    received.push([...new URL(req.url, "http://fixture").searchParams]);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const request = normalizeRequest({
    url: base + "/items?q=one%20two&empty=&slash=%2f",
    query: [{ key: "table", value: "a+b&c" }],
  });
  const exported = exportOpenAPI({
    name: "Query semantics",
    requests: [request],
  });
  const restored = importDocument(exported)[0];
  restored.url = base + "/items";
  assert.equal((await executeRequest(request)).status, 200);
  assert.equal((await executeRequest(restored)).status, 200);
  assert.deepEqual(received[1], received[0]);
  assert.deepEqual(received[0], [
    ["q", "one two"],
    ["empty", ""],
    ["slash", "/"],
    ["table", "a+b&c"],
  ]);
});
