import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { oauth1Authorization, oauth1Request } from "../src/oauth1.mjs";
import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";
const base = {
  type: "oauth1",
  consumerKey: "fixture-key",
  consumerSecret: "fixture-secret",
  accessToken: "fixture-token",
  tokenSecret: "fixture-token-secret",
  nonce: "fixed-nonce",
  timestamp: "1700000000",
  version: "1.0",
  callback: "https://client.invalid/callback?a=雪",
  verifier: "verify+value",
  realm: "fixture realm",
};
const policy = (
  placement = "auto",
  includeBodyHash = true,
  includeEmptyParams = true,
  headerEncoding = "percent",
) => ({ placement, includeBodyHash, includeEmptyParams, headerEncoding });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
for (const signatureMethod of ["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"])
  test(`OAuth1 explicit policy ${signatureMethod} signs actual header, query and form bytes independently`, () => {
    const methods = [
      { method: "GET", bodyType: "none", body: undefined, media: undefined },
      {
        method: "POST",
        bodyType: "json",
        body: '{"x":"雪","n":1}',
        media: "application/json",
      },
      {
        method: "POST",
        bodyType: "urlencoded",
        body: "x=1&x=2&empty=&space=a+b",
        media: "application/x-www-form-urlencoded",
      },
      {
        method: "PUT",
        bodyType: "urlencoded",
        body: "x=%2B&x=%20",
        media: "application/x-www-form-urlencoded",
      },
      {
        method: "PATCH",
        bodyType: "urlencoded",
        body: "x=1",
        media: "application/x-www-form-urlencoded",
      },
      {
        method: "POST",
        bodyType: "binary",
        body: Buffer.from([0, 255, 1, 128]),
        media: "application/octet-stream",
      },
    ];
    for (const placement of ["header", "auto"])
      for (const request of methods) {
        const auth = {
          ...base,
          signatureMethod,
          parameterPolicy: policy(placement),
          ...(signatureMethod === "RSA-SHA1"
            ? {
                privateKey: rsa.privateKey.export({
                  type: "pkcs8",
                  format: "pem",
                }),
              }
            : {}),
        };
        const url =
            "https://example.invalid:8443/a%2Fb?x=2&x=1&space=a+b&empty=#not-signed",
          headers = {
            ...(request.media ? { "content-type": request.media } : {}),
            authorization: "obsolete",
          };
        const authBefore = structuredClone(auth),
          headersBefore = { ...headers },
          bytesBefore = Buffer.from(request.body ?? "");
        const result = oauth1Request(
          url,
          request.method,
          headers,
          request.body,
          auth,
          { bodyType: request.bodyType },
        );
        const checked = verifyOAuth1Policy({
          ...result,
          method: request.method,
          auth,
          bodyType: request.bodyType,
          publicKey: rsa.publicKey,
        });
        assert.deepEqual(checked.ordinaryQuery, [...new URL(url).searchParams]);
        if (request.bodyType === "urlencoded")
          assert.deepEqual(checked.ordinaryForm, [
            ...new URLSearchParams(request.body),
          ]);
        if (checked.placement !== "form")
          assert.deepEqual(Buffer.from(result.body ?? ""), bytesBefore);
        else
          assert.equal(
            Number(result.headers["content-length"]),
            Buffer.byteLength(result.body),
          );
        assert.deepEqual(auth, authBefore);
        assert.deepEqual(headers, headersBefore);
        assert.deepEqual(Buffer.from(request.body ?? ""), bytesBefore);
      }
  });
test("OAuth1 empty core parameters are visible in query/form, omitted when disabled, and ambiguous header empties reject", () => {
  for (const bodyType of ["none", "urlencoded"])
    for (const includeEmptyParams of [false, true]) {
      const auth = {
          ...base,
          accessToken: "",
          version: "",
          callback: "",
          verifier: "",
          parameterPolicy: policy("auto", true, includeEmptyParams),
        },
        method = bodyType === "urlencoded" ? "POST" : "GET",
        headers =
          bodyType === "urlencoded"
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {},
        body = bodyType === "urlencoded" ? "empty=&empty=" : undefined;
      const result = oauth1Request(
        "https://fixture.invalid/?empty=",
        method,
        headers,
        body,
        auth,
        { bodyType },
      );
      verifyOAuth1Policy({ ...result, method, auth, bodyType });
    }
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "GET",
        {},
        undefined,
        { ...base, accessToken: "", parameterPolicy: policy("header") },
        { bodyType: "none" },
      ),
    /空/,
  );
});
test("OAuth1 explicit raw header permits unambiguous ASCII only while encoded header preserves Unicode", () => {
  const raw = {
    ...base,
    callback: "callback",
    verifier: "a+b%20",
    parameterPolicy: policy("header", false, false, "raw"),
  };
  const result = oauth1Request(
    "https://fixture.invalid/",
    "GET",
    {},
    undefined,
    raw,
    { bodyType: "none" },
  );
  verifyOAuth1Policy({ ...result, method: "GET", auth: raw, bodyType: "none" });
  assert(result.headers.authorization.includes('oauth_verifier="a+b%20"'));
  for (const value of ['a"b', "a\\b", "a\nb", "雪", " edge", "edge "])
    assert.throws(
      () =>
        oauth1Request(
          "https://fixture.invalid/",
          "GET",
          {},
          undefined,
          { ...raw, verifier: value },
          { bodyType: "none" },
        ),
      /Header/,
    );
  const encoded = {
    ...base,
    verifier: "雪 +",
    parameterPolicy: policy("header", false, false),
  };
  const escaped = oauth1Request(
    "https://fixture.invalid/",
    "GET",
    {},
    undefined,
    encoded,
    { bodyType: "none" },
  );
  verifyOAuth1Policy({
    ...escaped,
    method: "GET",
    auth: encoded,
    bodyType: "none",
  });
});
test("OAuth1 policy keeps collision, body-mode, multipart, key and post-append size failures closed", () => {
  const auth = { ...base, parameterPolicy: policy() };
  for (const url of [
    "https://fixture.invalid/?oauth_token=x",
    "https://fixture.invalid/?oauth_signature=x",
  ])
    assert.throws(
      () =>
        oauth1Request(url, "GET", {}, undefined, auth, { bodyType: "none" }),
      /协议字段/,
    );
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "POST",
        { "content-type": "application/x-www-form-urlencoded" },
        "oauth_nonce=x",
        auth,
        { bodyType: "urlencoded" },
      ),
    /协议字段/,
  );
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "POST",
        { "content-type": "text/plain" },
        "x=1",
        auth,
        { bodyType: "urlencoded" },
      ),
    /Content-Type/,
  );
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "POST",
        { "content-type": "application/x-www-form-urlencoded" },
        "x=1",
        auth,
        { bodyType: "raw" },
      ),
    /Content-Type/,
  );
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "POST",
        { "content-type": "multipart/form-data; boundary=x" },
        "--x--",
        auth,
        { bodyType: "form-data" },
      ),
    /multipart/,
  );
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "GET",
        {},
        undefined,
        { ...auth, signatureMethod: "PLAINTEXT" },
        { bodyType: "none" },
      ),
    /仅支持/,
  );
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "GET",
        {},
        undefined,
        {
          ...auth,
          signatureMethod: "RSA-SHA1",
          privateKey: "/private/key.pem",
        },
        { bodyType: "none" },
      ),
    /内联PEM/,
  );
  const near = "x=" + "a".repeat(8 * 1024 * 1024 - 2);
  assert.throws(
    () =>
      oauth1Request(
        "https://fixture.invalid/",
        "POST",
        { "content-type": "application/x-www-form-urlencoded" },
        near,
        auth,
        { bodyType: "urlencoded" },
      ),
    /8 MiB/,
  );
});
test("OAuth1 legacy header and new absent-policy request outputs are identical, including Host and IPv6", () => {
  for (const url of [
    "https://example.invalid/a?x=1&x=2",
    "http://[::1]:8080/a?x=%2B",
  ]) {
    const headers = { host: "alternate.invalid:8443" },
      old = oauth1Authorization(url, "GET", headers, undefined, base),
      current = oauth1Request(url, "GET", headers, undefined, base, {
        bodyType: "none",
      });
    assert.equal(current.headers.authorization, old.header);
    assert.equal(current.baseString, old.baseString);
    assert.equal(current.normalized, old.normalized);
    assert.equal(current.url, new URL(url).href);
    assert.equal(current.body, undefined);
    verifyOAuth1Policy({
      ...current,
      method: "GET",
      auth: base,
      bodyType: "none",
    });
  }
});
test("OAuth1 generated nonce remains cryptographic and each execution signs independently", () => {
  const auth = { ...base, nonce: "", timestamp: "", parameterPolicy: policy() },
    seen = new Set();
  for (let i = 0; i < 8; i++) {
    const result = oauth1Request(
      "https://fixture.invalid/",
      "GET",
      {},
      undefined,
      auth,
      { bodyType: "none" },
    );
    const checked = verifyOAuth1Policy({
      ...result,
      method: "GET",
      auth,
      bodyType: "none",
    });
    assert(!seen.has(checked.protocol.oauth_nonce));
    seen.add(checked.protocol.oauth_nonce);
  }
  assert.equal(auth.nonce, "");
  assert.equal(auth.timestamp, "");
});
test("OAuth1 independent verifier rejects altered payloads, missing fields and unparsed header material", () => {
  const auth = { ...base, parameterPolicy: policy("header") },
    body = '{"correct":true}',
    original = oauth1Request(
      "https://fixture.invalid/",
      "POST",
      { "content-type": "application/json" },
      body,
      auth,
      { bodyType: "json" },
    );
  const check = (result) =>
    verifyOAuth1Policy({ ...result, method: "POST", auth, bodyType: "json" });
  check(original);
  assert.throws(() => check({ ...original, body: '{"correct":false}' }));
  assert.throws(() =>
    check({
      ...original,
      headers: {
        ...original.headers,
        authorization: original.headers.authorization + ", ignored",
      },
    }),
  );
  assert.throws(() =>
    check({
      ...original,
      headers: {
        ...original.headers,
        authorization:
          original.headers.authorization + ', oauth_unknown="extra"',
      },
    }),
  );
  assert.throws(() =>
    check({
      ...original,
      headers: {
        ...original.headers,
        authorization: original.headers.authorization.replace(
          /oauth_signature="[^"]*"/,
          'oauth_signature="wrong"',
        ),
      },
    }),
  );
  assert.throws(() =>
    check({
      ...original,
      headers: {
        ...original.headers,
        authorization: original.headers.authorization.replace(
          /oauth_nonce="[^"]*", /,
          "",
        ),
      },
    }),
  );
});
