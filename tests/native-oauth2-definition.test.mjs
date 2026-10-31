import test from "node:test";
import assert from "node:assert/strict";
import {
  importApipostOAuth2,
  exportApipostOAuth2,
} from "../src/apipost-oauth2-auth.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
const full = () => ({
  addTokenTo: "header",
  headerPrefix: "Bearer",
  access_token: "{{token}}",
  grant_type: "authorization_code",
  redirect_uri: "{{redirect}}",
  authUrl: "{{authUrl}}",
  accessTokenUrl: "{{tokenUrl}}",
  clientId: "{{clientId}}",
  clientSecret: "{{clientSecret}}",
  username: "{{username}}",
  password: "{{password}}",
  challengeAlgorithm: "S256",
  code_verifier: "Bearer",
  scope: "a b",
  state: "{{$randomUUID}}",
  client_authentication: "header",
  refreshTokenUrl: "{{refreshUrl}}",
  authRequestParams: [
    {
      param_id: "stable-id",
      key: "{{unused}}",
      value: { arbitrary: [null, true, 42, "雪"], toJSON: "inert-data" },
    },
  ],
  tokenRequestParams: [{ unknown_member: "kept" }],
  refreshRequestParams: [],
});
test("native OAuth2 full definitions retain every field and inert JSON through two inverses", () => {
  for (const definition of [
    full(),
    { ...full(), addTokenTo: "queryParams", headerPrefix: "{{unused}}" },
    {},
    { access_token: "", headerPrefix: "" },
  ]) {
    const before = structuredClone(definition);
    const imported = importApipostOAuth2(definition),
      exported = exportApipostOAuth2(imported);
    assert.deepEqual(imported, { type: "oauth2", nativeOAuth2: before });
    assert.deepEqual(exported, { type: "oauth2", oauth2: before });
    assert.deepEqual(importApipostOAuth2(exported.oauth2), imported);
    assert.deepEqual(
      exportApipostOAuth2(importApipostOAuth2(exported.oauth2)),
      exported,
    );
    assert.deepEqual(definition, before);
  }
});
test("native OAuth2 mapping dispatch selects only its section and clones all mutable data", () => {
  let reads = 0;
  const definition = full();
  const envelope = { type: "oauth2", oauth2: definition };
  Object.defineProperty(envelope, "oauth1", {
    enumerable: true,
    get() {
      reads++;
      throw Error("inactive");
    },
  });
  const imported = importExtendedApipostAuth(envelope),
    expected = structuredClone(imported);
  definition.authRequestParams[0].value.arbitrary.push("source mutation");
  assert.deepEqual(imported, expected);
  const exported = exportExtendedApipostAuth(imported);
  exported.oauth2.authRequestParams[0].value.arbitrary.push("output mutation");
  assert.deepEqual(imported, expected);
  assert.equal(reads, 0);
});
test("native OAuth2 conversion rejects legacy token config and unknown metadata without disclosure", () => {
  for (const definition of [
    { accessToken: "private-sentinel" },
    { refresh_token: "private-sentinel" },
    { addTokenTo: "body" },
    { addTokenTo: "{{mode}}" },
    { access_token: 3 },
    { tokenRequestParams: {} },
  ])
    assert.throws(
      () => importApipostOAuth2(definition),
      (error) =>
        error.message === "原生 OAuth2 定义无法保真映射，请使用项目备份",
    );
  for (const value of [
    { type: "oauth2", token: "private-sentinel" },
    { type: "oauth2", nativeOAuth2: {}, token: "private-sentinel" },
    { type: "bearer", nativeOAuth2: {} },
  ])
    assert.throws(
      () => exportApipostOAuth2(value),
      (error) =>
        error.message === "原生 OAuth2 定义无法保真映射，请使用项目备份",
    );
});
test("native OAuth2 source/control descriptors never evaluate getters or toJSON", () => {
  let reads = 0;
  const get = () => {
    reads++;
    return "private-sentinel";
  };
  const definition = Object.defineProperty({}, "access_token", {
    enumerable: true,
    get,
  });
  const array = [];
  Object.defineProperty(array, "0", { enumerable: true, get });
  for (const value of [
    definition,
    { tokenRequestParams: array },
    {
      tokenRequestParams: [
        {
          toJSON() {
            reads++;
            return {};
          },
        },
      ],
    },
    Object.defineProperty({}, "access_token", { value: "hidden" }),
    { [Symbol("x")]: "unknown" },
  ]) {
    assert.throws(() => importApipostOAuth2(value));
    assert.throws(() =>
      exportApipostOAuth2({ type: "oauth2", nativeOAuth2: value }),
    );
  }
  const envelope = { type: "oauth2" };
  Object.defineProperty(envelope, "oauth2", { enumerable: true, get });
  assert.throws(() => importExtendedApipostAuth(envelope));
  assert.equal(reads, 0);
});
test("native OAuth2 exact UTF8 limit and malformed JSON data remain symmetric", () => {
  const size = 65536 - Buffer.byteLength(JSON.stringify({ access_token: "" }));
  const value = { access_token: "a".repeat(size) };
  assert.deepEqual(
    exportApipostOAuth2(importApipostOAuth2(value)).oauth2,
    value,
  );
  assert.throws(() =>
    importApipostOAuth2({ access_token: value.access_token + "a" }),
  );
  assert.throws(() =>
    exportApipostOAuth2({
      type: "oauth2",
      nativeOAuth2: { access_token: value.access_token + "a" },
    }),
  );
  const cycle = [];
  cycle.push(cycle);
  for (const bad of [
    cycle,
    new Array(1),
    [undefined],
    [NaN],
    [-0],
    [new Date()],
    [JSON.parse('{"__proto__":{}}')],
  ])
    assert.throws(() => importApipostOAuth2({ authRequestParams: bad }));
});
test("native OAuth2 null prototypes and frozen definitions preserve optional presence", () => {
  const source = Object.assign(Object.create(null), { access_token: "" });
  Object.freeze(source);
  const first = importApipostOAuth2(source);
  Object.freeze(first.nativeOAuth2);
  Object.freeze(first);
  const exported = exportApipostOAuth2(first);
  assert.deepEqual(exported.oauth2, { access_token: "" });
  assert.equal(Object.hasOwn(exported.oauth2, "addTokenTo"), false);
  assert.equal(Object.hasOwn(exported.oauth2, "headerPrefix"), false);
});
