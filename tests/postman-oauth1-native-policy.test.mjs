// Definition composition only: no signing, server, storage or original runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { importPostmanOAuth1 } from "../src/postman-oauth1-import.mjs";
import {
  importApipostOAuth1,
  exportApipostOAuth1,
} from "../src/apipost-oauth1-auth.mjs";
import { applySharedAuth } from "../src/shared-auth.mjs";

const attributes = (method = "HMAC-SHA1", extra = {}) =>
  Object.entries({
    consumerKey: "fixture-consumer",
    consumerSecret: "fictional-consumer-secret",
    token: "token/+雪",
    tokenSecret: "fictional-token-secret",
    signatureMethod: method,
    privateKey: method === "RSA-SHA1" ? "opaque-fixture-key-not-parsed" : "",
    privateKeyPassphrase: "",
    nonce: "nonce",
    timestamp: "1700000000",
    realm: "realm",
    version: "1.0",
    callback: "",
    verifier: "",
    ...extra,
  }).map(([key, value]) => ({ key, value, type: typeof value }));

for (const method of ["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"])
  test(`Postman literal ${method} maps all sixteen switch combinations through native definition roundtrip`, () => {
    for (let mask = 0; mask < 16; mask++) {
      const switches = {
        addParamsToHeader: Boolean(mask & 1),
        includeBodyHash: Boolean(mask & 2),
        addEmptyParamsToSign: Boolean(mask & 4),
        disableHeaderEncoding: Boolean(mask & 8),
      };
      const source = attributes(method, switches),
        before = structuredClone(source);
      const canonical = importPostmanOAuth1(source);
      const expected = {
        placement: switches.addParamsToHeader ? "header" : "auto",
        includeBodyHash: switches.includeBodyHash,
        includeEmptyParams: switches.addEmptyParamsToSign,
        headerEncoding: switches.disableHeaderEncoding ? "raw" : "percent",
      };
      assert.deepEqual(canonical.parameterPolicy, expected);
      const native = exportApipostOAuth1(canonical);
      assert.equal(native.oauth1.token, "token/+雪");
      assert.equal(Object.hasOwn(native.oauth1, "accessToken"), false);
      for (const [key, value] of Object.entries(switches))
        assert.equal(native.oauth1[key], value);
      assert.deepEqual(importApipostOAuth1(native.oauth1), canonical);
      assert.deepEqual(source, before);
    }
  });

test("Postman omitted switches remain auto/false/false/percent through the stricter native converter", () => {
  const canonical = importPostmanOAuth1(attributes());
  assert.deepEqual(canonical.parameterPolicy, {
    placement: "auto",
    includeBodyHash: false,
    includeEmptyParams: false,
    headerEncoding: "percent",
  });
  const native = exportApipostOAuth1(canonical);
  for (const field of [
    "addParamsToHeader",
    "includeBodyHash",
    "addEmptyParamsToSign",
    "disableHeaderEncoding",
  ])
    assert.equal(native.oauth1[field], false);
  assert.deepEqual(importApipostOAuth1(native.oauth1), canonical);
});

for (const [field, value] of [
  ["privateKeyPassphrase", "FICTIONAL_PRIVATE_PASSPHRASE"],
  ["version", "FICTIONAL_VERSION_2"],
])
  test(`accepted Postman ${field} does not weaken native export refusal or disclose values`, () => {
    const canonical = importPostmanOAuth1(
      attributes("HMAC-SHA1", { [field]: value }),
    );
    assert.equal(canonical[field], value);
    const before = structuredClone(canonical);
    assert.throws(
      () => exportApipostOAuth1(canonical),
      (error) => {
        assert.match(error.message, /无法安全规范映射/);
        assert.equal(error.message.includes(value), false);
        return true;
      },
    );
    assert.deepEqual(canonical, before);
  });

test("imported policy remains independent of shared credentials while explicit noauth stays noauth", () => {
  const canonical = importPostmanOAuth1(attributes());
  const project = {
    settings: {
      globalAuth: { type: "bearer", token: "FICTIONAL_GLOBAL_TOKEN" },
      folderAuth: {
        Folder: {
          type: "basic",
          username: "fixture",
          password: "FICTIONAL_FOLDER_SECRET",
        },
      },
    },
  };
  const signed = { folder: "Folder", auth: canonical },
    none = { folder: "Folder", auth: { type: "none" }, inheritAuth: false };
  const before = structuredClone({ project, signed, none });
  assert.deepEqual(applySharedAuth(project, signed).auth, canonical);
  assert.deepEqual(applySharedAuth(project, none).auth, { type: "none" });
  assert.deepEqual({ project, signed, none }, before);
});
