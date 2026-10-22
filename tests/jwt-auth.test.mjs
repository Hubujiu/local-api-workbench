import test from "node:test";
import assert from "node:assert/strict";
import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  verify,
  constants,
} from "node:crypto";
import http from "node:http";
import { jwtAuthorization } from "../src/jwt-auth.mjs";
const secret = "fictional-test-secret-".repeat(4);
const base = {
  type: "jwt",
  algorithm: "HS256",
  secret,
  payload: '{"sub":"fixture","exp":4102444800}',
};
const decode = (value) =>
  JSON.parse(Buffer.from(value, "base64url").toString());

test("JWT HMAC variants preserve payload bytes and verify independently", async () => {
  for (const bits of [256, 384, 512]) {
    const result = await jwtAuthorization({
      ...base,
      algorithm: "HS" + bits,
      header: '{"kid":"fixture-key"}',
    });
    const [header, payload, signature] = result.token.split(".");
    assert.equal(Buffer.from(payload, "base64url").toString(), base.payload);
    assert.deepEqual(decode(header), {
      typ: "JWT",
      kid: "fixture-key",
      alg: "HS" + bits,
    });
    assert.equal(
      signature,
      createHmac("sha" + bits, secret)
        .update(header + "." + payload)
        .digest("base64url"),
    );
    assert.equal(result.value, "Bearer " + result.token);
  }
  const encoded = await jwtAuthorization({
    ...base,
    secret: Buffer.from(secret).toString("base64"),
    isSecretBase64Encoded: "true",
  });
  assert.equal(encoded.token, (await jwtAuthorization(base)).token);
});

test("JWT RSA, PSS and ECDSA variants verify with independent Node crypto", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const family of ["RS", "PS", "ES"])
    for (const bits of [256, 384, 512]) {
      const pair =
        family === "ES"
          ? generateKeyPairSync("ec", {
              namedCurve: {
                256: "prime256v1",
                384: "secp384r1",
                512: "secp521r1",
              }[bits],
            })
          : rsa;
      const key = pair.privateKey.export({ type: "pkcs8", format: "pem" });
      const result = await jwtAuthorization({
        ...base,
        algorithm: family + bits,
        secret: key,
      });
      const [header, payload, signature] = result.token.split(".");
      assert.equal(
        verify(
          "sha" + bits,
          Buffer.from(header + "." + payload),
          {
            key: pair.publicKey,
            ...(family === "PS"
              ? {
                  padding: constants.RSA_PKCS1_PSS_PADDING,
                  saltLength: bits / 8,
                }
              : {}),
            ...(family === "ES" ? { dsaEncoding: "ieee-p1363" } : {}),
          },
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
    }
  const encrypted = rsa.privateKey.export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: "fixture-passphrase",
  });
  await assert.rejects(
    jwtAuthorization({ ...base, algorithm: "RS256", secret: encrypted }),
    /PEM/,
  );
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
  await assert.rejects(
    jwtAuthorization({
      ...base,
      algorithm: "RS256",
      secret: weak.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    /2048/,
  );
  const wrongCurve = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await assert.rejects(
    jwtAuthorization({
      ...base,
      algorithm: "ES384",
      secret: wrongCurve.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    /曲线/,
  );
  await assert.rejects(
    jwtAuthorization({
      ...base,
      algorithm: "HS256",
      secret: createPublicKey(rsa.privateKey).export({
        type: "spki",
        format: "pem",
      }),
    }),
  );
});

test("JWT rejects unsafe or unsupported algorithms, keys, headers and input shapes", async () => {
  for (const patch of [
    { algorithm: "none" },
    { algorithm: "HS1" },
    { secret: "short" },
    { secret: "!!!", isSecretBase64Encoded: true },
    { isSecretBase64Encoded: "yes" },
    { payload: "[]" },
    { payload: "null" },
    { payload: "{" },
    { header: '{"alg":"none"}' },
    { header: '{"b64":false}' },
    { header: '{"crit":["x"]}' },
    { header: '{"jku":"https://untrusted.example/keys"}' },
    { headerPrefix: "Bearer\r\nX: 1" },
    { addTokenTo: "elsewhere" },
    { addTokenTo: "queryParam", queryParamKey: "" },
    { algorithm: "RS256", secret: "/tmp/key.pem" },
    { payload: JSON.stringify({ data: "界".repeat(3000) }) },
  ])
    await assert.rejects(
      jwtAuthorization({ ...base, ...patch }),
      undefined,
      JSON.stringify(patch),
    );
});

test("JWT explicit query destination replaces same-name parameters and rejects invalid config before HTTP", async (t) => {
  const { executeRequest } = await import("../src/runtime.mjs");
  const { toCurl } = await import("../src/core.mjs");
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const url = new URL(req.url, "http://fixture");
    const token =
      req.headers.authorization?.slice(7) || url.searchParams.get("signed");
    assert.equal(decode(token.split(".")[1]).sub, "fixture");
    if (url.pathname === "/query")
      assert.equal(url.searchParams.getAll("signed").length, 1);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal((await executeRequest({ url, auth: base })).status, 200);
  assert.equal(
    (
      await executeRequest({
        url: url + "/query?signed=old&signed=other",
        auth: { ...base, addTokenTo: "queryParam", queryParamKey: "signed" },
      })
    ).status,
    200,
  );
  await assert.rejects(
    executeRequest({ url, auth: { ...base, algorithm: "none" } }),
  );
  assert.equal(requests, 2);
  assert.throws(() => toCurl({ url, auth: base }), /JWT/);
});

test("JWT import preserves explicit fields and refuses unknown dependencies", async () => {
  const { importJwtConfig } = await import("../public/jwt-auth-model.js");
  const { importDocument } = await import("../src/core.mjs");
  const fields = {
    algorithm: "PS256",
    secret: "{{fixtureKey}}",
    payload: '{"sub":"fixture"}',
    addTokenTo: "queryParam",
    queryParamKey: "signed",
    header: '{"kid":"fixture"}',
    isSecretBase64Encoded: false,
  };
  assert.deepEqual(importJwtConfig(fields), { ...fields, type: "jwt" });
  assert.throws(
    () =>
      importJwtConfig({ ...fields, remoteKeyURL: "https://untrusted.example" }),
    /不支持字段/,
  );
  const requests = importDocument({
    info: { name: "fixture" },
    item: [
      {
        name: "JWT",
        request: {
          method: "GET",
          url: "https://fixture.invalid",
          auth: {
            type: "jwt",
            jwt: Object.entries(fields).map(([key, value]) => ({ key, value })),
          },
        },
      },
    ],
  });
  assert.deepEqual(requests[0].auth, { ...fields, type: "jwt" });
});

test("JWT OpenAPI export describes security without exporting signing secrets", async () => {
  const { exportOpenAPI, normalizeRequest } = await import("../src/core.mjs");
  const project = {
    name: "JWT fixture",
    requests: [
      normalizeRequest({ url: "https://fixture.invalid/header", auth: base }),
      normalizeRequest({
        url: "https://fixture.invalid/query",
        auth: { ...base, addTokenTo: "queryParam", queryParamKey: "signed" },
      }),
    ],
  };
  const doc = exportOpenAPI(project);
  assert.equal(JSON.stringify(doc).includes(secret), false);
  for (const path of ["/header", "/query"]) {
    const key = Object.keys(doc.paths[path].get.security[0])[0];
    const scheme = doc.components.securitySchemes[key];
    if (path === "/header") assert.equal(scheme.bearerFormat, "JWT");
    else
      assert.deepEqual(
        { in: scheme.in, name: scheme.name },
        { in: "query", name: "signed" },
      );
  }
  assert.equal(project.openapiComponents, undefined);
});

test("modern Apipost JWT import preserves signing configuration without executing it", async () => {
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { importIntoProject } = await import("../src/core.mjs");
  const document = modernApipostFixture();
  const api = document.apis.find((node) => node.target_type === "api");
  api.request.auth = {
    type: "jwt",
    jwt: {
      algorithm: "HS256",
      secret: "{{JWT_SECRET}}",
      payload: '{"sub":"fixture"}',
      addTokenTo: "header",
    },
  };
  const project = {
    requests: [],
    folders: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: { statuses: [] },
  };
  importIntoProject(project, document);
  assert.equal(project.requests[0].auth.type, "jwt");
  assert.equal(project.requests[0].auth.secret, "{{JWT_SECRET}}");
});
