import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  exportOpenAPI,
  interpolate,
  normalizeRequest,
  toCurl,
} from "../src/core.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import {
  encodeQueryObject,
  validateQueryObjectRequest,
} from "../src/openapi-query-objects.mjs";
import { initializeQueryRuntime } from "../src/script-url-runtime.mjs";
function doc() {
  return {
    openapi: "3.1.0",
    info: { title: "test", version: "1" },
    servers: [{ url: "http://127.0.0.1:1" }],
    paths: {
      "/x": {
        get: {
          parameters: [
            {
              in: "query",
              name: "filter",
              schema: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  count: { type: "integer" },
                },
                additionalProperties: false,
              },
              example: { role: "a%2F&=+#[]!", count: 1 },
            },
          ],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  };
}
const req = () => importDocument(doc())[0];
test("form object emits property names, literal percent contract, deterministic limits", () => {
  const r = req();
  assert.deepEqual(encodeQueryObject(r.query[0]), [
    "role=a%252F%26%3D%2B%23%5B%5D%21",
    "count=1",
  ]);
  for (const value of [
    {},
    { role: "" },
    { role: null },
    { role: [] },
    { role: {} },
    { role: "\u0000" },
    { role: "\ud800" },
    { count: 9007199254740992 },
    { other: "x" },
    JSON.parse('{"__proto__":"x"}'),
  ]) {
    const bad = structuredClone(r);
    bad.query[0].value = JSON.stringify(value);
    assert.throws(() => normalizeRequest(bad), /Query对象/);
  }
  const bad = req();
  bad.query[0].value = JSON.stringify({ role: "中".repeat(10000) });
  assert.throws(() => normalizeRequest(bad), /64KiB/);
});
test("only explicitly supported OAS shape is admitted", () => {
  for (const mutate of [
    (p) => (p.style = "deepObject"),
    (p) => (p.explode = false),
    (p) => (p.allowReserved = true),
    (p) => (p.allowEmptyValue = true),
    (p) => (p.content = {}),
    (p) => (p.collectionFormat = "multi"),
    (p) => (p.schema.additionalProperties = true),
    (p) => delete p.schema.additionalProperties,
    (p) => (p.schema.properties.role.type = ["string", "null"]),
    (p) => (p.schema.properties.role.type = "{{type}}"),
    (p) => (p.schema.properties.role.items = {}),
    (p) => (p.schema.properties["{{key}}"] = { type: "string" }),
    (p) => (p.example = { role: { x: "nested" } }),
    (p) => delete p.example,
  ]) {
    const d = doc();
    mutate(d.paths["/x"].get.parameters[0]);
    assert.throws(() => importDocument(d));
  }
});
test("all marker boundaries reject malformed definitions, URL projection, SDK and auth before erasure", () => {
  for (const marker of [
    undefined,
    null,
    {},
    { version: 1, style: "form", explode: false },
  ]) {
    const r = req();
    r.query[0].queryObjectSerialization = marker;
    assert.throws(() => normalizeRequest(r));
  }
  for (const mutate of [
    (r) => (r.url += "?role=raw"),
    (r) => (r.auth = { type: "aws" }),
    (r) =>
      (r.auth = { type: "apiKey", in: "query", key: "role", value: "bad" }),
    (r) => (r.scriptURLMode = "sdk"),
    (r) => (r.scriptURLRuntime = {}),
    (r) => (r.queryAddEqual = false),
  ]) {
    const r = req();
    mutate(r);
    assert.throws(() => normalizeRequest(r));
    assert.throws(() => toCurl(r));
    assert.throws(() => exportOpenAPI({ name: "x", requests: [r] }));
  }
  const r = req();
  r.query[0].enabled = false;
  assert.throws(() => initializeQueryRuntime(r));
});
test("expanded names collide with scalar, array and other object while ordinary repeats outside scope stay unchanged", () => {
  for (const row of [
    { key: "role", value: "bad" },
    { ...req().query[0], key: "other" },
    {
      key: "role",
      schema: { type: "array", items: { type: "string" } },
      querySerialization: { version: 1, style: "form", explode: true },
      value: '["bad"]',
    },
  ]) {
    const r = req();
    r.query.push(row);
    assert.throws(() => normalizeRequest(r), /冲突/);
  }
  const r = req();
  r.query.push({ key: "role", value: "bad", enabled: false });
  normalizeRequest(r);
  validateQueryObjectRequest({
    query: [
      { key: "x", value: "a" },
      { key: "x", value: "b" },
    ],
  });
});
test("post-interpolation collision and raw URL rejection, replacement leaves source and active types intact", async () => {
  const r = req();
  r.query.push({ key: "{{key}}", value: "v" });
  await assert.rejects(
    resolveDynamicRequest(r, { key: "role" }, [], interpolate),
    /冲突/,
  );
  const url = req();
  url.url = "http://127.0.0.1:1/{{path}}";
  await assert.rejects(
    resolveDynamicRequest(url, { path: "x?role=bad" }, [], interpolate),
    /原始Query/,
  );
  for (const loc of ["example", "default"]) {
    const d = doc();
    const p = d.paths["/x"].get.parameters[0];
    delete p.example;
    p.schema[loc] = { role: "{{unused}}" };
    const r = importDocument(d)[0],
      saved = structuredClone(r);
    await assert.rejects(
      resolveDynamicRequest(r, {}, [], interpolate),
      /unused/,
    );
    const patched = applyMCPInput(r, { query: { filter: { role: "new" } } });
    const out = await resolveDynamicRequest(patched, {}, [], interpolate);
    assert.deepEqual(JSON.parse(out.query[0].value), { role: "new" });
    assert.deepEqual(r, saved);
    assert.deepEqual(out.query[0].schema, r.query[0].schema);
    assert.throws(() =>
      applyMCPInput(r, { query: { filter: { count: Infinity } } }),
    );
  }
});

test("OpenAPI object export cannot bypass effective auth or silently omit shared Query", () => {
  assert.throws(
    () =>
      exportOpenAPI({
        name: "x",
        requests: [req()],
        settings: {
          globalAuth: {
            type: "apiKey",
            in: "query",
            key: "role",
            value: "secret",
          },
        },
      }),
    /Query对象.*认证/,
  );
  for (const key of ["role", "other"]) {
    const r = req();
    assert.throws(
      () =>
        exportOpenAPI({
          name: "x",
          requests: [r],
          settings: {
            globalParameters: {
              query: [{ key, value: "value", enabled: true }],
            },
          },
        }),
      /Query对象/,
    );
  }
});
