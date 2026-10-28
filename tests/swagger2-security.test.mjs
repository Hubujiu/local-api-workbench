import test from "node:test";
import assert from "node:assert/strict";
import { swagger2SecurityDefinitions } from "../src/swagger2-security.mjs";

const doc = (securityDefinitions = {}, extra = {}) => ({
  swagger: "2.0",
  securityDefinitions,
  paths: {},
  ...extra,
});
const oauth = (flow) => ({
  type: "oauth2",
  flow,
  ...(["implicit", "accessCode"].includes(flow)
    ? { authorizationUrl: "/oauth/authorize?prompt=consent" }
    : {}),
  ...(flow !== "implicit"
    ? { tokenUrl: "https://auth.example.invalid/token" }
    : {}),
  scopes: { read: "Read records", "write:all": "" },
});
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("Swagger2 security converts Basic and header/query APIKey definitions without credentials", () => {
  assert.deepEqual(
    swagger2SecurityDefinitions(
      doc({
        Basic: { type: "basic" },
        Header: { type: "apiKey", in: "header", name: "X-API-Key" },
        Query: { type: "apiKey", in: "query", name: "api key + &" },
      }),
    ),
    {
      Basic: { type: "http", scheme: "basic" },
      Header: { type: "apiKey", in: "header", name: "X-API-Key" },
      Query: { type: "apiKey", in: "query", name: "api key + &" },
    },
  );
});

test("Swagger2 security maps all four OAuth2 flows and preserves applicable URL references and scopes", () => {
  for (const [source, target] of Object.entries({
    implicit: "implicit",
    password: "password",
    application: "clientCredentials",
    accessCode: "authorizationCode",
  })) {
    const { type, flow, ...expected } = oauth(source);
    assert.deepEqual(
      swagger2SecurityDefinitions(doc({ OAuth: oauth(source) })),
      {
        OAuth: { type: "oauth2", flows: { [target]: expected } },
      },
    );
  }
});

test("Swagger2 security validates root and owned operation OR/AND/empty/anonymous requirements without rewriting them", () => {
  const input = freeze(
    doc(
      {
        Basic: { type: "basic" },
        Key: { type: "apiKey", in: "query", name: "key" },
        OAuth: oauth("application"),
      },
      {
        security: [{ Basic: [], Key: [] }, { OAuth: ["read", "write:all"] }],
        paths: {
          "/inherit": { get: {} },
          "/public": { get: { security: [] } },
          "/optional": { get: { security: [{}, { Basic: [] }] } },
          "/override": { post: { security: [{ OAuth: ["write:all"] }] } },
        },
      },
    ),
  );
  const before = structuredClone(input);
  swagger2SecurityDefinitions(input);
  assert.deepEqual(input, before);
});

test("Swagger2 security preserves description and opaque extension JSON, including literal external $ref", () => {
  const input = freeze(
    doc({
      Basic: {
        type: "basic",
        description: "中文 description",
        "x-note": {
          $ref: "https://example.invalid/literal",
          nested: [null, false, 1, { a: "b" }],
        },
      },
    }),
  );
  const converted = swagger2SecurityDefinitions(input);
  assert.deepEqual(converted.Basic, {
    type: "http",
    scheme: "basic",
    description: input.securityDefinitions.Basic.description,
    "x-note": input.securityDefinitions.Basic["x-note"],
  });
  converted.Basic["x-note"].nested.push("local-only");
  assert.equal(input.securityDefinitions.Basic["x-note"].nested.length, 4);
});

test("Swagger2 security rejects malformed registries, unresolved references and unsupported component names", () => {
  for (const registry of [null, [], false, 1, "basic"])
    assert.throws(
      () => swagger2SecurityDefinitions(doc(registry)),
      /securityDefinitions/,
    );
  for (const name of [
    "",
    "has space",
    "a/b",
    "非ASCII",
    "__proto__",
    "constructor",
    "prototype",
  ]) {
    assert.throws(
      () =>
        swagger2SecurityDefinitions(
          doc(Object.fromEntries([[name, { type: "basic" }]])),
        ),
      /component name/,
    );
  }
  for (const scheme of [
    null,
    [],
    "basic",
    { $ref: "#/securityDefinitions/Cycle" },
    { type: "http", scheme: "basic" },
  ]) {
    assert.throws(
      () => swagger2SecurityDefinitions(doc({ Invalid: scheme })),
      /Swagger 2 security/,
    );
  }
  assert.equal(
    swagger2SecurityDefinitions({
      openapi: "3.0.3",
      securityDefinitions: null,
    }),
    undefined,
  );
  assert.deepEqual(
    swagger2SecurityDefinitions({ swagger: "2.0", paths: {} }),
    {},
  );
  assert.throws(
    () => swagger2SecurityDefinitions({ swagger: "1.2" }),
    /only Swagger 2.0/,
  );
});

test("Swagger2 security rejects invalid scheme fields instead of silently losing metadata", () => {
  for (const scheme of [
    { type: "basic", username: "not-inferred" },
    { type: "basic", description: 1 },
    { type: "apiKey", in: "cookie", name: "sid" },
    { type: "apiKey", in: "header", name: "invalid name" },
    { type: "apiKey", in: "query", name: "" },
    { type: "apiKey", in: "query", name: "line\nfeed" },
    { type: "basic", "x-value": undefined },
    { type: "basic", "x-value": NaN },
  ])
    assert.throws(
      () => swagger2SecurityDefinitions(doc({ Invalid: scheme })),
      /Swagger 2 security/,
    );
});

test("Swagger2 security rejects unsupported OAuth flow, missing or inapplicable URLs and malformed scope definitions", () => {
  for (const mutate of [
    (s) => {
      s.flow = "clientCredentials";
    },
    (s) => {
      s.flow = ["password"];
    },
    (s) => {
      delete s.tokenUrl;
    },
    (s) => {
      s.tokenUrl = "bad URL";
    },
    (s) => {
      s.tokenUrl = 1;
    },
    (s) => {
      s.authorizationUrl = "/inapplicable";
    },
    (s) => {
      s.scopes = [];
    },
    (s) => {
      s.scopes = { read: 3 };
    },
    (s) => {
      s.scopes = JSON.parse('{"__proto__":"unsafe"}');
    },
    (s) => {
      delete s.scopes;
    },
  ]) {
    const scheme = oauth("password");
    mutate(scheme);
    assert.throws(
      () => swagger2SecurityDefinitions(doc({ OAuth: scheme })),
      /Swagger 2 security/,
    );
  }
  const implicit = oauth("implicit");
  implicit.tokenUrl = "/inapplicable";
  assert.throws(
    () => swagger2SecurityDefinitions(doc({ OAuth: implicit })),
    /not applicable/,
  );
});

test("Swagger2 security requirement validation uses only source definitions and declared OAuth scopes", () => {
  for (const security of [
    null,
    {},
    "Basic",
    [null],
    [[]],
    [{ Missing: [] }],
    [{ Basic: "" }],
    [{ Basic: ["read"] }],
    [{ OAuth: [1] }],
    [{ OAuth: ["missing"] }],
    [JSON.parse('{"__proto__":[]}')],
  ]) {
    const input = doc(
      { Basic: { type: "basic" }, OAuth: oauth("password") },
      { security },
    );
    assert.throws(() => swagger2SecurityDefinitions(input), /root security/);
    delete input.security;
    input.paths = { "/last": { delete: { security } } };
    assert.throws(
      () => swagger2SecurityDefinitions(input),
      /delete \/last security/,
    );
  }
});

test("Swagger2 hybrid source component containers fail closed and equivalent key order does not conflict", () => {
  for (const field of ["components", "openapiComponents"]) {
    for (const alias of [
      { $ref: "#/securityDefinitions/Basic" },
      { type: "http", scheme: "basic" },
    ])
      assert.throws(
        () =>
          swagger2SecurityDefinitions(
            doc(
              { Basic: { type: "basic" } },
              { [field]: { securitySchemes: { Extra: alias } } },
            ),
          ),
        /non-source scheme/,
      );
    for (const value of [
      null,
      [],
      "abc",
      false,
      { securitySchemes: null },
      { securitySchemes: [] },
      { securitySchemes: "abc" },
    ]) {
      assert.throws(
        () =>
          swagger2SecurityDefinitions(
            doc({ Basic: { type: "basic" } }, { [field]: value }),
          ),
        /must be an object/,
      );
    }
    assert.throws(
      () =>
        swagger2SecurityDefinitions(
          doc(
            { Basic: { type: "basic" } },
            {
              [field]: {
                securitySchemes: {
                  Basic: { type: "apiKey", in: "query", name: "wrong" },
                },
              },
            },
          ),
        ),
      /conflicting source component/,
    );
    const input = doc(
      { Basic: { type: "basic" } },
      {
        [field]: {
          schemas: { Keep: { type: "string" } },
          securitySchemes: { Basic: { scheme: "basic", type: "http" } },
        },
      },
    );
    const before = structuredClone(input);
    assert.deepEqual(swagger2SecurityDefinitions(input), {
      Basic: { type: "http", scheme: "basic" },
    });
    assert.deepEqual(input, before);
  }
});

test("Swagger2 security conversion remains source-atomic when a late definition fails", () => {
  const input = doc({
    Basic: { type: "basic" },
    OAuth: oauth("password"),
    Last: { type: "apiKey", in: "cookie", name: "invalid" },
  });
  const before = structuredClone(input);
  assert.throws(() => swagger2SecurityDefinitions(input));
  assert.deepEqual(input, before);
});
