import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPublicKey,
  createPrivateKey,
  verify,
  generateKeyPairSync,
} from "node:crypto";
import http from "node:http";
import { oauth1Authorization, oauthEncode } from "../src/oauth1.mjs";
import { executeRequest } from "../src/runtime.mjs";
const privateKey = readFileSync(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const publicKey = createPublicKey(privateKey);
const vector = JSON.parse(
  readFileSync(
    new URL("./fixtures/oauth1-rsa-vector.json", import.meta.url),
    "utf8",
  ),
);
const auth = {
  type: "oauth1",
  consumerKey: "fixture-consumer",
  accessToken: "fixture-token",
  nonce: "fixture-nonce",
  timestamp: "1700000000",
  signatureMethod: "RSA-SHA1",
  privateKey,
};
test("OAuth1 RSA matches an independently signed PKCS1v15 golden fixture", () => {
  const result = oauth1Authorization(
    "https://example.test/rsa?x=one",
    "GET",
    {},
    null,
    auth,
  );
  assert.equal(result.normalized, vector.normalized);
  assert.equal(result.baseString, vector.baseString);
  assert.equal(result.signature, vector.signature);
  assert(
    verify(
      "RSA-SHA1",
      Buffer.from(vector.baseString),
      publicKey,
      Buffer.from(result.signature, "base64"),
    ),
  );
  assert(!result.header.includes("PRIVATE"));
  const changedSecrets = oauth1Authorization(
    "https://example.test/rsa?x=one",
    "GET",
    {},
    null,
    { ...auth, consumerSecret: "ignored", tokenSecret: "ignored" },
  );
  assert.equal(changedSecrets.signature, vector.signature);
});
test("OAuth1 RSA requires inline RSA private keys and handles encrypted PEM without file reads", () => {
  const encrypted = createPrivateKey(privateKey).export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: "fixture-passphrase",
  });
  const result = oauth1Authorization(
    "https://example.test/rsa?x=one",
    "GET",
    {},
    null,
    {
      ...auth,
      privateKey: encrypted,
      privateKeyPassphrase: "fixture-passphrase",
    },
  );
  assert.equal(result.signature, vector.signature);
  assert.throws(
    () =>
      oauth1Authorization("https://example.test", "GET", {}, null, {
        ...auth,
        privateKey: encrypted,
        privateKeyPassphrase: "wrong",
      }),
    /RSA/,
  );
  for (const key of [
    "",
    "/tmp/never-read-private-key.pem",
    "malformed",
    privateKey.repeat(50),
  ])
    assert.throws(
      () =>
        oauth1Authorization("https://example.test", "GET", {}, null, {
          ...auth,
          privateKey: key,
        }),
      /RSA/,
    );
  const { privateKey: ec } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  assert.throws(
    () =>
      oauth1Authorization("https://example.test", "GET", {}, null, {
        ...auth,
        privateKey: ec.export({ type: "pkcs8", format: "pem" }),
      }),
    /RSA/,
  );
});
test("real HTTP OAuth1 RSA signature validates independently against received query and form", async (t) => {
  let captured;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      headers: req.headers,
      url: req.url,
      body: Buffer.concat(chunks).toString(),
    };
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const result = await executeRequest({
    url: base + "/rsa?x=one",
    method: "POST",
    bodyType: "urlencoded",
    form: [{ key: "x", value: "two" }],
    auth,
  });
  assert.equal(result.status, 200);
  const params = Object.fromEntries(
    [...captured.headers.authorization.matchAll(/(\w+)="([^"]*)"/g)].map(
      ([, k, v]) => [k, decodeURIComponent(v)],
    ),
  );
  assert.equal(params.oauth_signature_method, "RSA-SHA1");
  assert.equal(captured.body, "x=two");
  const normalized = vector.normalized + "&x=two";
  const expected = ["POST", base + "/rsa", normalized]
    .map(oauthEncode)
    .join("&");
  assert(
    verify(
      "RSA-SHA1",
      Buffer.from(expected),
      publicKey,
      Buffer.from(params.oauth_signature, "base64"),
    ),
  );
  assert(!JSON.stringify(captured).includes("PRIVATE KEY"));
});

test("Postman RSA import retains only explicit inline key material", async () => {
  const { importDocument, toCurl } = await import("../src/core.mjs");
  const [request] = importDocument({
    info: { name: "RSA fixture" },
    item: [
      {
        name: "rsa",
        request: {
          url: "https://example.test/rsa",
          method: "GET",
          auth: {
            type: "oauth1",
            oauth1: Object.entries({
              ...auth,
              privateKeyPassphrase: "fixture",
            }).map(([key, value]) => ({ key, value })),
          },
        },
      },
    ],
  });
  assert.equal(request.auth.privateKey, privateKey);
  assert.equal(request.auth.privateKeyPassphrase, "fixture");
  assert.equal(request.auth.signatureMethod, "RSA-SHA1");
  assert.throws(() => toCurl(request), /OAuth1/);
});
