import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequest,
  exportOpenAPI,
  importDocument,
  interpolate,
} from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
const make = (extra = {}) =>
  normalizeRequest({
    url: "https://example.test/items?raw=%2f+&empty=",
    scriptURLMode: "sdk",
    query: [
      {
        key: "table",
        value: "a+b&c",
        description: "Keep metadata",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      { key: "off", value: "hidden", enabled: false },
    ],
    ...extra,
  });
test("static SDK URL definitions export logical query values and preserve table metadata", () => {
  const request = make(),
    before = structuredClone(request);
  const output = exportOpenAPI({ name: "SDK definition", requests: [request] });
  const p = output.paths["/items"].get.parameters;
  assert.deepEqual(
    p.map((x) => [x.name, x.example]),
    [
      ["raw", "/ "],
      ["empty", ""],
      ["table", "a+b&c"],
    ],
  );
  assert.equal(p[2].description, "Keep metadata");
  assert.equal(p[2].required, true);
  assert.equal(p[2].schema.minLength, 1);
  assert.deepEqual(request, before);
  assert.deepEqual(
    importDocument(output)[0].query.map((x) => [x.key, x.value]),
    p.map((x) => [x.name, x.example]),
  );
});
test("SDK OpenAPI export refuses executable, unresolved or ambiguous definitions atomically", () => {
  for (const extra of [
    { beforeScript: 'throw Error("must not execute")' },
    { before: [{ type: "wait", ms: 1 }] },
    { scriptURLRuntime: {} },
    { path: [{ key: "id", value: "42" }] },
    { url: "https://example.test/:id" },
    { url: "https://example.test/%7Bid%7D" },
    { url: "https://fictional:fixture@example.test/items" },
    { url: "ftp://example.test/items" },
    { url: "https://example.test/items?x=1&x=2" },
    { url: "https://example.test/items?flag" },
    { url: "https://example.test/items?x={{runtime}}" },
    {
      query: [{ key: "x", dynamic: { source: "variable", value: "missing" } }],
    },
  ]) {
    const r = { ...make(), ...extra },
      p = { name: "Rejected", requests: [r] },
      before = structuredClone(p);
    assert.throws(() => exportOpenAPI(p));
    assert.deepEqual(p, before);
  }
  const p = {
    name: "Inherited",
    settings: {
      globalScripts: { beforeScript: 'throw Error("do not execute")' },
    },
    requests: [make()],
  };
  assert.throws(() => exportOpenAPI(p), /前置/);
  p.requests[0].inheritSharedScripts = false;
  assert.doesNotThrow(() => exportOpenAPI(p));
});
test("SDK definition OpenAPI roundtrip preserves decoded query values on real HTTP", async (t) => {
  const http = await import("node:http"),
    { executeRequest } = await import("../src/runtime.mjs");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([...new URL(req.url, "http://fixture").searchParams]);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = "http://127.0.0.1:" + server.address().port,
    r = make({ url: base + "/items?raw=%2f+&empty=" });
  const exported = exportOpenAPI({ name: "Wire", requests: [r] }),
    restored = importDocument(exported)[0];
  restored.url = base + "/items";
  const actual = await resolveDynamicRequest(r, {}, [], interpolate);
  assert.equal((await executeRequest(actual)).status, 200);
  assert.equal((await executeRequest(restored)).status, 200);
  assert.deepEqual(seen[0], seen[1]);
});

test("static SDK Path definitions preserve placeholders and metadata instead of baking example values", () => {
  for (const url of [
    "https://example.test/items/{id}?q=one+two",
    "https://example.test/items/:id?q=one+two",
  ]) {
    const r = make({
      url,
      path: [
        {
          key: "id",
          value: "42",
          description: "Item identifier",
          schema: { type: "string", pattern: "^[0-9]+$" },
        },
      ],
    });
    const before = structuredClone(r),
      doc = exportOpenAPI({ name: "Path", requests: [r] });
    const op = doc.paths["/items/{id}"].get;
    assert(op);
    const param = op.parameters.find((p) => p.in === "path");
    assert.deepEqual(param, {
      name: "id",
      in: "path",
      required: true,
      description: "Item identifier",
      schema: { type: "string", pattern: "^[0-9]+$" },
      example: "42",
    });
    assert.deepEqual(r, before);
    assert.equal(importDocument(doc)[0].path[0].value, "42");
  }
});

test("SDK Path export rejects lossy bindings and preserves concrete HTTP path after import", async (t) => {
  for (const extra of [
    { path: [] },
    { path: [{ key: "other", value: "42" }] },
    { path: [{ key: "id", value: "42", enabled: false }] },
    {
      path: [
        { key: "id", value: "42" },
        { key: "id", value: "43" },
      ],
    },
    { url: "https://example.test/{id}/{id}" },
    ...["", "a/b", "{{value}}", "%2f"].map((value) => ({
      path: [{ key: "id", value }],
    })),
    {
      path: [
        { key: "id", value: "42", dynamic: { source: "fixed", value: "43" } },
      ],
    },
  ])
    assert.throws(
      () =>
        exportOpenAPI({
          name: "Rejected path",
          requests: [
            make({
              url: "https://example.test/items/{id}",
              path: [{ key: "id", value: "42" }],
              ...extra,
            }),
          ],
        }),
      /Path|占位符/,
    );
  const http = await import("node:http"),
    { executeRequest } = await import("../src/runtime.mjs");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      path: new URL(req.url, "http://fixture").pathname,
      query: [...new URL(req.url, "http://fixture").searchParams],
    });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = "http://127.0.0.1:" + server.address().port,
    r = make({
      url: base + "/items/{id}?raw=%2f+&empty=",
      path: [{ key: "id", value: "42" }],
    });
  const doc = exportOpenAPI({ name: "Path wire", requests: [r] }),
    restored = importDocument(doc)[0];
  restored.url = base + "/items/{id}";
  assert.equal(
    (await executeRequest(await resolveDynamicRequest(r, {}, [], interpolate)))
      .status,
    200,
  );
  assert.equal((await executeRequest(restored)).status, 200);
  assert.equal(seen[0].path, "/items/42");
  assert.deepEqual(seen[0], seen[1]);
});

test("SDK OpenAPI rejects ambiguous service-relative paths instead of emitting invalid path keys", () => {
  const r = make({ url: "relative/path", serviceId: "fixture" });
  assert.throws(
    () => exportOpenAPI({ name: "Relative", requests: [r] }),
    /相对URL/,
  );
});
