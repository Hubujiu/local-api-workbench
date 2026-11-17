import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
  normalizeRequest,
  toCurl,
  snapshotPlan,
} from "../src/core.mjs";
import {
  importOpenAPICookieObject,
  cookieObjectPairs,
  cookieObjectHeader,
  validateCookieObjectRequest,
} from "../src/openapi-cookie-objects.mjs";
import { requestCookieHeader } from "../src/request-cookies.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import { applyGlobalParameters } from "../src/global-parameters.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { interpolate } from "../src/core.mjs";
const parameter = (extra = {}) => ({
  in: "cookie",
  name: "filter",
  schema: {
    type: "object",
    properties: {
      role: { type: "string" },
      active: { type: "boolean" },
      count: { type: "integer" },
    },
  },
  example: { role: "a;=,&%+ 中文", active: false, count: 0 },
  "x-local-api-cookie-dialect": "cookie-pairs-v1",
  ...extra,
});
const document = (p = parameter(), version = "3.1.0") => ({
  openapi: version,
  info: { title: "cookie", version: "1" },
  servers: [{ url: "http://127.0.0.1:1" }],
  paths: {
    "/check": {
      get: { parameters: [p], responses: { 200: { description: "ok" } } },
    },
  },
});
const request = (extra = {}) => importDocument(document(parameter(extra)))[0];
const expected =
  "role=a%3B%3D%2C%26%25%2B%20%E4%B8%AD%E6%96%87; active=false; count=0";
test("explicit Cookie dialect serializes object pairs and retains typed definitions on roundtrip", () => {
  for (const version of ["3.0.3", "3.1.0"]) {
    const source = document(parameter(), version),
      before = structuredClone(source),
      p = { name: "cookie", requests: [], environments: [] };
    importIntoProject(p, source);
    assert.deepEqual(source, before);
    assert.equal(requestCookieHeader(p.requests[0].cookies), expected);
    const out = exportOpenAPI(p),
      param = out.paths["/check"].get.parameters[0];
    assert.equal(param.style, "form");
    assert.equal(param.explode, true);
    assert.equal(param["x-local-api-cookie-dialect"], "cookie-pairs-v1");
    assert.deepEqual(param.example, parameter().example);
    assert.equal(requestCookieHeader(importDocument(out)[0].cookies), expected);
    assert.ok(toCurl(p.requests[0]).includes(expected));
  }
});
test("ambiguous unmarked objects and unsupported source contracts fail closed", () => {
  for (const extra of [
    { "x-local-api-cookie-dialect": undefined },
    { "x-local-api-cookie-dialect": "other" },
    { explode: false },
    { explode: "true" },
    { style: "simple" },
    { schema: { type: "object", const: {}, enum: [{}] } },
    { content: {} },
    { schema: { type: "array" } },
    { schema: { type: "object", properties: { nested: { type: "object" } } } },
    { example: { x: null } },
    { example: { x: [] } },
    { example: { constructor: "no" } },
  ])
    assert.throws(() => request(extra), /Cookie/);
  const source = document();
  delete source.paths["/check"].get.parameters[0]["x-local-api-cookie-dialect"];
  assert.throws(() => importDocument(source), /对象/);
  const p = { requests: [], environments: [] },
    before = structuredClone(p);
  source.paths["/bad"] = {
    get: { parameters: [parameter({ explode: false })] },
  };
  assert.throws(() => importIntoProject(p, source));
  assert.deepEqual(p, before);
});
test("selection, names, literals and empty objects are explicit", () => {
  assert.equal(
    requestCookieHeader(request({ example: {} }).cookies),
    undefined,
  );
  assert.equal(
    requestCookieHeader(
      request({ example: { Name: "", name: "v", pct: "%3B" } }).cookies,
    ),
    "Name=; name=v; pct=%253B",
  );
  for (const key of [
    "",
    "a b",
    "a;b",
    "a=b",
    "a,b",
    "中文",
    "__proto__",
    "constructor",
  ])
    assert.throws(
      () => request({ example: JSON.parse(JSON.stringify({ [key]: "v" })) }),
      /Cookie/,
    );
  const p = parameter();
  delete p.example;
  p.schema.default = { role: "default" };
  assert.equal(
    cookieObjectPairs(importOpenAPICookieObject(p))[0][1],
    "default",
  );
  delete p.schema.default;
  p.examples = { one: { value: { active: false } } };
  assert.deepEqual(cookieObjectPairs(importOpenAPICookieObject(p)), [
    ["active", "false"],
  ]);
  assert.throws(() => request({ examples: { one: { value: {} } } }), /example/);
});
test("marked request rejects collisions, nonraw policy, Cookie Header and auth overwrite", () => {
  for (const row of [
    { key: "role", value: "ordinary" },
    { ...request().cookies[0], key: "other" },
    { key: "ordinary", value: "safe; injected=bad" },
  ]) {
    const r = request();
    r.cookies.push(row);
    assert.throws(() => normalizeRequest(r), /Cookie/);
  }
  for (const policy of ["apipost", "apipost-name"]) {
    const r = request();
    r.cookieEncoding = policy;
    assert.throws(() => normalizeRequest(r), /非raw/);
  }
  for (const auth of [
    { type: "apiKey", in: "header", key: "Cookie", value: "secret" },
  ]) {
    const r = request();
    r.auth = auth;
    assert.throws(() => validateCookieObjectRequest(r), /认证/);
  }
  const r = request();
  r.headers = [{ key: "Cookie", value: "secret=keep" }];
  assert.throws(() => validateCookieObjectRequest(r), /Header/);
  const global = {
    settings: {
      globalParameters: { cookies: [{ key: "role", value: "global" }] },
    },
  };
  assert.throws(
    () => validateCookieObjectRequest(applyGlobalParameters(global, request())),
    /冲突/,
  );
});
test("legacy Cookie bytes and policies remain unchanged without a marker", () => {
  assert.equal(
    requestCookieHeader([
      { key: "a", value: "x;y" },
      { key: "a", value: "z" },
    ]),
    "a=x;y; a=z",
  );
  assert.equal(
    requestCookieHeader([{ key: "a b", value: "x y" }], "apipost"),
    "a%20b=x%20y",
  );
  assert.equal(cookieObjectHeader([{ key: "a", value: { x: 1 } }]), undefined);
});
test("marker location and disabled definitions are validated without invoking accessors", () => {
  for (const group of ["headers", "query", "path", "form"]) {
    const r = request();
    r[group] = r.cookies;
    r.cookies = [];
    assert.throws(() => normalizeRequest(r), /Cookie/);
  }
  for (const change of [
    (r) => (r.cookieSerialization.version = 2),
    (r) => (r.cookieSerialization.extra = true),
    (r) => (r.value = "[]"),
    (r) => (r.value = '{"role":null}'),
    (r) => (r.value = '{"role":"\\ud800"}'),
    (r) => (r.value = '{"count":1.5}'),
    (r) => (r.schema.nullable = true),
  ]) {
    const r = request();
    change(r.cookies[0]);
    r.cookies[0].enabled = false;
    assert.throws(() => normalizeRequest(r), /Cookie/);
  }
  const r = request();
  Object.defineProperty(r.cookies[0], "cookieSerialization", {
    get() {
      throw Error("getter invoked");
    },
    enumerable: true,
  });
  assert.throws(() => normalizeRequest(r), /序列化标记/);
  const q = request();
  q.cookies[0].cookieSerialization = Object.create({
    version: 1,
    style: "form",
    explode: true,
    dialect: "cookie-pairs",
  });
  assert.throws(() => normalizeRequest(q), /标记/);
});
test("typed values, closed dictionaries and encoded aggregate budgets are enforced", () => {
  assert.throws(
    () =>
      request({
        schema: { type: "object", additionalProperties: false },
        example: { x: "v" },
      }),
    /未声明/,
  );
  assert.throws(
    () =>
      request({
        schema: { type: "object", additionalProperties: { type: "integer" } },
        example: { x: "v" },
      }),
    /类型/,
  );
  assert.throws(() => request({ example: { x: 9007199254740992 } }), /安全/);
  assert.throws(() => request({ example: { x: "中".repeat(8000) } }), /64KiB/);
  const r = request({ example: { x: "a".repeat(40000) } });
  r.cookies.push({
    ...request({ name: "other", example: { y: "b".repeat(40000) } }).cookies[0],
  });
  assert.throws(() => normalizeRequest(r), /总量/);
});
test("interpolation and MCP temporary object input preserve JSON grammar and frozen source", async () => {
  const r = request({ example: { role: "{{part}}", active: false } }),
    before = structuredClone(r),
    text = 'quo"te\\;=%中文';
  const resolved = await resolveDynamicRequest(
    r,
    { part: text },
    [],
    interpolate,
  );
  assert.equal(JSON.parse(resolved.cookies[0].value).role, text);
  assert.deepEqual(r, before);
  const plan = snapshotPlan({ name: "cookie", steps: [{ request: r }] }),
    frozen = structuredClone(plan);
  const patched = applyMCPInput(r, {
    cookies: { filter: { role: "temporary" } },
  });
  assert.equal(requestCookieHeader(patched.cookies), "role=temporary");
  assert.deepEqual(r, before);
  assert.deepEqual(plan, frozen);
  assert.throws(
    () => applyMCPInput(r, { cookies: { filter: '{"role":"not-object"}' } }),
    /须为对象/,
  );
  r.cookies[0].dynamic = { source: "fixed", value: { role: "dynamic" } };
  assert.throws(() => toCurl(r), /动态对象/);
  assert.throws(() => exportOpenAPI({ name: "c", requests: [r] }), /动态对象/);
});

test("Schema constraints remain metadata and edited JSON duplicate keys use the existing last-value contract", () => {
  const r = request({
    schema: {
      type: "object",
      required: ["role"],
      properties: {
        role: { type: "string", pattern: "^admin$", enum: ["admin"] },
      },
    },
    example: { role: "viewer" },
  });
  assert.equal(requestCookieHeader(r.cookies), "role=viewer");
  const exported = exportOpenAPI({ name: "cookie", requests: [r] });
  assert.deepEqual(
    exported.paths["/check"].get.parameters[0].schema,
    r.cookies[0].schema,
  );
  r.cookies[0].value = '{"role":"first","role":"last"}';
  assert.equal(requestCookieHeader(r.cookies), "role=last");
  assert.deepEqual(
    exportOpenAPI({ name: "cookie", requests: [r] }).paths["/check"].get
      .parameters[0].example,
    { role: "last" },
  );
});
