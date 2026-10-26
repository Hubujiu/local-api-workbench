import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { once, getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OAuthManager, exchangeOAuthToken } from "../src/oauth.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";

const clientId = " fictional:client +%中&=~!*()' ";
const clientSecret = " fictional:secret +%文&=~!*()' ";
const grant = { grant_type: "client_credentials" };
const formEncode = (value) =>
  encodeURIComponent(value)
    .replace(
      /[!'()~]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replace(/%20/g, "+");
async function within(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("fixture operation did not settle")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function provider(t, handler) {
  const errors = [],
    sockets = new Set(),
    seen = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = { req, res, body, fields: new URLSearchParams(body) };
      seen.push(request);
      await handler(request);
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("fixture failure");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}
async function appFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oauth-lifecycle-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, data, method = data ? "POST" : "GET") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  return { app, call };
}
function start(manager, base, config = {}) {
  const flow = manager.start(
    {
      authorizationEndpoint: base + "/authorize",
      tokenEndpoint: base + "/token",
      clientId,
      clientSecret,
      ...config,
    },
    "http://127.0.0.1:4318",
  );
  return {
    ...flow,
    state: new URL(flow.authorizationUrl).searchParams.get("state"),
  };
}
async function heldProvider(t) {
  const arrived = Promise.withResolvers();
  const p = await provider(t, (request) => arrived.resolve(request));
  return { ...p, arrived: arrived.promise };
}

test("owner OAuth2 grants use one credential mode, retain PKCE, and never mutate projects", async (t) => {
  const authorizations = new Map();
  const p = await provider(t, ({ req, res, fields }) => {
    const [mode, operation] = req.url.slice(1).split("/");
    assert.equal(req.method, operation === "resource" ? "GET" : "POST");
    if (operation === "resource") {
      assert.equal(req.headers.authorization, "Bearer fixture-access-" + mode);
      res.end("authorized");
      return;
    }
    assert.equal(req.url, "/" + mode + "/token");
    assert.match(
      req.headers["content-type"],
      /^application\/x-www-form-urlencoded/,
    );
    if (mode === "basic") {
      assert.equal(
        req.headers.authorization,
        "Basic " +
          Buffer.from(
            formEncode(clientId) + ":" + formEncode(clientSecret),
          ).toString("base64"),
      );
      assert.equal(fields.has("client_id"), false);
      assert.equal(fields.has("client_secret"), false);
    } else {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(fields.get("client_id"), clientId);
      assert.equal(
        fields.get("client_secret"),
        mode === "body" ? clientSecret : null,
      );
    }
    assert.equal(fields.get("scope"), "read write");
    if (fields.get("grant_type") === "authorization_code") {
      const authorization = authorizations.get(fields.get("code"));
      assert.equal(
        fields.get("redirect_uri"),
        authorization.searchParams.get("redirect_uri"),
      );
      assert.equal(
        createHash("sha256")
          .update(fields.get("code_verifier"))
          .digest("base64url"),
        authorization.searchParams.get("code_challenge"),
      );
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
    } else if (fields.get("grant_type") === "refresh_token") {
      assert.equal(fields.get("refresh_token"), "fictional-refresh +%中");
    } else assert.equal(fields.get("grant_type"), "client_credentials");
    res.end(
      JSON.stringify({
        access_token: "fixture-access-" + mode,
        token_type: "Bearer",
        refresh_token: "fixture-refresh-" + mode,
        expires_in: 60,
        scope: "read write",
      }),
    );
  });
  const { app, call } = await appFixture(t);
  const projects = await Promise.all([
    app.store.create("OAuth A"),
    app.store.create("OAuth B"),
  ]);
  const before = await Promise.all(
    projects.map((project) => app.store.get(project.id)),
  );
  for (const mode of ["basic", "body", "none"]) {
    const config = {
      authorizationEndpoint: p.base + "/authorize",
      tokenEndpoint: p.base + "/" + mode + "/token",
      clientId,
      clientSecret,
      clientAuthentication: mode,
      scope: "read write",
    };
    for (const grantType of ["client_credentials", "refresh_token"]) {
      const result = await call("/api/oauth/token", {
        ...config,
        grantType,
        refreshToken: "fictional-refresh +%中",
      });
      assert.equal(result.status, 200);
      assert.equal(result.data.accessToken, "fixture-access-" + mode);
      assert.equal(result.data.refreshToken, "fixture-refresh-" + mode);
      assert.equal(result.data.expiresIn, 60);
      assert.equal(JSON.stringify(result.data).includes(clientSecret), false);
    }
    const flow = await call("/api/oauth/start", config);
    assert.equal(flow.status, 200);
    const authorization = new URL(flow.data.authorizationUrl);
    assert.equal(authorization.searchParams.has("client_secret"), false);
    assert.equal(authorization.searchParams.get("client_id"), clientId);
    authorizations.set("fixture-code-" + mode, authorization);
    assert.equal(app.oauthAllowed(authorization.href), true);
    const callback =
      "/oauth/callback?" +
      new URLSearchParams({
        state: authorization.searchParams.get("state"),
        code: "fixture-code-" + mode,
      });
    const callbackResult = await fetch(app.url + callback);
    assert.equal(callbackResult.status, 200);
    assert.equal(
      (await callbackResult.text()).includes("fixture-access"),
      false,
    );
    assert.equal(app.oauthAllowed(authorization.href), false);
    const state = await call("/api/oauth/status/" + flow.data.id);
    assert.equal(state.data.status, "completed");
    assert.equal(state.data.result.accessToken, "fixture-access-" + mode);
    assert.equal((await fetch(app.url + callback)).status, 400);
    const resource = await executeRequest({
      url: p.base + "/" + mode + "/resource",
      auth: { type: "oauth2", token: state.data.result.accessToken },
    });
    assert.equal(resource.body, "authorized");
  }
  assert.equal(p.seen.length, 12);
  assert.deepEqual(
    await Promise.all(projects.map((project) => app.store.get(project.id))),
    before,
  );
  const invalid = await call("/api/oauth/token", {
    tokenEndpoint: p.base,
    grantType: "password",
  });
  assert.equal(invalid.status, 400);
  assert.equal(p.seen.length, 12);
});

test("OAuth-specific encoding leaves ordinary HTTP Basic unchanged and ignores extra credentials", async (t) => {
  const p = await provider(t, ({ req, res, fields }) => {
    if (req.url === "/ordinary")
      assert.equal(
        req.headers.authorization,
        "Basic " +
          Buffer.from(clientId + ":" + clientSecret).toString("base64"),
      );
    else {
      assert.equal(fields.has("client_secret"), false);
      assert.equal(fields.has("client_id"), req.url === "/none");
      assert.equal(
        req.headers.authorization,
        req.url === "/none"
          ? undefined
          : "Basic " +
              Buffer.from(
                formEncode(clientId) + ":" + formEncode(clientSecret),
              ).toString("base64"),
      );
    }
    res.end('{"access_token":"fixture-token"}');
  });
  await executeRequest({
    url: p.base + "/ordinary",
    auth: { type: "basic", username: clientId, password: clientSecret },
  });
  for (const mode of ["basic", "none"])
    await exchangeOAuthToken(
      {
        tokenEndpoint: p.base + "/" + mode,
        clientId,
        clientSecret,
        clientAuthentication: mode,
      },
      { ...grant, client_id: "injected", client_secret: "injected" },
    );
  for (const config of [
    { clientAuthentication: "typo" },
    { clientSecret: {} },
    { clientId: "\ud800" },
  ])
    await assert.rejects(
      exchangeOAuthToken({ tokenEndpoint: p.base, ...config }, grant),
    );
  assert.equal(p.seen.length, 3);
});

test("pre-aborted token and callback requests send no POST and consume callback state", async (t) => {
  const p = await provider(t, ({ res }) =>
    res.end('{"access_token":"unexpected"}'),
  );
  const manager = new OAuthManager();
  t.after(() => manager.close());
  const controller = new AbortController();
  controller.abort();
  const config = { tokenEndpoint: p.base };
  await assert.rejects(exchangeOAuthToken(config, grant, controller.signal), {
    code: "OAUTH_CANCELLED",
  });
  await assert.rejects(manager.exchange(config, grant, controller.signal), {
    code: "OAUTH_CANCELLED",
  });
  const flow = start(manager, p.base);
  await assert.rejects(
    manager.complete({ state: flow.state, code: "fixture" }, controller.signal),
    { code: "OAUTH_CANCELLED" },
  );
  assert.equal(manager.status(flow.id).errorCode, "OAUTH_CANCELLED");
  await assert.rejects(
    manager.complete({ state: flow.state, code: "fixture" }),
    /state/,
  );
  assert.equal(p.seen.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("caller cancellation closes the real token socket and leaves an unrelated flow usable", async (t) => {
  const p = await heldProvider(t);
  const manager = new OAuthManager();
  t.after(() => manager.close());
  const first = start(manager, p.base),
    second = start(manager, p.base);
  const controller = new AbortController();
  const result = manager.complete(
    { state: first.state, code: "first" },
    controller.signal,
  );
  const rejected = assert.rejects(result, { code: "OAUTH_CANCELLED" });
  const held = await within(p.arrived),
    closed = once(held.req.socket, "close");
  controller.abort();
  await within(Promise.all([rejected, closed]));
  assert.equal(held.req.socket.destroyed, true);
  assert.equal(manager.status(first.id).status, "error");
  assert.equal(manager.status(first.id).result, undefined);
  assert.equal(manager.status(second.id).status, "pending");
  assert.equal(manager.allowed(second.authorizationUrl), true);
  assert.equal(manager.exchanges.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  held.res.end('{"access_token":"late-fictional-token"}');
  const next = manager.complete({ state: second.state, code: "second" });
  await within(
    (async () => {
      while (p.seen.length < 2)
        await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
  );
  p.seen[1].res.end('{"access_token":"second-token"}');
  await next;
  assert.equal(manager.status(second.id).result.accessToken, "second-token");
  assert.equal(manager.status(first.id).result, undefined);
});

test("manager close aborts held authorization and direct exchanges and rejects late reuse", async (t) => {
  for (const kind of ["callback", "direct"]) {
    const p = await heldProvider(t),
      manager = new OAuthManager();
    t.after(() => manager.close());
    const flow = start(manager, p.base);
    const saved = manager.flows.get(flow.id);
    const pending =
      kind === "callback"
        ? manager.complete({ state: flow.state, code: "fixture" })
        : manager.exchange({ tokenEndpoint: p.base }, grant);
    const rejected = assert.rejects(pending, { code: "OAUTH_CLOSED" });
    const held = await within(p.arrived),
      closed = once(held.req.socket, "close");
    manager.close();
    manager.close();
    await within(Promise.all([rejected, closed]));
    held.res.end('{"access_token":"late-fictional-token"}');
    assert.equal(manager.flows.size, 0);
    assert.equal(manager.exchanges.size, 0);
    assert.equal(saved.config, undefined);
    assert.equal(saved.verifier, undefined);
    assert.equal(saved.state, undefined);
    assert.equal(saved.result, undefined);
    assert.equal(manager.allowed(flow.authorizationUrl), false);
    assert.throws(() => start(manager, p.base), { code: "OAUTH_CLOSED" });
    await assert.rejects(manager.exchange({ tokenEndpoint: p.base }, grant), {
      code: "OAUTH_CLOSED",
    });
    await assert.rejects(
      manager.complete({ state: flow.state, code: "fixture" }),
      { code: "OAUTH_CLOSED" },
    );
    assert.equal(p.seen.length, 1);
  }
});

test("state claims are one-time and expiry aborts a held POST without affecting another flow", async (t) => {
  const p = await heldProvider(t),
    manager = new OAuthManager();
  t.after(() => manager.close());
  const flow = start(manager, p.base),
    other = start(manager, p.base);
  await assert.rejects(
    manager.complete({ state: "wrong", code: "wrong" }),
    /state/,
  );
  const pending = manager.complete({ state: flow.state, code: "fixture" });
  const rejected = assert.rejects(pending, { code: "OAUTH_EXPIRED" });
  const held = await within(p.arrived),
    closed = once(held.req.socket, "close");
  await assert.rejects(
    manager.complete({ state: flow.state, code: "again" }),
    /state/,
  );
  manager.flows.get(flow.id).expiresAt = Date.now();
  manager.prune();
  await within(Promise.all([rejected, closed]));
  await assert.rejects(
    manager.complete({ state: flow.state, code: "again" }),
    /state/,
  );
  assert.equal(manager.status(other.id).status, "pending");
  assert.equal(p.seen.length, 1);
  const expired = start(manager, p.base);
  manager.flows.get(expired.id).expiresAt = 0;
  await assert.rejects(
    manager.complete({ state: expired.state, code: "expired" }),
    /state/,
  );
  const denied = start(manager, p.base);
  await assert.rejects(
    manager.complete({
      state: denied.state,
      error: "access_denied",
      error_description: clientSecret,
    }),
    /access_denied/,
  );
  assert.equal(manager.status(denied.id).error.includes(clientSecret), false);
  await assert.rejects(
    manager.complete({ state: denied.state, code: "again" }),
    /state/,
  );
  assert.equal(p.seen.length, 1);
});

test("owner token and callback disconnect abort their provider POST, not unrelated flows", async (t) => {
  const { app, call } = await appFixture(t);
  const project = await app.store.create("Unchanged");
  const before = await app.store.get(project.id);
  for (const kind of ["direct", "callback"]) {
    const p = await heldProvider(t);
    const config = {
      tokenEndpoint: p.base + "/token",
      authorizationEndpoint: p.base + "/auth",
      clientId,
      clientSecret,
    };
    const flow = await call("/api/oauth/start", config);
    const state = new URL(flow.data.authorizationUrl).searchParams.get("state");
    const route =
      kind === "direct"
        ? "/api/oauth/token"
        : "/oauth/callback?" +
          new URLSearchParams({ state, code: "fixture-code" });
    const client = http.request(app.url + route, {
      method: kind === "direct" ? "POST" : "GET",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
    });
    client.on("error", () => {});
    client.end(kind === "direct" ? JSON.stringify(config) : undefined);
    const held = await within(p.arrived),
      closed = once(held.req.socket, "close");
    client.destroy();
    await within(closed);
    held.res.end('{"access_token":"late-token"}');
    assert.equal(p.seen.length, 1);
    const status = await call("/api/oauth/status/" + flow.data.id);
    assert.equal(status.data.status, kind === "direct" ? "pending" : "error");
    assert.equal(status.data.result, undefined);
  }
  assert.deepEqual(await app.store.get(project.id), before);
});

test("app server.close aborts OAuth immediately rather than waiting for the provider timeout", async (t) => {
  const p = await heldProvider(t),
    { app, call } = await appFixture(t);
  const pending = call("/api/oauth/token", {
    tokenEndpoint: p.base,
    clientId,
    clientSecret,
  });
  const held = await within(p.arrived),
    closed = once(held.req.socket, "close");
  const shutdown = new Promise((resolve) => app.server.close(resolve));
  const result = await within(pending);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /已关闭/);
  await within(closed);
  app.server.closeIdleConnections();
  await within(shutdown);
  held.res.end('{"access_token":"late-token"}');
  assert.equal(p.seen.length, 1);
});

test("invalid token responses and redirects fail without leaking provider descriptions or retrying", async (t) => {
  let payload,
    status = 200;
  const destination = await provider(t, ({ res }) =>
    res.end('{"access_token":"leaked"}'),
  );
  const p = await provider(t, ({ res }) => {
    if (status === 302) res.setHeader("location", destination.base);
    res.writeHead(status);
    res.end(payload);
  });
  const manager = new OAuthManager();
  t.after(() => manager.close());
  const invalid = [
    "not json",
    "null",
    "[]",
    "{}",
    '{"access_token":42}',
    '{"access_token":{}}',
    '{"access_token":""}',
    '{"access_token":"\\r\\n"}',
    '{"access_token":"ok","token_type":42}',
    '{"access_token":"ok","refresh_token":{}}',
    '{"access_token":"ok","expires_in":-1}',
    '{"access_token":"ok","scope":{}}',
    JSON.stringify({ access_token: "x".repeat(8193) }),
    JSON.stringify({ access_token: "ok", padding: "x".repeat(65536) }),
    JSON.stringify({
      access_token: "bad",
      error: "invalid_client",
      error_description: clientSecret,
    }),
  ];
  for (payload of invalid) {
    const flow = start(manager, p.base);
    await assert.rejects(
      manager.complete({ state: flow.state, code: "fixture" }),
      (error) => !error.message.includes(clientSecret),
    );
    assert.equal(manager.status(flow.id).status, "error");
    assert.equal(manager.status(flow.id).result, undefined);
    await assert.rejects(
      manager.complete({ state: flow.state, code: "again" }),
      /state/,
    );
    // Completed/failed flows retain their polling slot until expiry, as before.
    manager.forget(flow.id);
  }
  for (status of [401, 500, 302]) {
    payload = JSON.stringify({
      error: "invalid_client",
      error_description: clientSecret,
    });
    await assert.rejects(
      manager.exchange({ tokenEndpoint: p.base }, grant),
      (error) =>
        error.message.includes("HTTP " + status) &&
        !error.message.includes(clientSecret),
    );
  }
  assert.equal(p.seen.length, invalid.length + 3);
  assert.equal(destination.seen.length, 0);
  const broken = await provider(t, ({ req }) => req.socket.destroy());
  await assert.rejects(manager.exchange({ tokenEndpoint: broken.base }, grant));
  assert.equal(broken.seen.length, 1);
  assert.equal(manager.exchanges.size, 0);
});

test(
  "token timeout is distinct from cancellation and closes the real socket",
  { timeout: 20000 },
  async (t) => {
    const p = await heldProvider(t),
      manager = new OAuthManager();
    t.after(() => manager.close());
    const pending = manager.exchange({ tokenEndpoint: p.base }, grant);
    const rejected = assert.rejects(pending, { code: "OAUTH_TIMEOUT" });
    const held = await within(p.arrived),
      closed = once(held.req.socket, "close");
    await within(Promise.all([rejected, closed]), 17000);
    assert.equal(p.seen.length, 1);
    assert.equal(manager.exchanges.size, 0);
  },
);

test("OAuth owner endpoints still reject unauthenticated/cross-origin calls and duplicate callbacks", async (t) => {
  const p = await provider(t, ({ res }) =>
    res.end('{"access_token":"unexpected"}'),
  );
  const { app, call } = await appFixture(t);
  for (const route of ["/api/oauth/start", "/api/oauth/token"]) {
    for (const headers of [
      {},
      { "x-local-token": app.token, origin: "https://evil.example" },
    ]) {
      const response = await fetch(app.url + route, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ tokenEndpoint: p.base }),
      });
      assert.equal(response.status, 403);
    }
  }
  const flow = await call("/api/oauth/start", {
    tokenEndpoint: p.base,
    authorizationEndpoint: p.base + "/authorize",
  });
  const state = new URL(flow.data.authorizationUrl).searchParams.get("state");
  assert.equal(
    (
      await fetch(
        app.url +
          "/oauth/callback?" +
          new URLSearchParams([
            ["state", state],
            ["state", "injected"],
            ["code", "fixture"],
          ]),
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/api/oauth/status/" + flow.data.id)).data.status,
    "pending",
  );
  assert.equal(p.seen.length, 0);
});
