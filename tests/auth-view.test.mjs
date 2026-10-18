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
