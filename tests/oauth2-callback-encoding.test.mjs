import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oauth2-encoding-"));
  const seen = [];
  const provider = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, body, fields: new URLSearchParams(body) });
    res.setHeader("content-type", "application/json");
    res.end(
      '{"access_token":"fictional-encoding-token","token_type":"Bearer"}',
    );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerURL = `http://127.0.0.1:${provider.address().port}`;
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const owner = async (route, data) => {
    const response = await fetch(app.url + route, {
      method: data ? "POST" : "GET",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  const start = async () => {
    const result = await owner("/api/oauth/start", {
      authorizationEndpoint: providerURL + "/authorize",
      tokenEndpoint: providerURL + "/token",
      clientId: "fictional-client",
      clientSecret: "fictional-secret",
    });
    assert.equal(result.status, 200);
    const authorization = new URL(result.data.authorizationUrl);
    return {
      ...result.data,
      authorization,
      state: authorization.searchParams.get("state"),
    };
  };
  // Preserve raw malformed percent sequences in the HTTP request target.
  const callback = (query) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        app.url,
        { path: "/oauth/callback?" + query },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
  return { app, owner, start, callback, seen };
}

test("OAuth2 raw malformed callback encoding rejects before credential POST or state claim", async (t) => {
  const f = await fixture(t);
  const project = await f.app.store.create("Unchanged encoding evidence");
  const before = await f.app.store.get(project.id);
  const flow = await f.start();
  const malformed = ["%FF", "%C0%AF", "%E0%A4", "%ED%A0%80", "%", "%0", "%GG"];
  for (const raw of malformed) {
    for (const field of ["code", "state", "error", "error_description"]) {
      const query =
        field === "state"
          ? `state=${raw}&code=valid`
          : `state=${flow.state}&${field}=${raw}`;
      const result = await f.callback(query);
      if (result.status !== 400 || f.seen.length)
        t.diagnostic(
          JSON.stringify({
            rawQuery: query,
            status: result.status,
            providerBodies: f.seen.map((item) => item.body),
          }),
        );
      assert.equal(result.status, 400, field + "=" + raw);
      assert.equal(
        f.seen.length,
        0,
        "malformed encoding must not exchange a repaired credential",
      );
      const state = await f.owner("/api/oauth/status/" + flow.id);
      assert.equal(
        state.data.status,
        "pending",
        "parsing must precede one-time claim",
      );
      assert.equal(state.data.result, undefined);
      assert.equal(f.app.oauthAllowed(flow.authorizationUrl), true);
    }
  }
  // Malformed field names and irrelevant fields must not silently repair raw form data either.
  for (const suffix of ["&co%FFde=x", "&extension=%FF"])
    assert.equal(
      (await f.callback(`state=${flow.state}&code=valid${suffix}`)).status,
      400,
    );
  assert.equal(f.seen.length, 0);
  assert.deepEqual(await f.app.store.get(project.id), before);
  assert.equal(
    (await f.callback(`state=${flow.state}&code=valid`)).status,
    200,
  );
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].fields.get("code"), "valid");
  assert.equal(
    (await f.callback(`state=${flow.state}&code=valid`)).status,
    400,
  );
  assert.equal(f.seen.length, 1);
  assert.deepEqual(await f.app.store.get(project.id), before);
});

test("OAuth2 valid UTF8 including replacement character and form escapes retain exact credentials and PKCE", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["%EF%BF%BD", "\uFFFD"],
    ["%E4%B8%AD%F0%9F%8C%8D", "中🌍"],
    ["%25FF", "%FF"],
    ["a%2Bb+c%20d", "a+b c d"],
    ["%26%3D%3F%23", "&=?#"],
  ];
  for (const [raw, expected] of cases) {
    const flow = await f.start();
    const result = await f.callback(
      `state=${flow.state}&code=${raw}&extension=valid%2Btext`,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.includes("fictional-encoding-token"), false);
    const request = f.seen.at(-1);
    assert.equal(request.method, "POST");
    assert.equal(request.fields.get("code"), expected);
    assert.equal(request.fields.get("grant_type"), "authorization_code");
    assert.equal(request.fields.get("redirect_uri"), flow.redirectUri);
    assert.equal(
      createHash("sha256")
        .update(request.fields.get("code_verifier"))
        .digest("base64url"),
      flow.authorization.searchParams.get("code_challenge"),
    );
    assert.equal(
      (await f.owner("/api/oauth/status/" + flow.id)).data.result.accessToken,
      "fictional-encoding-token",
    );
    assert.equal(
      (await f.callback(`state=${flow.state}&code=${raw}`)).status,
      400,
    );
  }
  assert.equal(f.seen.length, cases.length);
});

test("OAuth2 duplicate parse errors leave pending state while validly encoded semantic errors consume it", async (t) => {
  const f = await fixture(t);
  const flow = await f.start();
  for (const query of [
    `state=${flow.state}&code=one&%63ode=two`,
    `state=${flow.state}&%73tate=${flow.state}&code=one`,
    `state=${flow.state}&error=x&error=y`,
    `state=${flow.state}&error_description=x&error_description=y`,
  ]) {
    assert.equal((await f.callback(query)).status, 400);
    assert.equal(
      (await f.owner("/api/oauth/status/" + flow.id)).data.status,
      "pending",
    );
  }
  for (const suffix of [
    "code=%00",
    "error=access_denied&error_description=fictional%20secret",
    "code=",
  ]) {
    const target = await f.start();
    const result = await f.callback(`state=${target.state}&${suffix}`);
    assert.equal(result.status, 400);
    assert.equal(result.body.includes("fictional secret"), false);
    assert.equal(
      (await f.owner("/api/oauth/status/" + target.id)).data.status,
      "error",
    );
    assert.equal(
      (await f.callback(`state=${target.state}&code=later`)).status,
      400,
    );
  }
  assert.equal(f.seen.length, 0);
  assert.equal(
    (await f.callback(`state=${flow.state}&code=usable`)).status,
    200,
  );
  assert.equal(f.seen.length, 1);
});
