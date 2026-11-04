import test from "node:test";
import assert from "node:assert/strict";
import {
  importApipostOAuth1,
  exportApipostOAuth1,
} from "../src/apipost-oauth1-auth.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
const secret = "PRIVATE_NATIVE_OAUTH1_SENTINEL";
const native = () => ({
  consumerKey: "key",
  consumerSecret: secret,
  token: "token",
  tokenSecret: "token-secret",
  signatureMethod: "HMAC-SHA1",
  realm: "realm",
  version: "1.0",
  nonce: "",
  timestamp: "",
  callback: "",
  verifier: "",
  privateKey: "opaque-key-text",
  addEmptyParamsToSign: true,
  includeBodyHash: true,
  addParamsToHeader: false,
  disableHeaderEncoding: false,
});
const flags = [
  "addEmptyParamsToSign",
  "includeBodyHash",
  "addParamsToHeader",
  "disableHeaderEncoding",
];
const strings = [
  "consumerKey",
  "consumerSecret",
  "token",
  "tokenSecret",
  "signatureMethod",
  "realm",
  "version",
  "nonce",
  "timestamp",
  "callback",
  "verifier",
  "privateKey",
];
const expected = (n) => ({
  type: "oauth1",
  consumerKey: n.consumerKey,
  consumerSecret: n.consumerSecret ?? "",
  accessToken: n.token ?? "",
  tokenSecret: n.tokenSecret ?? "",
  signatureMethod: n.signatureMethod,
  realm: n.realm ?? "",
  version: n.version ?? "",
  nonce: n.nonce ?? "",
  timestamp: n.timestamp ?? "",
  callback: n.callback ?? "",
  verifier: n.verifier ?? "",
  privateKey: n.privateKey ?? "",
  privateKeyPassphrase: "",
  parameterPolicy: {
    placement: n.addParamsToHeader ? "header" : "auto",
    includeBodyHash: n.includeBodyHash,
    includeEmptyParams: n.addEmptyParamsToSign,
    headerEncoding: n.disableHeaderEncoding ? "raw" : "percent",
  },
});
function rejected(fn) {
  assert.throws(fn, (error) => {
    assert(error instanceof Error);
    assert.match(
      error.message,
      /^原生OAuth1认证 (definition|consumerKey|signatureMethod|version|privateKeyPassphrase|parameterPolicy|size|addEmptyParamsToSign|includeBodyHash|addParamsToHeader|disableHeaderEncoding) 无法安全规范映射；请使用项目备份$/,
    );
    assert(!String(error).includes(secret));
    assert(!Object.hasOwn(error, "cause"));
    return true;
  });
}
test("native OAuth1 explicit four-switch and supported-method matrix roundtrips canonically without signing", () => {
  for (const signatureMethod of ["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"])
    for (const addEmptyParamsToSign of [false, true])
      for (const includeBodyHash of [false, true])
        for (const addParamsToHeader of [false, true])
          for (const disableHeaderEncoding of [false, true]) {
            const n = {
                ...native(),
                signatureMethod,
                addEmptyParamsToSign,
                includeBodyHash,
                addParamsToHeader,
                disableHeaderEncoding,
              },
              before = structuredClone(n),
              c = expected(n);
            assert.deepEqual(importApipostOAuth1(n), c);
            assert.deepEqual(exportApipostOAuth1(c), {
              type: "oauth1",
              oauth1: n,
            });
            assert.deepEqual(
              importApipostOAuth1(exportApipostOAuth1(c).oauth1),
              c,
            );
            assert.deepEqual(n, before);
          }
});
test("native OAuth1 never guesses omitted switches or coerces legacy/dynamic values", () => {
  for (const field of flags) {
    const omitted = native();
    delete omitted[field];
    rejected(() => importApipostOAuth1(omitted));
    for (const value of [
      undefined,
      null,
      0,
      1,
      "false",
      "true",
      "{{flag}}",
      [],
      {},
    ])
      rejected(() => importApipostOAuth1({ ...native(), [field]: value }));
  }
});
test("native OAuth1 string defaults, method/version controls and explicit export policy preserve intended meaning", () => {
  const sparse = {
    consumerKey: "key",
    signatureMethod: "HMAC-SHA1",
    addEmptyParamsToSign: false,
    includeBodyHash: false,
    addParamsToHeader: true,
    disableHeaderEncoding: false,
  };
  assert.deepEqual(importApipostOAuth1(sparse), expected(sparse));
  const c = expected(sparse);
  delete c.signatureMethod;
  assert.equal(exportApipostOAuth1(c).oauth1.signatureMethod, "HMAC-SHA1");
  c.signatureMethod = "";
  assert.equal(exportApipostOAuth1(c).oauth1.signatureMethod, "HMAC-SHA1");
  for (const signatureMethod of [
    undefined,
    "",
    "HMAC-SHA512",
    "RSA-SHA256",
    "PLAINTEXT",
    "{{method}}",
  ]) {
    const n = { ...native(), signatureMethod };
    if (signatureMethod === undefined) delete n.signatureMethod;
    rejected(() => importApipostOAuth1(n));
  }
  for (const version of ["2.0", "{{version}}", null])
    rejected(() => importApipostOAuth1({ ...native(), version }));
  const automatic = expected(native());
  delete automatic.parameterPolicy;
  rejected(() => exportApipostOAuth1(automatic));
  for (const privateKeyPassphrase of [secret, "{{passphrase}}", null])
    rejected(() =>
      exportApipostOAuth1({ ...expected(native()), privateKeyPassphrase }),
    );
});
test("native OAuth1 opaque credentials and templates are preserved without interpolation or key parsing", () => {
  const n = native();
  for (const field of strings.filter(
    (k) => !["signatureMethod", "version"].includes(k),
  ))
    n[field] = "{{" + field + "}}";
  assert.deepEqual(importApipostOAuth1(n), expected(n));
  assert.deepEqual(exportApipostOAuth1(expected(n)).oauth1, n);
  const rsa = {
    ...native(),
    signatureMethod: "RSA-SHA1",
    privateKey: "not a parsed key\n雪",
  };
  assert.deepEqual(exportApipostOAuth1(importApipostOAuth1(rsa)).oauth1, rsa);
});
test("native OAuth1 fields are strict data and unknown inactive aliases do not disappear", () => {
  for (const field of strings)
    for (const value of [undefined, null, 0, true, [], {}])
      rejected(() => importApipostOAuth1({ ...native(), [field]: value }));
  for (const extra of [
    { accessToken: "alias" },
    { privateKeyPassphrase: "" },
    { requestTokenEndpoint: "endpoint" },
    { [secret]: "" },
  ])
    rejected(() => importApipostOAuth1({ ...native(), ...extra }));
  for (const extra of [
    { token: "alias" },
    { addParamsToHeader: true },
    { unknown: secret },
  ])
    rejected(() => exportApipostOAuth1({ ...expected(native()), ...extra }));
  rejected(() => importApipostOAuth1({ ...native(), consumerKey: "" }));
  rejected(() =>
    importApipostOAuth1({ ...native(), consumerSecret: "\ud800" }),
  );
});
test("native OAuth1 descriptor admission never invokes getters or serialization hooks", () => {
  let reads = 0;
  for (const make of [native, () => expected(native())]) {
    const convert = make === native ? importApipostOAuth1 : exportApipostOAuth1;
    for (const key of Object.keys(make())) {
      const a = make();
      Object.defineProperty(a, key, {
        enumerable: true,
        get() {
          reads++;
          return secret;
        },
      });
      rejected(() => convert(a));
      const hidden = make();
      Object.defineProperty(hidden, key, {
        enumerable: false,
        value: hidden[key],
      });
      rejected(() => convert(hidden));
    }
    const inherited = Object.assign(Object.create({ extra: secret }), make());
    rejected(() => convert(inherited));
    const symbolic = make();
    symbolic[Symbol(secret)] = true;
    rejected(() => convert(symbolic));
    const hook = make();
    hook.toJSON = () => {
      reads++;
      return {};
    };
    rejected(() => convert(hook));
  }
  const nested = expected(native());
  Object.defineProperty(nested.parameterPolicy, "placement", {
    enumerable: true,
    get() {
      reads++;
      return "auto";
    },
  });
  rejected(() => exportApipostOAuth1(nested));
  assert.equal(reads, 0);
});
test("native OAuth1 source and canonical UTF-8 caps include defaults and remain inversely exportable", () => {
  const base = { ...native(), consumerSecret: "" },
    c = expected(base),
    available =
      65536 -
      Math.max(
        Buffer.byteLength(JSON.stringify(base)),
        Buffer.byteLength(JSON.stringify(c)),
      ),
    n = { ...base, consumerSecret: "x".repeat(available) };
  const parsed = importApipostOAuth1(n),
    out = exportApipostOAuth1(parsed);
  assert(Buffer.byteLength(JSON.stringify(parsed)) <= 65536);
  assert(Buffer.byteLength(JSON.stringify(out.oauth1)) <= 65536);
  rejected(() =>
    importApipostOAuth1({ ...n, consumerSecret: n.consumerSecret + "x" }),
  );
  const compact = {
    consumerKey: "key",
    consumerSecret: "",
    signatureMethod: "HMAC-SHA1",
    addEmptyParamsToSign: false,
    includeBodyHash: false,
    addParamsToHeader: false,
    disableHeaderEncoding: false,
  };
  compact.consumerSecret = "x".repeat(
    65536 - Buffer.byteLength(JSON.stringify(compact)),
  );
  assert.equal(Buffer.byteLength(JSON.stringify(compact)), 65536);
  rejected(() => importApipostOAuth1(compact));
  const unicode = {
    ...base,
    consumerSecret:
      "雪".repeat(Math.floor(available / 3)) + "x".repeat(available % 3),
  };
  assert.doesNotThrow(() => importApipostOAuth1(unicode));
  rejected(() =>
    importApipostOAuth1({
      ...unicode,
      consumerSecret: unicode.consumerSecret + "雪",
    }),
  );
});
test("native OAuth1 adapter hooks read only the selected data section", () => {
  let reads = 0;
  const envelope = { type: "oauth1", oauth1: native() };
  Object.defineProperty(envelope, "oauth2", {
    enumerable: true,
    get() {
      reads++;
      return { token: secret };
    },
  });
  assert.deepEqual(importExtendedApipostAuth(envelope), expected(native()));
  assert.deepEqual(exportExtendedApipostAuth(expected(native())), {
    type: "oauth1",
    oauth1: native(),
  });
  assert.equal(reads, 0);
  const bad = { type: "oauth1" };
  Object.defineProperty(bad, "oauth1", {
    enumerable: true,
    get() {
      reads++;
      return native();
    },
  });
  rejected(() => importExtendedApipostAuth(bad));
  assert.equal(reads, 0);
});
test("native OAuth1 accepts owned null-prototype data and sparse explicit-policy Workbench definitions", () => {
  const n = Object.assign(Object.create(null), native());
  assert.deepEqual(importApipostOAuth1(n), expected(native()));
  const c = Object.assign(Object.create(null), expected(native()));
  c.parameterPolicy = Object.assign(Object.create(null), c.parameterPolicy);
  assert.deepEqual(exportApipostOAuth1(c).oauth1, native());
  const minimal = {
      type: "oauth1",
      consumerKey: "key",
      parameterPolicy: {
        placement: "auto",
        includeBodyHash: false,
        includeEmptyParams: false,
        headerEncoding: "percent",
      },
    },
    out = exportApipostOAuth1(minimal);
  assert.equal(out.oauth1.signatureMethod, "HMAC-SHA1");
  assert.equal(Object.keys(out.oauth1).length, 16);
  assert.deepEqual(importApipostOAuth1(out.oauth1), expected(out.oauth1));
});
test("native OAuth1 export rejects malformed nested policy and excess canonical bytes without mutating frozen inputs", () => {
  const c = expected(native()),
    before = structuredClone(c);
  Object.freeze(c.parameterPolicy);
  Object.freeze(c);
  assert.deepEqual(exportApipostOAuth1(c).oauth1, native());
  assert.deepEqual(c, before);
  for (const parameterPolicy of [
    undefined,
    null,
    {},
    [],
    { ...c.parameterPolicy, placement: "{{mode}}" },
    { ...c.parameterPolicy, includeBodyHash: "false" },
    { ...c.parameterPolicy, extra: secret },
  ])
    rejected(() => exportApipostOAuth1({ ...c, parameterPolicy }));
  const base = { ...expected(native()), consumerSecret: "" },
    available =
      65536 -
      Math.max(
        Buffer.byteLength(JSON.stringify(base)),
        Buffer.byteLength(JSON.stringify(exportApipostOAuth1(base).oauth1)),
      ),
    at = { ...base, consumerSecret: "x".repeat(available) };
  assert.doesNotThrow(() => exportApipostOAuth1(at));
  rejected(() =>
    exportApipostOAuth1({ ...at, consumerSecret: at.consumerSecret + "x" }),
  );
});
