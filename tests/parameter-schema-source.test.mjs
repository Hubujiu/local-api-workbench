import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, interpolate } from "../src/core.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";

function request(kind, location) {
  const array = kind === "query";
  const parameter = {
    in: array ? "query" : "header",
    name: "filter",
    schema: array
      ? { type: "array", items: { type: "string" } }
      : { type: "object", properties: { role: { type: "string" } } },
  };
  const example = array ? ["{{unused}}"] : { role: "{{unused}}" };
  if (location === "parameter") parameter.example = example;
  else parameter.schema[location] = example;
  return importDocument({
    openapi: "3.1.0",
    servers: [{ url: "http://127.0.0.1:1" }],
    paths: {
      "/check": {
        get: {
          parameters: [parameter],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  })[0];
}
for (const kind of ["query", "headers"]) {
  test(`${kind} marked source schemas stay literal after replacement without masking live failures`, async () => {
    for (const location of ["parameter", "example", "default"]) {
      const r = request(kind, location),
        before = structuredClone(r);
      const replacement =
        kind === "query" ? ['quote"\\&=中文'] : { role: 'quote"\\&=中文' };
      await assert.rejects(
        resolveDynamicRequest(r, {}, [], interpolate),
        /未定义变量: unused/,
      );
      const patched = applyMCPInput(r, { [kind]: { filter: replacement } });
      const resolved = await resolveDynamicRequest(
        patched,
        {},
        [],
        interpolate,
      );
      assert.deepEqual(JSON.parse(resolved[kind][0].value), replacement);
      assert.deepEqual(resolved[kind][0].schema, r[kind][0].schema);
      assert.deepEqual(resolved.openapiOperation, r.openapiOperation);
      assert.deepEqual(r, before);
      r[kind][0].dynamic = { source: "fixed", value: replacement };
      const dynamic = await resolveDynamicRequest(r, {}, [], interpolate);
      assert.deepEqual(JSON.parse(dynamic[kind][0].value), replacement);
      assert.deepEqual(dynamic[kind][0].schema, before[kind][0].schema);
      r[kind][0].dynamic.value = kind === "query" ? [42] : { role: 42 };
      await assert.rejects(
        resolveDynamicRequest(r, {}, [], interpolate),
        /类型|items/,
      );
    }
  });
}
test("parameter source isolation preserves runtime auth, assertions, ordinary schemas and response interpolation", async () => {
  const r = request("query", "example");
  r.query[0].value = '["{{live}}"]';
  r.headers = [
    {
      key: "x-live",
      value: "{{live}}",
      schema: { type: "string", example: "{{live}}" },
    },
  ];
  r.url = "http://{{host}}/check";
  r.auth = { type: "bearer", token: "{{token}}" };
  r.assertions = [{ type: "bodyIncludes", expected: "{{live}}" }];
  r.schema = { type: "string", example: "{{live}}" };
  r.responses = [{ schema: { type: "string", example: "{{live}}" } }];
  const vars = { host: "127.0.0.1:1", token: "test-token", live: "wire" };
  const resolved = await resolveDynamicRequest(r, vars, [], interpolate);
  for (const key of [
    "url",
    "auth",
    "assertions",
    "headers",
    "schema",
    "responses",
  ])
    assert.deepEqual(resolved[key], interpolate(r[key], vars));
  assert.equal(resolved.query[0].value, '["wire"]');
  assert.deepEqual(resolved.query[0].schema, r.query[0].schema);
  await assert.rejects(
    resolveDynamicRequest(
      r,
      { host: vars.host, token: vars.token },
      [],
      interpolate,
    ),
    /未定义变量/,
  );
});
