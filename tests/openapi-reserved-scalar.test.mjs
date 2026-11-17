import test from "node:test";
import assert from "node:assert/strict";
import {
  importDocument,
  exportOpenAPI,
  normalizeRequest,
  toCurl,
  interpolate,
} from "../src/core.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import {
  encodeReservedQueryValue,
  encodeReservedQuery,
} from "../src/openapi-query-reserved.mjs";
import {
  appendRequestQuery,
  setURLQuery,
} from "../src/query-serialization.mjs";
import { reservedDocument } from "./fixtures/openapi-allow-reserved.mjs";
const source = (value = "a/b:c?d") => {
  const d = reservedDocument("3.1.0", true);
  d.paths["/search"].get.parameters[0].example = value;
  return d;
};
const request = (value) => importDocument(source(value))[0];
test("reserved scalar encoder preserves safe reserved and percent spelling without parameter injection", () => {
  assert.equal(encodeReservedQueryValue("a/b:c?d@!$()*,;"), "a/b:c?d@!$()*,;");
  assert.equal(
    encodeReservedQueryValue("[]#&=+ 中文%2f%26admin%3Dtrue"),
    "%5B%5D%23%26%3D%2B%20%E4%B8%AD%E6%96%87%2f%26admin%3Dtrue",
  );
  for (const v of ["%", "%2", "%GG", "%FF", "\ud800", "a'b", "\r\n"])
    assert.throws(() => encodeReservedQueryValue(v), /allowReserved/);
  for (const v of [null, {}, [], Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => encodeReservedQueryValue(v), /allowReserved/);
  const r = request("a&admin=true+x#frag");
  const u = new URL(r.url);
  appendRequestQuery(u, r.query);
  assert.deepEqual([...u.searchParams], [["filter", "a&admin=true+x#frag"]]);
  assert.equal(u.hash, "");
});
test("raw URL query spelling survives appending and authentication field replacement", () => {
  const r = request("%2f/a");
  const u = new URL("http://localhost/?old=%2f&blank&repeat=1&repeat=2&plus=+");
  appendRequestQuery(u, r.query);
  assert.equal(
    u.search,
    "?old=%2f&blank&repeat=1&repeat=2&plus=+&filter=%2f/a",
  );
  setURLQuery(u, "token", "x/y");
  assert.equal(
    u.search,
    "?old=%2f&blank&repeat=1&repeat=2&plus=+&filter=%2f/a&token=x%2Fy",
  );
});
test("descriptor survives OpenAPI roundtrip, scalar selection and local refs", () => {
  for (const version of ["3.0.3", "3.1.0"])
    for (const value of ["", false, 0, "/?:%2f"]) {
      const d = source(value);
      d.openapi = version;
      const before = structuredClone(d),
        [r] = importDocument(d);
      assert.deepEqual(d, before);
      const out = exportOpenAPI({ name: "roundtrip", requests: [r] });
      assert.equal(out.paths["/search"].get.parameters[0].allowReserved, true);
      const [again] = importDocument(out);
      assert.equal(
        encodeReservedQuery(again.query[0]),
        encodeReservedQuery(r.query[0]),
      );
    }
  const d = source();
  const p = d.paths["/search"].get.parameters[0];
  delete p.example;
  p.examples = { one: { value: "example/a" } };
  d.components = { parameters: { P: p } };
  d.paths["/search"].parameters = [{ $ref: "#/components/parameters/P" }];
  delete d.paths["/search"].get.parameters;
  assert.equal(importDocument(d)[0].query[0].value, "example/a");
});
test("unsupported combinations and malformed descriptors are rejected even if disabled", () => {
  const r = request();
  for (const auth of ["aws", "oauth1", "hawk", "edgegrid", "jwt", "oauth2"])
    assert.throws(
      () => normalizeRequest({ ...r, auth: { type: auth } }),
      /allowReserved/,
    );
  for (const extra of [
    { scriptURLMode: "sdk" },
    { scriptURLRuntime: {} },
    { queryAddEqual: false },
  ])
    assert.throws(
      () => normalizeRequest({ ...r, ...extra }),
      /allowReserved|SDK模式/,
    );
  for (const patch of [
    { version: 2 },
    { style: "deepObject" },
    { allowReserved: false },
    { extra: 1 },
  ]) {
    const b = structuredClone(r);
    Object.assign(b.query[0].reservedQuerySerialization, patch);
    b.query[0].enabled = false;
    assert.throws(() => normalizeRequest(b), /allowReserved/);
  }
  for (const location of ["headers", "path", "cookies", "form"])
    assert.throws(
      () => normalizeRequest({ ...r, query: [], [location]: r.query }),
      /allowReserved/,
    );
  for (const schema of [
    { type: "array", items: { type: "string" } },
    { type: "object" },
    { type: ["string", "null"] },
  ]) {
    const d = source();
    d.paths["/search"].get.parameters[0].schema = schema;
    assert.throws(() => importDocument(d));
  }
  assert.match(
    toCurl({ ...r, auth: { type: "basic", username: "u", password: "p" } }),
    /filter=a\/b:c\?d/,
  );
});
test("MCP and dynamic scalars replace source examples without metadata interpolation", async () => {
  const r = request("{{unused}}");
  r.query[0].schema.example = "{{unused}}";
  const before = structuredClone(r);
  const p = applyMCPInput(r, { query: { filter: "/temporary%2f" } });
  const resolved = await resolveDynamicRequest(p, {}, [], interpolate);
  assert.equal(encodeReservedQuery(resolved.query[0]), "filter=/temporary%2f");
  assert.deepEqual(r, before);
  for (const value of [null, {}, []])
    assert.throws(
      () => applyMCPInput(r, { query: { filter: value } }),
      /primitive/,
    );
  r.query[0].dynamic = { source: "fixed", value: "/dynamic" };
  const dyn = await resolveDynamicRequest(r, {}, [], interpolate);
  assert.equal(encodeReservedQuery(dyn.query[0]), "filter=/dynamic");
  r.query[0].dynamic.value = { bad: true };
  await assert.rejects(
    resolveDynamicRequest(r, {}, [], interpolate),
    /primitive/,
  );
});

test("OpenAPI projection and SDK facade cannot silently rewrite reserved/raw query contracts", async () => {
  const r = request("/a%2f");
  r.url += "?raw=%2f&blank&plus=+";
  assert.match(toCurl(r), /raw=%2f&blank&plus=\+&filter=\/a%2f/);
  assert.throws(
    () => exportOpenAPI({ name: "raw", requests: [r] }),
    /原始Query拼写/,
  );
  const { initializeQueryRuntime } = await import(
    "../src/script-url-runtime.mjs"
  );
  assert.throws(() => initializeQueryRuntime(r), /SDK URL模式/);
  r.query[0].enabled = false;
  assert.throws(() => initializeQueryRuntime(r), /SDK URL模式/);
});
