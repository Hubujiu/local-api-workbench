import test from "node:test";
import assert from "node:assert/strict";
import { importDocument, interpolate } from "../src/core.mjs";
import { applyMCPInput } from "../src/mcp-request-input.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { requestCookieHeader } from "../src/request-cookies.mjs";
function source(location) {
  const parameter = {
    in: "cookie",
    name: "filter",
    "x-local-api-cookie-dialect": "cookie-pairs-v1",
    schema: { type: "object", properties: { role: { type: "string" } } },
  };
  if (location === "parameter") parameter.example = { role: "{{unused}}" };
  else parameter.schema[location] = { role: "{{unused}}" };
  return {
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
  };
}
test("temporary Cookie input and fixed dynamic values do not evaluate replaced source examples", async () => {
  for (const location of ["parameter", "example", "default"]) {
    const [request] = importDocument(source(location)),
      before = structuredClone(request);
    const patched = applyMCPInput(request, {
      cookies: { filter: { role: "replacement" } },
    });
    const resolved = await resolveDynamicRequest(patched, {}, [], interpolate);
    assert.equal(requestCookieHeader(resolved.cookies), "role=replacement");
    assert.deepEqual(resolved.openapiOperation, request.openapiOperation);
    assert.deepEqual(resolved.cookies[0].schema, request.cookies[0].schema);
    assert.deepEqual(request, before);
    request.cookies[0].dynamic = {
      source: "fixed",
      value: { role: "dynamic" },
    };
    const dynamic = await resolveDynamicRequest(request, {}, [], interpolate);
    assert.equal(requestCookieHeader(dynamic.cookies), "role=dynamic");
  }
});
test("only operation provenance and marked Cookie schema are opaque; other existing runtime interpolation stays unchanged", async () => {
  const [request] = importDocument(source("parameter"));
  request.cookies[0].value = '{"role":"{{live}}"}';
  request.url = "http://{{host}}/check";
  request.auth = { type: "bearer", token: "{{token}}" };
  request.assertions = [{ type: "bodyIncludes", expected: "{{live}}" }];
  request.schema = { type: "string", example: "{{live}}" };
  request.responses = [
    {
      status: "200",
      content: {
        "application/json": {
          schema: { type: "string", example: "{{live}}" },
        },
      },
    },
  ];
  request.examples = [{ body: "{{live}}" }];
  request.openapiExampleSources = [{ literal: "{{live}}" }];
  const before = structuredClone(request);
  const resolved = await resolveDynamicRequest(
    request,
    { host: "127.0.0.1:1", token: "test-token", live: "wire" },
    [],
    interpolate,
  );
  assert.equal(resolved.url, "http://127.0.0.1:1/check");
  assert.equal(resolved.auth.token, "test-token");
  assert.equal(resolved.assertions[0].expected, "wire");
  assert.equal(requestCookieHeader(resolved.cookies), "role=wire");
  assert.deepEqual(resolved.openapiOperation, request.openapiOperation);
  for (const key of [
    "schema",
    "responses",
    "examples",
    "openapiExampleSources",
  ])
    assert.deepEqual(
      resolved[key],
      interpolate(request[key], { live: "wire" }),
    );
  assert.deepEqual(request, before);
  await assert.rejects(
    () =>
      resolveDynamicRequest(
        request,
        { host: "127.0.0.1:1", token: "test-token" },
        [],
        interpolate,
      ),
    /未定义变量: live/,
  );
});
