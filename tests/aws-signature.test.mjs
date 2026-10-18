import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { awsSignatureHeaders } from "../src/aws-signature.mjs";
import { executeRequest } from "../src/runtime.mjs";
const auth = {
  accessKey: "foo",
  secretKey: "bar",
  region: "us-bar-1",
  service: "foo",
  signingDate: "2000-01-01T00:00:00.000Z",
};
test("AWS signature matches the official Smithy fixed-date header vector", async () => {
  const headers = await awsSignatureHeaders(
    "https://foo.us-bar-1.amazonaws.com/",
    "POST",
    {},
    undefined,
    auth,
  );
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=foo/20000101/us-bar-1/foo/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=1e3b24fcfd7655c0c245d99ba7b6b5ca6174eab903ebfbda09ce457af062ad30",
  );
  const token = await awsSignatureHeaders(
    "https://foo.us-bar-1.amazonaws.com/",
    "POST",
    {},
    undefined,
    { ...auth, sessionToken: "baz" },
  );
  assert(
    token.authorization.endsWith(
      "Signature=4fd09a8cf3b28a62a9c6c424f03ababcd703528578bc6ec9184fc585f18c3fbb",
    ),
  );
  assert.equal(token["x-amz-security-token"], "baz");
});
test("AWS wrapper rejects implicit credentials and signs actual binary payload, duplicate query and percent paths", async () => {
  await assert.rejects(
    awsSignatureHeaders("https://example.test", "GET", {}, undefined, {}),
    /缺少/,
  );
  await assert.rejects(
    awsSignatureHeaders("https://example.test", "GET", {}, undefined, {
      ...auth,
      signingDate: "invalid",
    }),
    /时间/,
  );
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const signed = await awsSignatureHeaders(
    "https://foo.us-bar-1.amazonaws.com/foo%3Dbar?a=2&a=1",
    "POST",
    { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
    payload,
    auth,
  );
  assert.equal(
    signed["x-amz-content-sha256"],
    createHash("sha256").update(payload).digest("hex"),
  );
  const reversed = await awsSignatureHeaders(
    "https://foo.us-bar-1.amazonaws.com/foo%3Dbar?a=1&a=2",
    "POST",
    {},
    payload,
    auth,
  );
  assert.equal(signed.authorization, reversed.authorization);
});
test("real HTTP AWS signed request contains computed headers and no secret key", async (t) => {
  let captured;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { headers: req.headers, body: Buffer.concat(chunks) };
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await executeRequest({
    url: "http://127.0.0.1:" + server.address().port,
    method: "POST",
    bodyType: "json",
    body: '{"ok":true}',
    auth: { type: "aws", ...auth, secretKey: "fixture-secret-not-transmitted" },
  });
  assert.equal(result.status, 200);
  assert.match(captured.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(
    captured.headers["x-amz-content-sha256"],
    createHash("sha256").update(captured.body).digest("hex"),
  );
  assert(
    !captured.headers.authorization.includes("fixture-secret-not-transmitted"),
  );
});
test("Postman AWS import retains explicit credentials and cURL does not silently drop signing", async () => {
  const { importDocument, toCurl } = await import("../src/core.mjs");
  const [request] = importDocument({
    info: { name: "AWS fixture" },
    item: [
      {
        name: "aws",
        request: {
          method: "GET",
          url: "https://example.test",
          auth: {
            type: "awsv4",
            awsv4: Object.entries({
              ...auth,
              sessionToken: "fixture-session",
            }).map(([key, value]) => ({ key, value })),
          },
        },
      },
    ],
  });
  assert.equal(request.auth.type, "aws");
  assert.equal(request.auth.sessionToken, "fixture-session");
  assert.throws(() => toCurl(request), /AWS签名/);
});
