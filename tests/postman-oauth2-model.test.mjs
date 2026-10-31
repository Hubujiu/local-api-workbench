import test from "node:test";
import assert from "node:assert/strict";
import {
  importPostmanOAuth2,
  postmanOAuth2Definition,
  resolvePostmanOAuth2,
  validatePostmanOAuth2Project,
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
    auth({ accessToken: "x".repeat(100000) }),
  ];
  for (const input of malformed)
    assert.throws(() => validateAuth(input), /Postman OAuth2/);
  assert.equal(getterCalls, 0);
  for (const input of [
    [...rows({ accessToken: "a" }), ...rows({ accessToken: "b" })],
    rows({ grant_type: "secret" }),
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

test("project preflight rejects malformed request, frozen and shared policies without invoking getters", () => {
  let calls = 0;
  const invalid = {
    type: "oauth2",
    postmanOAuth2: Object.defineProperty({ version: 1 }, "accessToken", {
      enumerable: true,
      get() {
        calls++;
        return "secret";
      },
    }),
  };
  for (const project of [
    { requests: [{ auth: invalid }] },
    { plans: [{ steps: [{ request: { auth: invalid } }] }] },
    { cases: [{ request: { auth: invalid } }] },
    { settings: { globalAuth: invalid } },
    { settings: { folderAuth: { folder: invalid } } },
  ])
    assert.throws(
      () => validatePostmanOAuth2Project(project),
      /Postman OAuth2/,
    );
  assert.equal(calls, 0);
});

test("folder policy validation precedes aggregate serialization and preserves budgets", async () => {
  // Audited pure closure: shared-auth -> auth-model, global-parameters and folder-scopes only.
  const { validateSharedAuthSettings } = await import(
    "../public/shared-auth.js"
  );
  const { applySharedAuth } = await import("../src/shared-auth.mjs");
  let calls = 0;
  const invalid = {
    type: "oauth2",
    postmanOAuth2: Object.defineProperty({ version: 1 }, "accessToken", {
      enumerable: true,
      get() {
        calls++;
        return "secret";
      },
    }),
  };
  const settings = { folderAuth: { folder: invalid } };
  assert.throws(() => validateSharedAuthSettings(settings), /Postman OAuth2/);
  assert.throws(
    () =>
      applySharedAuth(
        { settings },
        { folder: "folder", auth: { type: "none" } },
      ),
    /Postman OAuth2/,
  );
  assert.equal(calls, 0);
  const safe = { folderAuth: { folder: auth({ accessToken: "safe" }) } },
    before = structuredClone(safe);
  validateSharedAuthSettings(safe);
  assert.deepEqual(
    applySharedAuth(
      { settings: safe },
      { folder: "folder", auth: { type: "none" } },
    ).auth,
    safe.folderAuth.folder,
  );
  assert.deepEqual(safe, before);
  const large = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      "f" + i,
      auth({ accessToken: "a".repeat(8192) }),
    ]),
  );
  assert.throws(
    () => validateSharedAuthSettings({ folderAuth: large }),
    /256KiB/,
  );
});

test("plan preflight checks disabled steps without touching malformed policy accessors", () => {
  let calls = 0;
  const malformed = {
    type: "oauth2",
    postmanOAuth2: Object.defineProperty({ version: 1 }, "accessToken", {
      enumerable: true,
      get() {
        calls++;
        return "token";
      },
    }),
  };
  const safe = { auth: auth({ accessToken: "safe" }) },
    before = structuredClone(safe);
  for (const enabled of [true, false])
    assert.throws(
      () =>
        validatePostmanOAuth2Project({
          plans: [
            {
              steps: [
                { request: safe },
                { enabled, request: { auth: malformed } },
              ],
            },
          ],
        }),
      /Postman OAuth2/,
    );
  assert.equal(calls, 0);
  assert.deepEqual(safe, before);
});

test("freeze entry validates policy before shared script/parameter cloning", async () => {
  // Audited data-only environment helper closure; no app, VM, HTTP or script executor imports.
  const { freezeServiceBinding } = await import("../src/environments.mjs");
  let calls = 0;
  const malformed = {
    url: "http://fixture.invalid",
    auth: {
      type: "oauth2",
      postmanOAuth2: Object.defineProperty({ version: 1 }, "accessToken", {
        enumerable: true,
        get() {
          calls++;
          return "token";
        },
      }),
    },
  };
  for (const includeSharedScripts of [true, false])
    assert.throws(
      () =>
        freezeServiceBinding({ settings: {} }, malformed, {
          includeSharedScripts,
        }),
      /Postman OAuth2/,
    );
  assert.equal(calls, 0);
  const safe = {
      url: "http://fixture.invalid",
      auth: auth({ accessToken: "safe" }),
    },
    before = structuredClone(safe);
  const frozen = freezeServiceBinding({ settings: {} }, safe);
  assert.deepEqual(frozen.auth, safe.auth);
  assert.notEqual(frozen.auth, safe.auth);
  assert.deepEqual(safe, before);
});

test("baseline plan and MCP clone helpers preflight Postman policies without laundering getters", async () => {
  const { snapshotInterfaceForPlan } = await import(
    "../public/plan-snapshots.js"
  );
  const { applyMCPInput } = await import("../src/mcp-request-input.mjs");
  let calls = 0;
  const invalid = {
    auth: {
      type: "oauth2",
      postmanOAuth2: Object.defineProperty({ version: 1 }, "accessToken", {
        enumerable: true,
        get() {
          calls++;
          return "token";
        },
      }),
    },
  };
  assert.throws(() => snapshotInterfaceForPlan(invalid), /Postman OAuth2/);
  for (const input of [
    undefined,
    {},
    { auth: { postmanOAuth2: { accessToken: "override" } } },
  ])
    assert.throws(() => applyMCPInput(invalid, input), /Postman OAuth2/);
  assert.equal(calls, 0);
  const safe = {
      auth: auth({ accessToken: "original", tokenType: "bearer" }),
      beforeScript: "original script",
    },
    before = structuredClone(safe);
  assert.deepEqual(snapshotInterfaceForPlan(safe).auth, safe.auth);
  assert.equal(snapshotInterfaceForPlan(safe).beforeScript, "");
  assert.equal(
    applyMCPInput(safe, {
      auth: { postmanOAuth2: { accessToken: "temporary" } },
    }).auth.postmanOAuth2.accessToken,
    "temporary",
  );
  assert.throws(
    () =>
      applyMCPInput(safe, { auth: { postmanOAuth2: { tokenType: "MAC" } } }),
    /Postman OAuth2/,
  );
  assert.deepEqual(safe, before);
});

const metadataFields = [
  "callBackUrl",
  "authUrl",
  "accessTokenUrl",
  "clientId",
  "clientSecret",
  "scope",
  "requestAccessTokenLocally",
];
test("seven fixture-backed metadata strings roundtrip inert, without coercion or acquisition interpretation", () => {
  const metadata = Object.fromEntries(
    metadataFields.map((key) => [key, "{{missing_" + key + "}}"]),
  );
  const original = {
    ...metadata,
    accessToken: "{{token}}",
    headerPrefix: "{{prefix}}",
    addTokenTo: "header",
    tokenType: "Bearer",
  };
  const input = Object.entries(original).map(([key, value]) => ({
      key,
      value,
    })),
    before = structuredClone(input);
  const imported = importPostmanOAuth2(input);
  assert.deepEqual(imported, auth(original));
  assert.deepEqual(input, before);
  const calls = [];
  const resolved = resolvePostmanOAuth2(
    imported,
    (value) => {
      calls.push(value);
      if (value === "{{token}}") return "live";
      if (value === "{{prefix}}") return "Custom";
      throw Error("inert metadata was interpreted");
    },
    {},
  );
  assert.deepEqual(calls, ["{{token}}", "{{prefix}}"]);
  for (const key of metadataFields) assert.equal(resolved[key], metadata[key]);
  assert.deepEqual(JSON.parse(JSON.stringify(imported)), auth(original));
  for (const key of metadataFields) {
    for (const value of [
      null,
      undefined,
      true,
      1,
      {},
      [],
      "x".repeat(8193),
      "\ud800",
      "bad\n",
    ])
      assert.throws(
        () => postmanOAuth2Definition(auth({ [key]: value })),
        /Postman OAuth2/,
      );
    let getterCalls = 0;
    const definition = Object.defineProperty({ version: 1 }, key, {
      enumerable: true,
      get() {
        getterCalls++;
        return "secret";
      },
    });
    assert.throws(
      () =>
        postmanOAuth2Definition({ type: "oauth2", postmanOAuth2: definition }),
      /Postman OAuth2/,
    );
    assert.equal(getterCalls, 0);
  }
  for (const unknown of ["id", "grant_type", "refreshOAuth2Token", "unknown"])
    assert.throws(
      () => importPostmanOAuth2([{ key: unknown, value: "no" }]),
      /Postman OAuth2/,
    );
  assert.throws(
    () => importPostmanOAuth2([...input, { key: "scope", value: "duplicate" }]),
    /Postman OAuth2/,
  );
  assert.throws(
    () =>
      importPostmanOAuth2([{ key: "clientId", value: "a", disabled: true }]),
    /Postman OAuth2/,
  );
});
test("combined active and opaque values are bounded at 32768 UTF-8 bytes, including after active resolution", () => {
  const exact = {
    accessToken: "t".repeat(8192),
    headerPrefix: "p".repeat(8192),
    clientSecret: "s".repeat(8192),
    scope: "雪".repeat(2730) + "aa",
  };
  assert.equal(
    Object.values(exact).reduce(
      (n, s) => n + new TextEncoder().encode(s).length,
      0,
    ),
    32768,
  );
  assert.deepEqual(postmanOAuth2Definition(auth(exact)), {
    version: 1,
    ...exact,
  });
  assert.throws(
    () => postmanOAuth2Definition(auth({ ...exact, clientId: "x" })),
    /Postman OAuth2/,
  );
  assert.throws(
    () => postmanOAuth2Definition(auth({ scope: "雪".repeat(2731) })),
    /Postman OAuth2/,
  );
  const templated = { ...exact, accessToken: "{{token}}", clientId: "x" };
  assert.doesNotThrow(() => postmanOAuth2Definition(auth(templated)));
  assert.throws(
    () =>
      resolvePostmanOAuth2(
        auth(templated),
        (value) => (value === "{{token}}" ? "t".repeat(8192) : value),
        {},
      ),
    /Postman OAuth2/,
  );
  assert.equal(templated.accessToken, "{{token}}");
});

test("MCP partial marked overrides reject accessors before JSON serialization and preserve ordinary inputs", async () => {
  const { applyMCPInput } = await import("../src/mcp-request-input.mjs");
  const request = {
      auth: auth({ accessToken: "original", clientSecret: "opaque" }),
    },
    before = structuredClone(request);
  let calls = 0;
  const accessor = () => ({
    enumerable: true,
    get() {
      calls++;
      return "laundered";
    },
  });
  const top = Object.defineProperty({}, "auth", accessor());
  const policy = {
    auth: Object.defineProperty({}, "postmanOAuth2", accessor()),
  };
  const token = {
    auth: {
      postmanOAuth2: Object.defineProperty({}, "accessToken", accessor()),
    },
  };
  const secret = {
    auth: {
      postmanOAuth2: Object.defineProperty({}, "clientSecret", accessor()),
    },
  };
  for (const patch of [
    top,
    policy,
    token,
    secret,
    Object.create({ auth: { postmanOAuth2: { accessToken: "inherited" } } }),
    { auth: Object.create({ postmanOAuth2: { accessToken: "inherited" } }) },
    { auth: { postmanOAuth2: Object.create({ accessToken: "inherited" }) } },
    { auth: { postmanOAuth2: { unknown: "no" } } },
    { auth: { postmanOAuth2: { version: 2 } } },
    { auth: { postmanOAuth2: { version: undefined } } },
  ])
    assert.throws(() => applyMCPInput(request, patch), /Postman OAuth2/);
  assert.equal(calls, 0);
  const partial = {
      auth: {
        postmanOAuth2: {
          accessToken: "temporary",
          clientSecret: "{{stillInert}}",
        },
      },
    },
    partialBefore = structuredClone(partial);
  assert.deepEqual(
    applyMCPInput(request, partial).auth,
    auth({ accessToken: "temporary", clientSecret: "{{stillInert}}" }),
  );
  assert.deepEqual(request, before);
  assert.deepEqual(partial, partialBefore);
  assert.throws(
    () =>
      applyMCPInput(
        { auth: auth({ accessToken: "original" }) },
        { auth: { postmanOAuth2: { clientId: "new" } } },
      ),
    /未定义/,
  );
  const ordinary = { auth: { type: "bearer", token: "ordinary" } };
  assert.deepEqual(
    applyMCPInput(ordinary, { auth: { token: "temporary" } }).auth,
    { type: "bearer", token: "temporary" },
  );
  for (const patch of [
    policy,
    token,
    { auth: { postmanOAuth2: { accessToken: "no" } } },
  ])
    assert.throws(() => applyMCPInput(ordinary, patch), /Postman OAuth2/);
  assert.equal(calls, 0);
  assert.equal(ordinary.auth.token, "ordinary");
});
