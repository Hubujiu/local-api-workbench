import test from "node:test";
import assert from "node:assert/strict";
import { authPanel, authTypes } from "../public/auth-view.js";
test("authentication editor exposes each supported type and safely renders sensitive fields", () => {
  for (const type of authTypes) {
    const html = authPanel({
      type,
      consumerKey: '"><img src=x onerror=x>',
      secretKey: "secret",
    });
    assert(html.includes('id="auth-type"'));
    assert(html.includes("<option selected>" + type + "</option>"));
    assert(!html.includes("<img"));
  }
  assert.match(
    authPanel({ type: "aws" }),
    /data-auth="secretKey"[^>]*type="password"/,
  );
  assert.match(
    authPanel({ type: "oauth1" }),
    /data-auth="tokenSecret"[^>]*type="password"/,
  );
  assert(authPanel({ type: "oauth2" }).includes('id="oauth-get"'));
  const rsa = authPanel({
    type: "oauth1",
    signatureMethod: "RSA-SHA1",
    privateKey: "</textarea><script>",
  });
  assert(rsa.includes("<option selected>RSA-SHA1</option>"));
  assert(rsa.includes('textarea data-auth="privateKey"'));
  assert(!rsa.includes("<script>"));
  assert.match(rsa, /data-auth="privateKeyPassphrase"[^>]*type="password"/);
});

test("unsupported auth fails closed rather than sending an unauthenticated request", async () => {
  const { normalizeRequest } = await import("../src/core.mjs");
  assert.throws(
    () => normalizeRequest({ auth: { type: "unknown" } }),
    /不支持的认证/,
  );
  assert.equal(normalizeRequest({ auth: {} }).auth.type, "none");
  for (const type of authTypes)
    assert.equal(normalizeRequest({ auth: { type } }).auth.type, type);
});

test("JWT authentication controls cover algorithms, destinations and explicit secret storage warning", () => {
  const html = authPanel({
    type: "jwt",
    algorithm: "ES512",
    payload: '{"x":"<script>"}',
    secret: "<key>",
    isSecretBase64Encoded: true,
  });
  assert.match(html, /<option selected>ES512<\/option>/);
  assert.match(html, /data-auth="payload"/);
  assert.match(html, /仅接受未加密PEM/);
  assert.match(html, /value="Bearer"/);
  assert.match(html, /明文写入项目/);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<key>"), false);
  assert.match(
    authPanel({ type: "jwt" }, { shared: true }),
    /data-shared-auth="secret"/,
  );
});
