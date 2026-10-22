import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { asapAuthorization } from "../src/asap-auth.mjs";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const base = {
  type: "asap",
  alg: "RS256",
  iss: "fixture-service",
  kid: "fixture-service/key-1",
  aud: "fixture-resource",
  privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
};
const decode = (token) =>
  token
    .split(".")
    .slice(0, 2)
    .map((part) => JSON.parse(Buffer.from(part, "base64url")));

test("ASAP generates bounded lifetime, fresh nonce and independently verifiable signature", async () => {
  const first = await asapAuthorization(
    { ...base, sub: "fixture-user", claims: '{"custom":true}' },
    1800000000,
  );
  const second = await asapAuthorization(base, 1800000000);
  const [header, payload] = decode(first.token);
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, base.kid);
  assert.deepEqual(
    {
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      iat: payload.iat,
      exp: payload.exp,
      custom: payload.custom,
    },
    {
      iss: base.iss,
      sub: "fixture-user",
      aud: base.aud,
      iat: 1800000000,
      exp: 1800000060,
      custom: true,
    },
  );
  assert.notEqual(payload.jti, decode(second.token)[1].jti);
  const parts = first.token.split(".");
  assert.equal(
    verify(
      "sha256",
      Buffer.from(parts[0] + "." + parts[1]),
      pair.publicKey,
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
  assert.equal(first.value, "Bearer " + first.token);
  assert.equal(first.in, "header");
});

test("ASAP validates asymmetric algorithms, issuer-owned key IDs, audience and reserved claims", async () => {
  for (const patch of [
    { alg: "HS256" },
    { alg: "none" },
    { iss: "" },
    { iss: "https://issuer.example" },
    { kid: "other/key" },
    { kid: "fixture-service/../key" },
    { kid: "fixture-service//key" },
    { aud: "" },
    { aud: "[]" },
    { ttlSeconds: 0 },
    { exp: "3600" },
    { ttlSeconds: 3601 },
    { ttlSeconds: "1.5" },
    { claims: '{"iss":"other"}' },
    { claims: '{"jti":"fixed"}' },
    { claims: '{"exp":9999999999}' },
    { claims: '{"nbf":1800000061}' },
    { claims: "[]" },
  ])
    await assert.rejects(asapAuthorization({ ...base, ...patch }, 1800000000));
  const boundary = decode(
    (
      await asapAuthorization(
        {
          ...base,
          ttlSeconds: "3600",
          aud: '["one","two"]',
          claims: '{"nbf":1800000001}',
        },
        1800000000,
      )
    ).token,
  )[1];
  assert.equal(boundary.exp - boundary.iat, 3600);
  assert.deepEqual(boundary.aud, ["one", "two"]);
});

test("ASAP request transport is always Bearer, never query, and each send gets a fresh nonce", async (t) => {
  const { executeRequest } = await import("../src/runtime.mjs");
  const seen = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/resource");
    assert.match(req.headers.authorization, /^Bearer /);
    const token = req.headers.authorization.slice(7),
      [header, payload] = decode(token),
      pieces = token.split(".");
    assert.equal(header.kid, base.kid);
    assert.equal(payload.aud, base.aud);
    assert.equal(
      verify(
        "sha256",
        Buffer.from(pieces[0] + "." + pieces[1]),
        pair.publicKey,
        Buffer.from(pieces[2], "base64url"),
      ),
      true,
    );
    seen.push(payload.jti);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = {
    url: "http://127.0.0.1:" + server.address().port + "/resource",
    auth: { ...base, addTokenTo: "queryParam", headerPrefix: "old-jwt-prefix" },
  };
  assert.equal((await executeRequest(request)).status, 200);
  assert.equal((await executeRequest(request)).status, 200);
  assert.equal(new Set(seen).size, 2);
});

test("ASAP export describes Bearer security without keys and unsupported imports fail closed", async () => {
  const { exportOpenAPI, normalizeRequest, toCurl, importDocument } =
    await import("../src/core.mjs");
  const request = normalizeRequest({
    url: "https://fixture.invalid/resource",
    auth: { ...base, addTokenTo: "queryParam", headerPrefix: "ignored" },
  });
  const doc = exportOpenAPI({ name: "ASAP fixture", requests: [request] });
  const name = Object.keys(doc.paths["/resource"].get.security[0])[0];
  assert.equal(doc.components.securitySchemes[name].scheme, "bearer");
  assert.equal(JSON.stringify(doc).includes("PRIVATE KEY"), false);
  assert.throws(() => toCurl(request), /ASAP/);
  assert.throws(
    () =>
      importDocument({
        info: { name: "fixture" },
        item: [
          {
            request: {
              url: "https://fixture.invalid",
              auth: { type: "asap", asap: [] },
            },
          },
        ],
      }),
    /尚不支持导入/,
  );
});
