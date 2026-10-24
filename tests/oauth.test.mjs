import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OAuthManager, exchangeOAuthToken } from "../src/oauth.mjs";
test("OAuth PKCE validates state and exchanges the code once", async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = new URLSearchParams(body);
    res.setHeader("content-type", "application/json");
    res.end('{"access_token":"fixture-token","token_type":"Bearer"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    manager = new OAuthManager();
  const flow = manager.start(
    {
      authorizationEndpoint: base + "/authorize",
      tokenEndpoint: base + "/token",
      clientId: "fixture",
    },
    "http://127.0.0.1:4318",
  );
  const authorization = new URL(flow.authorizationUrl);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(
    manager.complete({ state: "wrong", code: "code" }),
    /state/,
  );
  const state = authorization.searchParams.get("state");
  await manager.complete({ state, code: "code" });
  assert.equal(manager.status(flow.id).result.accessToken, "fixture-token");
  assert.equal(received.get("grant_type"), "authorization_code");
  assert(received.get("code_verifier").length >= 43);
  await assert.rejects(manager.complete({ state, code: "code" }), /state/);
});
test("OAuth client-credentials uses a POST body, not URL secrets", async (t) => {
  let requestURL, fields;
  const server = http.createServer(async (req, res) => {
    requestURL = req.url;
    let text = "";
    for await (const chunk of req) text += chunk;
    fields = new URLSearchParams(text);
    res.end('{"access_token":"ok"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const token = await exchangeOAuthToken(
    {
      tokenEndpoint: `http://127.0.0.1:${server.address().port}/token`,
      clientId: "client",
      clientSecret: "fixture-only",
    },
    { grant_type: "client_credentials" },
  );
  assert.equal(token.accessToken, "ok");
  assert.equal(requestURL, "/token");
  assert.equal(fields.get("client_secret"), "fixture-only");
});
