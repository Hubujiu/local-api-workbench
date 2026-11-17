import test from "node:test";
import assert from "node:assert/strict";
import { nativeOAuth2Definition } from "../public/native-oauth2-model.js";
const auth = (definition) => ({ type: "oauth2", nativeOAuth2: definition });
test("native OAuth2 retains all known definition data without defaults or evaluation", () => {
  const input = auth({
    addTokenTo: "queryParams",
    headerPrefix: "{{unused}}",
    access_token: "{{token}}",
    grant_type: "authorization_code",
    redirect_uri: "{{redirect}}",
    authUrl: "https://invalid/auth",
    accessTokenUrl: "https://invalid/token",
    clientId: "client",
    clientSecret: "{{secret}}",
    username: "u",
    password: "p",
    challengeAlgorithm: "S256",
    code_verifier: "Bearer",
    scope: "a b",
    state: "{{$randomUUID}}",
    client_authentication: "header",
    refreshTokenUrl: "https://invalid/refresh",
    authRequestParams: [
      {
        param_id: "keep",
        name: "{{unknown}}",
        nested: { list: [null, true, 1, "雪"] },
      },
    ],
    tokenRequestParams: [],
    refreshRequestParams: [{ value: "{{missing}}" }],
  });
  const before = structuredClone(input),
    output = nativeOAuth2Definition(input);
  assert.deepEqual(output, input.nativeOAuth2);
  output.authRequestParams[0].nested.list.push(2);
  assert.deepEqual(input, before);
  assert.deepEqual(nativeOAuth2Definition(auth({})), {});
  assert.equal(
    nativeOAuth2Definition({ type: "oauth2", token: "legacy" }),
    undefined,
  );
});
test("native OAuth2 rejects ambiguous controls, unknown fields and unsafe JSON atomically", () => {
  const cycle = [];
  cycle.push(cycle);
  const hole = new Array(1);
  for (const definition of [
    { addTokenTo: "{{mode}}" },
    { addTokenTo: "query" },
    { access_token: 1 },
    { token_type: "Bearer" },
    { clientId: "\ud800" },
    { authRequestParams: {} },
    { authRequestParams: [undefined] },
    { authRequestParams: [NaN] },
    { authRequestParams: [-0] },
    { authRequestParams: [new Date()] },
    { authRequestParams: cycle },
    { authRequestParams: hole },
    { authRequestParams: [JSON.parse('{"__proto__":{}}')] },
    { authRequestParams: Array(257).fill(null) },
    { clientSecret: "x".repeat(65537) },
  ])
    assert.throws(
      () => nativeOAuth2Definition(auth(definition)),
      /原生 OAuth2/,
    );
  for (const input of [
    { type: "bearer", nativeOAuth2: {} },
    { ...auth({}), token: "conflict" },
    Object.assign(Object.create({ nativeOAuth2: {} }), { type: "oauth2" }),
  ])
    assert.throws(() => nativeOAuth2Definition(input), /原生 OAuth2/);
});
test("native OAuth2 descriptors never invoke getters, toJSON or array hooks", () => {
  let calls = 0;
  const definition = {};
  Object.defineProperty(definition, "access_token", {
    enumerable: true,
    get() {
      calls++;
      return "secret";
    },
  });
  const outer = { type: "oauth2" };
  Object.defineProperty(outer, "nativeOAuth2", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  const array = ["ok"];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      calls++;
      return "secret";
    },
  });
  for (const input of [
    auth(definition),
    outer,
    auth({ tokenRequestParams: array }),
    auth({
      tokenRequestParams: [
        {
          toJSON() {
            calls++;
            return {};
          },
        },
      ],
    }),
    auth(Object.defineProperty({}, "access_token", { value: "hidden" })),
    auth({ [Symbol("secret")]: "value" }),
  ])
    assert.throws(() => nativeOAuth2Definition(input), /原生 OAuth2/);
  assert.equal(calls, 0);
});
test("native OAuth2 enforces cumulative depth/node/UTF8 bounds and preserves plain null prototypes", () => {
  let deep = {};
  for (let i = 0; i < 10; i++) deep = { nested: deep };
  assert.throws(() =>
    nativeOAuth2Definition(auth({ authRequestParams: [deep] })),
  );
  assert.throws(() =>
    nativeOAuth2Definition(
      auth({
        authRequestParams: Array.from({ length: 256 }, () => Array(9).fill(1)),
      }),
    ),
  );
  assert.throws(() =>
    nativeOAuth2Definition(auth({ state: "雪".repeat(23000) })),
  );
  const definition = Object.assign(Object.create(null), {
    access_token: "literal",
  });
  assert.deepEqual(nativeOAuth2Definition(auth(definition)), {
    access_token: "literal",
  });
});
