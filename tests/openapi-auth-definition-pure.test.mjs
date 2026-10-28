import test from "node:test";
import assert from "node:assert/strict";
import { openAPIAuthDefinition as projectAuth } from "../src/openapi-auth-definition.mjs";

const definition = (auth, extra = {}, project = {}, registry) =>
  projectAuth(project, { auth, ...extra }, registry);
const scheme = (result) => Object.values(result.securitySchemes)[0];
test("canonical basic/bearer/API keys project only public mechanisms and reuse definitions", () => {
  for (const [auth, expected] of [
    [
      { type: "basic", username: "SECRET_USER", password: "SECRET_PASSWORD" },
      { type: "http", scheme: "basic" },
    ],
    [
      { type: "bearer", token: "SECRET_TOKEN" },
      { type: "http", scheme: "bearer" },
    ],
    [
      { type: "apiKey", key: "X-Key", value: "SECRET_KEY" },
      { type: "apiKey", in: "header", name: "X-Key" },
    ],
    [
      { type: "apiKey", in: "query", key: "access_key", value: "SECRET_KEY" },
      { type: "apiKey", in: "query", name: "access_key" },
    ],
  ]) {
    const source = structuredClone(auth);
    const a = definition(auth, {
      openapiOperation: { security: [{ OldBearer: [] }] },
    });
    assert.deepEqual(scheme(a), expected);
    assert.doesNotMatch(JSON.stringify(a), /SECRET|OldBearer/);
    const b = definition(
      {
        ...auth,
        username: "other",
        password: "other",
        token: "other",
        value: "other",
      },
      {},
      {},
      a.securitySchemes,
    );
    assert.deepEqual(a, b);
    assert.deepEqual(auth, source);
  }
});
test("closed noauth and snapshots override stale security without enabling credentials", () => {
  for (const closed of [{ inheritAuth: false }, { authSnapshot: true }]) {
    const r = definition(
      { type: "none" },
      { ...closed, openapiOperation: { security: [{ Old: [] }] } },
      { settings: { globalAuth: { type: "bearer", token: "secret" } } },
    );
    assert.deepEqual(r, { security: [] });
  }
});
test("untouched imported OR/AND/optional metadata wins over shared runtime overlay", () => {
  for (const security of [
    [{ A: [] }, { B: [] }],
    [{ A: [], B: [] }],
    [{}, { A: [] }],
    [],
    null,
  ]) {
    const request = { auth: { type: "none" }, openapiOperation: { security } };
    const project = {
      settings: { globalAuth: { type: "basic", password: "secret" } },
    };
    const snapshot = structuredClone({ request, project });
    assert.deepEqual(projectAuth(project, request), { security });
    assert.deepEqual({ request, project }, snapshot);
  }
});
test("native shared global/folder/recursive/snapshot precedence is reused without project leakage", () => {
  const project = {
    settings: {
      recursiveFolderScopes: true,
      globalAuth: { type: "bearer", token: "g" },
      folderAuth: {
        parent: { type: "basic", password: "p" },
        "parent/child": { type: "apiKey", key: "X-Key", value: "v" },
      },
    },
  };
  assert.equal(
    scheme(definition({ type: "none" }, {}, project)).scheme,
    "bearer",
  );
  assert.equal(
    scheme(definition({ type: "none" }, { folder: "parent/other" }, project))
      .scheme,
    "basic",
  );
  assert.equal(
    scheme(definition({ type: "none" }, { folder: "parent/child" }, project))
      .name,
    "X-Key",
  );
  assert.equal(
    scheme(
      definition(
        { type: "basic" },
        { folder: "parent/child", authSnapshot: true },
        project,
      ),
    ).scheme,
    "basic",
  );
  assert.deepEqual(definition({ type: "none" }, {}, {}), { security: [] });
});
test("invalid registries, collisions and unsupported definitions fail without mutation or secret diagnostics", () => {
  for (const registry of [null, [], "SECRET_REGISTRY", 4])
    assert.throws(
      () => definition({ type: "basic" }, {}, {}, registry),
      /securitySchemes 无效/,
    );
  const good = definition({ type: "basic" });
  const key = Object.keys(good.securitySchemes)[0];
  const registry = {
    [key]: { type: "http", scheme: "bearer" },
    unrelated: { type: "apiKey", name: "preserve", in: "header" },
  };
  const snapshot = structuredClone(registry);
  assert.throws(
    () => definition({ type: "basic", password: "SECRET" }, {}, {}, registry),
    /认证方案冲突/,
  );
  assert.deepEqual(registry, snapshot);
  for (const type of [
    "digest",
    "ntlm",
    "oauth1",
    "oauth2",
    "aws",
    "hawk",
    "edgegrid",
    "SECRET_UNKNOWN",
  ])
    assert.throws(
      () => definition({ type, token: "SECRET" }),
      (error) =>
        /不支持/.test(error.message) && !error.message.includes("SECRET"),
    );
  for (const auth of [
    { type: "apiKey", key: "SECRET\n" },
    { type: "apiKey", key: "x", in: "cookie" },
    { type: "apiKey" },
  ])
    assert.throws(
      () => definition(auth),
      (error) =>
        /API Key/.test(error.message) && !error.message.includes("SECRET"),
    );
});
test("JWT/ASAP retain legacy names and scheme definitions", () => {
  const a = definition({ type: "jwt", secret: "SECRET" });
  const b = definition({ type: "asap", privateKey: "SECRET" });
  assert.deepEqual(a, b);
  assert.match(Object.keys(a.securitySchemes)[0], /^localapi_jwt_/);
  assert.deepEqual(scheme(a), {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  assert.equal(
    scheme(
      definition({
        type: "jwt",
        addTokenTo: "queryParam",
        queryParamKey: "jwt",
      }),
    ).name,
    "jwt",
  );
  assert.equal(
    scheme(definition({ type: "jwt", headerPrefix: "Custom" })).name,
    "Authorization",
  );
});
test("closed native scopes, folder none and nonrecursive settings stay isolated and immutable", () => {
  const project = {
    settings: {
      globalAuth: { type: "bearer", token: "SECRET" },
      folderAuth: {
        parent: { type: "basic", password: "SECRET" },
        "parent/closed": { type: "none" },
      },
    },
  };
  const before = structuredClone(project);
  assert.equal(
    scheme(definition({ type: "none" }, { folder: "parent/other" }, project))
      .scheme,
    "bearer",
  );
  assert.deepEqual(
    definition({ type: "none" }, { folder: "parent/closed" }, project),
    { security: [] },
  );
  assert.deepEqual(
    definition({ type: "none" }, { inheritAuth: false }, project),
    { security: [] },
  );
  assert.deepEqual(project, before);
  const registry = JSON.parse(
    '{"__proto__":{"note":"keep"},"constructor":{"note":"also keep"}}',
  );
  const result = definition({ type: "basic" }, {}, {}, registry);
  assert.deepEqual(result.securitySchemes.__proto__, registry.__proto__);
  assert.deepEqual(result.securitySchemes.constructor, registry.constructor);
  assert.equal(Object.getPrototypeOf(result.securitySchemes), Object.prototype);
  for (const key of ["Bad Key", "Bad:Key", "Bad\tKey", "Bad\0Key"])
    assert.throws(() => definition({ type: "apiKey", key }), /API Key/);
});
test("API Key query names are bounded well-formed public text without controls", () => {
  for (const key of [
    "x".repeat(257),
    "bad\ud800",
    "bad\udfff",
    "bad\u007f",
    "bad\u0001",
    "{{environment_key}}",
  ])
    assert.throws(
      () => definition({ type: "apiKey", key, in: "query", value: "secret" }),
      /API Key/,
    );
  assert.equal(
    scheme(
      definition({
        type: "apiKey",
        key: "公共🔑",
        in: "query",
        value: "secret",
      }),
    ).name,
    "公共🔑",
  );
});
test("new mechanism registry equality ignores key order but rejects extra or changed properties", () => {
  for (const auth of [
    { type: "basic" },
    { type: "bearer" },
    { type: "apiKey", key: "X-Key", in: "header" },
    { type: "apiKey", key: "key", in: "query" },
  ]) {
    const generated = definition(auth);
    const name = Object.keys(generated.securitySchemes)[0];
    const reversed = Object.fromEntries(
      Object.entries(generated.securitySchemes[name]).reverse(),
    );
    const registry = { [name]: reversed };
    const before = structuredClone(registry);
    assert.deepEqual(definition(auth, {}, {}, registry), generated);
    assert.deepEqual(registry, before);
    for (const conflict of [
      { ...reversed, description: "additional" },
      { ...reversed, type: "changed" },
    ]) {
      const bad = { [name]: conflict },
        snapshot = structuredClone(bad);
      assert.throws(() => definition(auth, {}, {}, bad), /认证方案冲突/);
      assert.deepEqual(bad, snapshot);
    }
  }
  const jwt = definition({ type: "jwt" });
  const name = Object.keys(jwt.securitySchemes)[0];
  const reordered = {
    [name]: Object.fromEntries(
      Object.entries(jwt.securitySchemes[name]).reverse(),
    ),
  };
  assert.throws(
    () => definition({ type: "jwt" }, {}, {}, reordered),
    /JWT认证方案冲突/,
  );
});
