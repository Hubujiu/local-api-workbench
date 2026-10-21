import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OAuth1Manager } from "../src/oauth1-flow.mjs";
test("OAuth1 OOB exchange keeps temporary secrets server-side and consumes verifier flow once", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/x-www-form-urlencoded");
    res.end(
      req.url === "/request"
        ? "oauth_token=temp&oauth_token_secret=temp-secret&oauth_callback_confirmed=true"
        : "oauth_token=access&oauth_token_secret=access-secret",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    manager = new OAuth1Manager();
  t.after(() => manager.close());
  const flow = await manager.start({
    requestTokenEndpoint: base + "/request",
    authorizationEndpoint: base + "/authorize",
    tokenEndpoint: base + "/access",
    consumerKey: "client",
    consumerSecret: "secret",
  });
  assert.equal(
    new URL(flow.authorizationUrl).searchParams.get("oauth_token"),
    "temp",
  );
  assert.equal(JSON.stringify(flow).includes("temp-secret"), false);
  assert(manager.allowed(flow.authorizationUrl));
  assert.match(seen[0].auth, /oauth_callback="oob"/);
  const result = await manager.complete({ id: flow.id, verifier: "1234" });
  assert.deepEqual(result, {
    accessToken: "access",
    tokenSecret: "access-secret",
  });
  assert.match(seen[1].auth, /oauth_token="temp"/);
  assert.match(seen[1].auth, /oauth_verifier="1234"/);
  assert.equal(manager.allowed(flow.authorizationUrl), false);
  await assert.rejects(
    manager.complete({ id: flow.id, verifier: "1234" }),
    /过期|已使用/,
  );
  assert(seen.every((x) => !x.url.includes("secret")));
  const encode = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  for (const [i, item] of seen.entries()) {
    const params = Object.fromEntries(
      [...item.auth.matchAll(/(oauth_\w+)="([^"]*)"/g)].map(
        ([, key, value]) => [key, decodeURIComponent(value)],
      ),
    );
    const signature = params.oauth_signature;
    delete params.oauth_signature;
    const normalized = Object.entries(params)
      .map(([k, v]) => [encode(k), encode(v)])
      .sort(([ak, av], [bk, bv]) =>
        ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
      )
      .map(([k, v]) => k + "=" + v)
      .join("&");
    const data = ["POST", base + item.url, normalized].map(encode).join("&");
    assert.equal(
      signature,
      createHmac("sha1", "secret&" + (i ? "temp-secret" : ""))
        .update(data)
        .digest("base64"),
    );
  }
});
test("OAuth1 rejects insecure endpoints and unconfirmed or duplicate token responses", async (t) => {
  const manager = new OAuth1Manager();
  t.after(() => manager.close());
  await assert.rejects(
    manager.start({
      requestTokenEndpoint: "http://example.test/request",
      authorizationEndpoint: "https://example.test/auth",
      tokenEndpoint: "https://example.test/token",
      consumerKey: "key",
    }),
    /HTTPS/,
  );
  let payload =
    "oauth_token=x&oauth_token_secret=s&oauth_callback_confirmed=false";
  const server = http.createServer((req, res) => res.end(payload));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = {
    requestTokenEndpoint: base,
    authorizationEndpoint: base,
    tokenEndpoint: base,
    consumerKey: "key",
  };
  await assert.rejects(manager.start(config), /确认/);
  payload =
    "oauth_token=x&oauth_token=x2&oauth_token_secret=s&oauth_callback_confirmed=true";
  await assert.rejects(manager.start(config), /重复/);
  assert.equal(manager.flows.size, 0);
});

test("expired and concurrently reused OAuth1 flow IDs cannot exchange a second token", async (t) => {
  let exchanges = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/x-www-form-urlencoded");
    if (req.url === "/request")
      res.end(
        "oauth_token=t&oauth_token_secret=s&oauth_callback_confirmed=true",
      );
    else {
      exchanges++;
      setTimeout(() => res.end("oauth_token=a&oauth_token_secret=b"), 20);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    m = new OAuth1Manager();
  t.after(() => m.close());
  const config = {
    consumerKey: "c",
    consumerSecret: "s",
    requestTokenEndpoint: base + "/request",
    authorizationEndpoint: base + "/auth",
    tokenEndpoint: base + "/access",
  };
  const expired = await m.start(config);
  m.flows.get(expired.id).expiresAt = 0;
  await assert.rejects(m.complete({ id: expired.id, verifier: "v" }), /过期/);
  const active = await m.start(config);
  await assert.rejects(m.complete({ id: active.id, verifier: "" }), /verifier/);
  const results = await Promise.allSettled([
    m.complete({ id: active.id, verifier: "v" }),
    m.complete({ id: active.id, verifier: "v" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(exchanges, 1);
  assert.equal(m.flows.size, 0);
});

import { createApp } from "../src/server.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("OAuth1 flow API requires local session and rejects cross-origin requests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oauth1-api-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  for (const endpoint of ["/api/oauth1/start", "/api/oauth1/complete"]) {
    let r = await fetch(app.url + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 403);
    r = await fetch(app.url + endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
        origin: "https://evil.example",
      },
      body: "{}",
    });
    assert.equal(r.status, 403);
  }
});
