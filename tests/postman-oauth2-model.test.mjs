import test from "node:test";
import assert from "node:assert/strict";
import {
  importPostmanOAuth2,
  postmanOAuth2Definition,
  resolvePostmanOAuth2,
} from "../public/postman-oauth2-model.js";
import { validateAuth } from "../public/auth-model.js";
const auth = (fields = {}) => ({
  type: "oauth2",
  postmanOAuth2: { version: 1, ...fields },
});
const rows = (fields) =>
  Object.entries(fields).map(([key, value]) => ({
    key,
    value,
    type: "string",
  }));
test("Postman policy preserves missing/empty fields, copies, and is distinct from ordinary auth", () => {
  for (const fields of [
    {},
    { accessToken: "" },
    { accessToken: "{{token}}", headerPrefix: "" },
    { addTokenTo: "", tokenType: "BeArEr", headerPrefix: "  Custom  " },
    { addTokenTo: "queryParams", headerPrefix: "{{unused}}" },
  ]) {
    const input = rows(fields),
      before = structuredClone(input);
    const result = importPostmanOAuth2(input);
    assert.deepEqual(result, auth(fields));
    assert.deepEqual(input, before);
    assert.deepEqual(
      postmanOAuth2Definition(JSON.parse(JSON.stringify(result))),
      result.postmanOAuth2,
    );
    const copy = postmanOAuth2Definition(result);
    copy.headerPrefix = "changed";
    assert.notEqual(result.postmanOAuth2.headerPrefix, "changed");
    validateAuth(result);
  }
  for (const ordinary of [
    { type: "oauth2", token: "ordinary" },
    { type: "bearer", token: "ordinary" },
    { type: "none" },
  ])
    assert.equal(postmanOAuth2Definition(ordinary), undefined);
});
test("strict model rejects malformed markers, ambiguous rows, unsafe data, and unsupported policies", () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, "accessToken", {
    enumerable: true,
    get() {
      getterCalls++;
      return "token";
    },
  });
  const outerGetter = Object.defineProperty(
    { type: "oauth2" },
    "postmanOAuth2",
    {
      enumerable: true,
      get() {
        getterCalls++;
        return { version: 1 };
      },
    },
  );
  const malformed = [
    { ...auth(), type: "none" },
    { ...auth(), token: "mixed" },
    { ...auth(), nativeOAuth2: {} },
    { type: "oauth2", postmanOAuth2: undefined },
    { type: "oauth2", postmanOAuth2: getter },
    outerGetter,
    Object.create(auth()),
    auth({ version: 2 }),
    auth({ tokenType: "MAC" }),
    auth({ tokenType: "custom" }),
    auth({ addTokenTo: "body" }),
    auth({ accessToken: undefined }),
    auth({ headerPrefix: null }),
    auth({ accessToken: 42 }),
    auth({ unknown: "" }),
    auth({ accessToken: "a\r\nb" }),
    auth({ headerPrefix: "\t" }),
    auth({ accessToken: "\ud800" }),
    auth({ accessToken: "雪".repeat(3000) }),
  ];
  for (const input of malformed)
    assert.throws(() => validateAuth(input), /Postman OAuth2/);
  assert.equal(getterCalls, 0);
  for (const input of [
    [...rows({ accessToken: "a" }), ...rows({ accessToken: "b" })],
    rows({ clientSecret: "secret" }),
    [{ key: "accessToken", value: "a", disabled: true }],
    [{ key: "accessToken", value: "a", type: "number" }],
    [getter],
    Array(1),
  ])
    assert.throws(() => importPostmanOAuth2(input), /Postman OAuth2/);
  assert.equal(getterCalls, 0);
});
test("resolve only active token and header prefix; preserve inactive metadata literally", () => {
  const interpolate = (value, vars) =>
    value.replace(/\{\{(.*?)\}\}/g, (_, key) => {
      if (!(key in vars)) throw Error("missing " + key);
      return vars[key];
    });
  const source = auth({ accessToken: "{{token}}", headerPrefix: "{{prefix}}" });
  assert.deepEqual(
    resolvePostmanOAuth2(source, interpolate, { token: "live", prefix: "" }),
    { version: 1, accessToken: "live", headerPrefix: "" },
  );
  assert.equal(source.postmanOAuth2.accessToken, "{{token}}");
  for (const input of [
    auth({ accessToken: "", headerPrefix: "{{missing}}" }),
    auth({ accessToken: "{{empty}}", headerPrefix: "{{missing}}" }),
    auth({
      accessToken: "{{token}}",
      addTokenTo: "queryParams",
      headerPrefix: "{{missing}}",
    }),
  ])
    assert.equal(
      resolvePostmanOAuth2(input, interpolate, { token: "live", empty: "" })
        .headerPrefix,
      "{{missing}}",
    );
  assert.throws(
    () =>
      resolvePostmanOAuth2(source, interpolate, {
        token: "bad\n",
        prefix: "ok",
      }),
    /Postman OAuth2/,
  );
  assert.throws(() => resolvePostmanOAuth2(source, interpolate, {}), /missing/);
});
