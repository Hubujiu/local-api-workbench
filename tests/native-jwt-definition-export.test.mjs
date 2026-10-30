// Pure definition contract only. No signing, key parsing, HTTP, app or VM work.
import test from "node:test";
import assert from "node:assert/strict";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { importJwtConfig, jwtAlgorithms } from "../public/jwt-auth-model.js";

const fields = [
  "algorithm",
  "secret",
  "isSecretBase64Encoded",
  "payload",
  "headerPrefix",
  "queryParamKey",
  "header",
  "addTokenTo",
];
const algorithms = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];
const secret = "FICTIONAL_JWT_PRIVATE_MATERIAL_DO_NOT_ECHO";
const unknownKey = "FICTIONAL_UNKNOWN_PRIVATE_FIELD_DO_NOT_ECHO";
const payload =
  ' { "sub" : "雪", "n":1.00, "escaped":"\\u0061", "dup":1, "dup":2 }\n';
const header = ' { "typ" : "JWT", "kid" : "fictional-key" }\r\n';
const config = (algorithm = "HS256", addTokenTo = "header") => ({
  type: "jwt",
  algorithm,
  secret,
  isSecretBase64Encoded: false,
  payload,
  headerPrefix: "Bearer ",
  queryParamKey: "token",
  header,
  addTokenTo,
});
function roundtrip(auth) {
  const before = Object.getOwnPropertyDescriptors(auth),
    keys = Reflect.ownKeys(auth);
  const expected = Object.fromEntries(
    Object.entries(auth).filter(([key]) => key !== "type"),
  );
  const native = exportExtendedApipostAuth(auth);
  assert.deepEqual(native, { type: "jwt", jwt: expected });
  assert.deepEqual(importJwtConfig(native.jwt), { ...expected, type: "jwt" });
  assert.deepEqual(importJwtConfig(JSON.parse(JSON.stringify(native)).jwt), {
    ...expected,
    type: "jwt",
  });
  assert.deepEqual(Object.getOwnPropertyDescriptors(auth), before);
  assert.deepEqual(Reflect.ownKeys(auth), keys);
  assert.notEqual(native.jwt, auth);
  return native;
}
function rejected(auth, forbidden = [secret, unknownKey]) {
  const descriptors = Object.getOwnPropertyDescriptors(auth),
    keys = Reflect.ownKeys(auth);
  let thrown;
  assert.throws(
    () => exportExtendedApipostAuth(auth),
    (error) => {
      thrown = error;
      assert.ok(error instanceof Error);
      for (const text of forbidden) {
        assert.equal(String(error).includes(text), false);
        assert.equal(String(error.stack).includes(text), false);
        assert.equal(JSON.stringify(error).includes(text), false);
      }
      assert.equal(
        Object.hasOwn(error, "cause"),
        false,
        "do not attach an unsanitized validator error",
      );
      return true;
    },
  );
  assert.ok(thrown);
  assert.deepEqual(Object.getOwnPropertyDescriptors(auth), descriptors);
  assert.deepEqual(Reflect.ownKeys(auth), keys);
}

test("JWT definition algorithm domain remains the twelve existing algorithms", () => {
  assert.deepEqual(jwtAlgorithms, algorithms);
});
for (const algorithm of algorithms)
  for (const placement of ["header", "queryParam"])
    test(`JWT ${algorithm} ${placement} definition has exact eight-field native inverse`, () => {
      const auth = Object.freeze(config(algorithm, placement));
      const native = roundtrip(auth);
      assert.deepEqual(Object.keys(native.jwt), fields);
      assert.equal(
        native.jwt.secret,
        secret,
        "explicit native export intentionally retains configured signing material",
      );
      native.jwt.secret = "modified exported copy";
      assert.equal(auth.secret, secret);
    });

test("JWT omission remains omission, and omitted defaults never become explicit fields", () => {
  assert.deepEqual(roundtrip({ type: "jwt" }), { type: "jwt", jwt: {} });
  for (const field of fields) {
    const value =
      field === "isSecretBase64Encoded"
        ? false
        : field === "algorithm"
          ? "HS256"
          : field === "addTokenTo"
            ? "header"
            : "";
    const native = roundtrip({ type: "jwt", [field]: value });
    assert.deepEqual(Object.keys(native.jwt), [field]);
    for (const absent of fields.filter((name) => name !== field))
      assert.equal(Object.hasOwn(native.jwt, absent), false);
  }
});

test("every combination of own JWT fields preserves presence instead of filling defaults", () => {
  const complete = config();
  for (let mask = 0; mask < 256; mask++) {
    const auth = { type: "jwt" };
    fields.forEach((field, index) => {
      if (mask & (1 << index)) auth[field] = complete[field];
    });
    const native = roundtrip(auth);
    assert.equal(
      Object.keys(native.jwt).length,
      fields.filter((_, index) => mask & (1 << index)).length,
    );
  }
});

test("empty strings preserve the existing import definition domain", () => {
  const auth = {
    type: "jwt",
    ...Object.fromEntries(
      fields.filter((f) => f !== "isSecretBase64Encoded").map((f) => [f, ""]),
    ),
  };
  const native = roundtrip(auth);
  for (const field of fields.filter((f) => f !== "isSecretBase64Encoded"))
    assert.equal(native.jwt[field], "");
  assert.equal(Object.hasOwn(native.jwt, "isSecretBase64Encoded"), false);
});
for (const flag of [true, false, "true", "false"])
  test(`JWT Base64 marker ${typeof flag}:${flag} preserves type and exact value`, () => {
    const native = roundtrip({ ...config(), isSecretBase64Encoded: flag });
    assert.equal(native.jwt.isSecretBase64Encoded, flag);
    assert.equal(typeof native.jwt.isSecretBase64Encoded, typeof flag);
  });

for (const ending of ["\n", "\r\n"])
  test(`JWT PEM definition preserves ${ending === "\n" ? "LF" : "CRLF"} and original JSON text without key parsing`, () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "FICTIONAL-NOT-A-VALID-KEY",
      "-----END PRIVATE KEY-----",
      "",
    ].join(ending);
    const native = roundtrip({ ...config("RS256"), secret: pem });
    assert.equal(native.jwt.secret, pem);
    assert.deepEqual(Buffer.from(native.jwt.secret), Buffer.from(pem));
    assert.equal(native.jwt.payload, payload);
    assert.equal(native.jwt.header, header);
  });

test("secret payload and header templates are retained literally without evaluation", () => {
  const auth = {
    type: "jwt",
    algorithm: "HS512",
    secret: "{{privateSigningKey}}",
    payload: '{ "sub": "{{subject}}", "iat": {{$timestamp}} }',
    header: '{"kid":"{{keyId}}"}',
    headerPrefix: "{{prefix}} ",
    queryParamKey: "{{queryKey}}",
    addTokenTo: "queryParam",
    isSecretBase64Encoded: "false",
  };
  const native = roundtrip(auth);
  assert.deepEqual(native.jwt.secret, "{{privateSigningKey}}");
  assert.equal(native.jwt.payload, auth.payload);
});

test("definition export does not pretend to validate runtime signer material", () => {
  for (const auth of [
    { ...config(), secret: "weak", payload: "not JSON" },
    {
      ...config("RS256"),
      secret:
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nfictional\n-----END ENCRYPTED PRIVATE KEY-----\n",
    },
    {
      ...config("ES512"),
      secret: "mismatched-key-kind",
      header: '{"alg":"none","crit":["unknown"]}',
    },
    {
      ...config(),
      headerPrefix: "unsafe\r\nheader",
      payload: '{"exp":"not-a-number"}',
    },
  ])
    roundtrip(auth);
});

test("ordinary frozen own data fields remain valid, including null-prototype definitions", () => {
  const auth = Object.assign(Object.create(null), config());
  Object.freeze(auth);
  roundtrip(auth);
});

for (const field of fields)
  test(`known JWT field ${field} rejects own undefined instead of losing it in JSON`, () => {
    rejected({ ...config(), [field]: undefined });
  });

test("JWT malformed field types reject without leaking configuration values", () => {
  const invalid = [
    null,
    0,
    1,
    true,
    false,
    [],
    {},
    () => secret,
    Symbol(secret),
    1n,
  ];
  for (const field of fields.filter((key) => key !== "isSecretBase64Encoded"))
    for (const value of invalid) rejected({ ...config(), [field]: value });
  for (const value of [
    null,
    0,
    1,
    "",
    "TRUE",
    "FALSE",
    "1",
    "0",
    [],
    {},
    () => secret,
    Symbol(secret),
    1n,
  ])
    rejected({ ...config(), isSecretBase64Encoded: value });
  for (const algorithm of [
    "none",
    "hs256",
    "HS1024",
    "EdDSA",
    "{{algorithm}}",
    secret,
  ])
    rejected({ ...config(), algorithm });
  for (const addTokenTo of ["query", "Header", "body", "{{location}}", secret])
    rejected({ ...config(), addTokenTo });
});

test("unknown JWT fields reject every value, including undefined, without echoing arbitrary property names", () => {
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    secret,
    {},
    [],
    () => secret,
    Symbol(secret),
    1n,
  ])
    rejected({ ...config(), [unknownKey]: value });
  for (const key of [
    "privateKey",
    "remoteKeyURL",
    "jwk",
    "token",
    "passphrase",
    "toJSON",
    "__proto__",
    "constructor",
  ]) {
    const auth = config();
    Object.defineProperty(auth, key, {
      value: secret,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    rejected(auth, [secret, key]);
  }
});

test("hidden known/type/unknown fields and symbols reject without silently dropping data", () => {
  for (const field of ["type", ...fields, unknownKey]) {
    const auth = config();
    Object.defineProperty(auth, field, {
      value:
        field === "type"
          ? "jwt"
          : field === "isSecretBase64Encoded"
            ? false
            : secret,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    rejected(auth);
  }
  for (const enumerable of [true, false]) {
    const auth = config();
    Object.defineProperty(auth, Symbol(unknownKey), {
      value: secret,
      enumerable,
    });
    rejected(auth);
  }
});

test("descriptor preflight rejects type/known/unknown accessors without invoking any getter or setter", () => {
  for (const field of ["type", ...fields, unknownKey])
    for (const enumerable of [true, false]) {
      let reads = 0,
        writes = 0;
      const auth = config();
      Object.defineProperty(auth, field, {
        get() {
          reads++;
          throw Error(secret);
        },
        set() {
          writes++;
        },
        enumerable,
        configurable: true,
      });
      rejected(auth);
      assert.equal(reads, 0, field);
      assert.equal(writes, 0, field);
    }
  for (const field of ["type", "secret", unknownKey]) {
    let writes = 0;
    const auth = config();
    Object.defineProperty(auth, field, {
      set() {
        writes++;
      },
      enumerable: true,
      configurable: true,
    });
    rejected(auth);
    assert.equal(writes, 0);
  }
  let symbolReads = 0;
  const symbolAuth = config();
  Object.defineProperty(symbolAuth, Symbol.toStringTag, {
    get() {
      symbolReads++;
      throw Error(secret);
    },
    enumerable: true,
  });
  rejected(symbolAuth);
  assert.equal(symbolReads, 0);
  let called = 0;
  const auth = config();
  Object.defineProperty(auth, "toJSON", {
    get() {
      called++;
      throw Error(secret);
    },
    enumerable: true,
  });
  rejected(auth);
  assert.equal(called, 0);
});

test("nonplain definitions and inherited JWT tags reject instead of flattening prototypes", () => {
  class Definition {
    constructor() {
      Object.assign(this, config());
    }
  }
  for (const auth of [
    new Definition(),
    Object.assign([], config()),
    Object.assign(new Date(0), config()),
    Object.assign(new String("jwt"), config()),
    Object.assign(Object.create({ inherited: secret }), config()),
    Object.create({ type: "jwt", secret }),
  ])
    rejected(auth);
});

test("existing AWS Hawk and EdgeGrid native definition inverses remain unchanged", () => {
  const definitions = [
    {
      type: "aws",
      accessKey: "access",
      secretKey: "fictional-aws-secret",
      sessionToken: "session",
      region: "us-east-1",
      service: "s3",
      addAuthDataToQuery: true,
    },
    {
      type: "aws",
      accessKey: "access",
      secretKey: "fictional-aws-secret",
      sessionToken: "",
      region: "us-east-1",
      service: "execute-api",
      addAuthDataToQuery: false,
    },
    {
      type: "hawk",
      id: "id",
      key: "fictional-hawk-key",
      algorithm: "sha256",
      app: "",
      dlg: "",
      ext: "",
      nonce: "nonce",
      timestamp: "1700000000",
      payloadHash: "enabled",
    },
    {
      type: "hawk",
      id: "id",
      key: "fictional-hawk-key",
      algorithm: "sha1",
      app: "",
      dlg: "",
      ext: "",
      nonce: "nonce",
      timestamp: "1700000000",
      payloadHash: "disabled",
    },
    {
      type: "edgegrid",
      clientToken: "client",
      clientSecret: "fictional-edge-secret",
      accessToken: "access",
      baseURL: "https://example.invalid",
      headersToSign: "X-Proof",
      nonce: "nonce",
      timestamp: "20231025T12:00:00+0000",
    },
  ];
  for (const auth of definitions) {
    const before = structuredClone(auth);
    assert.deepEqual(
      importExtendedApipostAuth(exportExtendedApipostAuth(auth)),
      auth,
    );
    assert.deepEqual(auth, before);
  }
  const hawk = exportExtendedApipostAuth({
    type: "hawk",
    id: "id",
    key: "key",
  });
  assert.equal(hawk.hawk.algorithm, "sha256");
  assert.equal(hawk.hawk.includePayloadHash, true);
  for (const auth of [
    undefined,
    null,
    { type: "basic", username: "name", password: "secret" },
    { type: "bearer", token: "token" },
    { type: "apiKey", key: "x-key", value: "value" },
  ])
    assert.equal(exportExtendedApipostAuth(auth), undefined);
});
