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
