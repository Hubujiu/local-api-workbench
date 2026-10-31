// Workbench native-definition bridge tests; no vendor runtime or credential oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { nativeOAuth2GrantInput } from "../src/native-oauth2-grant.mjs";

const clientId = "fixture:client +%雪&=";
const clientSecret = "fixture:secret +%文&=";
const encodeForm = (value) =>
  new URLSearchParams({ v: value }).toString().slice(2);
function native(base, patch = {}) {
  return {
    type: "oauth2",
    nativeOAuth2: {
      grant_type: "authorization_code",
      client_authentication: "header",
      authUrl: base + "/authorize",
      accessTokenUrl: base + "/token",
      refreshTokenUrl: base + "/refresh",
      clientId,
      clientSecret,
      scope: "read write",
      challengeAlgorithm: "S256",
      redirect_uri: "",
      state: "",
      code_verifier: "",
      username: "{{inert-user}}",
      password: "{{inert-password}}",
      access_token: "old-token",
      addTokenTo: "header",
      headerPrefix: "Bearer",
      authRequestParams: [],
      tokenRequestParams: [],
      refreshRequestParams: [],
      ...patch,
    },
  };
}
async function peer(t, handler) {
  const seen = [],
    errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const part of req) body += part;
      const record = { req, res, body, fields: new URLSearchParams(body) };
      seen.push(record);
      await handler(record);
    } catch (error) {
      errors.push(error);
      if (!res.destroyed) {
        res.statusCode = 500;
        res.end("fixture failed");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}
async function owner(t) {
  const root = await mkdtemp(join(tmpdir(), "native-acquisition-"));
  let app = await createApp({ root, port: 0 });
  async function stop() {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async call(
      route,
      body,
      method = body === undefined ? "GET" : "POST",
      status = 200,
    ) {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    },
  };
}
function callback(flow, code = "fixture-code") {
  return (
    "/oauth/callback?" +
    new URLSearchParams({
      state: new URL(flow.authorizationUrl).searchParams.get("state"),
      code,
    })
  );
}
function credentials(req, fields, mode) {
  if (mode === "header") {
    assert.equal(
      req.headers.authorization,
      "Basic " +
        Buffer.from(
          encodeForm(clientId) + ":" + encodeForm(clientSecret),
        ).toString("base64"),
    );
    assert.equal(fields.has("client_id"), false);
    assert.equal(fields.has("client_secret"), false);
  } else {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(fields.get("client_id"), clientId);
    assert.equal(fields.get("client_secret"), clientSecret);
  }
  assert.equal(fields.get("scope"), "read write");
  for (const key of [
    "username",
    "password",
    "access_token",
    "addTokenTo",
    "headerPrefix",
    "state",
    "challengeAlgorithm",
  ])
    assert.equal(fields.has(key), false, key + " is inert or controlled");
}

test(
  "native acquisition header/body × authorization-code/PKCE explicitly saves tokens without rewriting frozen definitions",
  { timeout: 60000 },
  async (t) => {
    const authorizations = new Map();
    const p = await peer(t, ({ req, res, fields }) => {
      const [mode, grant, operation] = req.url.slice(1).split("/");
      const token = "acquired-" + mode + "-" + grant;
      if (operation === "resource") {
        assert.equal(req.method, "GET");
        assert.equal(req.headers.authorization, "Bearer " + token);
        res.end("authorized");
        return;
      }
      assert.equal(operation, "token");
      assert.equal(req.method, "POST");
      assert.match(
        req.headers["content-type"],
        /^application\/x-www-form-urlencoded/,
      );
      credentials(req, fields, mode);
      assert.equal(fields.get("grant_type"), "authorization_code");
      const authorization = authorizations.get(fields.get("code"));
      assert(authorization);
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
      res.end(
        JSON.stringify({
          access_token: token,
          refresh_token: "refresh-" + token,
          token_type: "Bearer",
          expires_in: 60,
        }),
      );
    });
    const f = await owner(t),
      foreign = await f.app.store.create("unrelated");
    const foreignBefore = await f.app.store.get(foreign.id);
    for (const mode of ["header", "body"])
      for (const grant of [
        "authorization_code",
        "authorization_code_with_pkce",
      ]) {
        const auth = native(p.base, {
          client_authentication: mode,
          grant_type: grant,
          accessTokenUrl: `${p.base}/${mode}/${grant}/token`,
        });
        const original = structuredClone(auth);
        const project = await f.app.store.create(mode + " " + grant);
        project.requests = [
          normalizeRequest({
            name: "acquired",
            method: "GET",
            url: `${p.base}/${mode}/${grant}/resource`,
            auth,
            inheritAuth: false,
          }),
        ];
        await f.call("/api/projects/" + project.id, project, "PUT");
        const frozen = await f.call(`/api/projects/${project.id}/plans`, {
          name: "before acquisition",
          steps: [{ request: project.requests[0] }],
        });
        const before = await f.app.store.get(project.id);
        const flow = await f.call("/api/oauth/native/start", { auth });
        const authorization = new URL(flow.authorizationUrl),
          code = mode + "-" + grant;
        authorizations.set(code, authorization);
        assert.equal(authorization.searchParams.get("client_id"), clientId);
        assert.equal(authorization.searchParams.has("client_secret"), false);
        assert.equal(authorization.searchParams.get("scope"), "read write");
        assert.equal(f.app.oauthAllowed(authorization.href), true);
        const response = await fetch(f.app.url + callback(flow, code));
        assert.equal(response.status, 200);
        const callbackBody = await response.text();
        assert(!callbackBody.includes("acquired-"));
        assert(!callbackBody.includes(clientSecret));
        const status = await f.call("/api/oauth/status/" + flow.id);
        assert.equal(status.status, "completed");
        assert.equal(
          status.result.accessToken,
          "acquired-" + mode + "-" + grant,
        );
        assert.equal(f.app.oauthAllowed(authorization.href), false);
        assert.equal(
          (await fetch(f.app.url + callback(flow, code))).status,
          400,
        );
        assert.deepEqual(
          await f.app.store.get(project.id),
          before,
          "acquisition does not save or mutate definitions",
        );
        assert.deepEqual(auth, original);
        const edited = await f.app.store.get(project.id);
        edited.requests[0].auth.nativeOAuth2.access_token =
          status.result.accessToken;
        await f.call("/api/projects/" + project.id, edited, "PUT");
        const saved = await f.app.store.get(project.id);
        assert.deepEqual(saved.plans[0].steps, frozen.steps);
        assert.deepEqual(saved.plans[0].steps[0].request.auth, original);
        const execution = await f.call(`/api/projects/${project.id}/execute`, {
          request: saved.requests[0],
        });
        assert.equal(execution.status, 200);
        assert.equal(execution.body, "authorized");
        const backup = await f.call(`/api/projects/${project.id}/export`);
        const restored = await f.call(
          "/api/restore",
          { document: backup },
          "POST",
          201,
        );
        await f.restart();
        const disk = await f.app.store.get(restored.id);
        assert.deepEqual(disk.requests[0].auth, saved.requests[0].auth);
        assert.deepEqual(disk.plans[0].steps, frozen.steps);
        const replay = await f.call(`/api/projects/${disk.id}/execute`, {
          request: disk.requests[0],
        });
        assert.equal(replay.status, 200);
        assert.equal(replay.body, "authorized");
        assert.equal(
          (await fetch(f.app.url + callback(flow, code))).status,
          400,
        );
      }
    assert.equal(p.seen.length, 12);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
  },
);

test(
  "native refresh uses the explicit endpoint/token and one credential channel; provider errors are sanitized",
  { timeout: 30000 },
  async (t) => {
    const p = await peer(t, ({ req, res, fields }) => {
      const mode = req.url.slice(1).split("/")[0];
      assert.equal(req.method, "POST");
      credentials(req, fields, mode);
      assert.equal(fields.get("grant_type"), "refresh_token");
      assert.equal(
        fields.get("refresh_token"),
        "explicit-refresh {{opaque}} +%雪",
      );
      for (const key of ["code", "code_verifier", "redirect_uri"])
        assert.equal(fields.has(key), false);
      if (req.url.endsWith("/error")) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: "invalid_grant",
            error_description:
              clientSecret + " explicit-refresh {{opaque}} +%雪",
            unknown: clientSecret,
          }),
        );
      } else
        res.end(
          JSON.stringify({
            access_token: "refreshed-token",
            refresh_token: "rotated-token",
            expires_in: 120,
          }),
        );
    });
    const f = await owner(t),
      project = await f.app.store.create("refresh isolation");
    const before = await f.app.store.get(project.id);
    for (const mode of ["header", "body"]) {
      const auth = native(p.base, {
        client_authentication: mode,
        refreshTokenUrl: p.base + "/" + mode + "/refresh",
        authUrl: "{{inactive}}",
        accessTokenUrl: "{{inactive}}",
        redirect_uri: "{{inactive}}",
        state: "{{inactive}}",
        code_verifier: "{{inactive}}",
        challengeAlgorithm: "plain",
      });
      const result = await f.call("/api/oauth/native/refresh", {
        auth,
        refreshToken: "explicit-refresh {{opaque}} +%雪",
      });
      assert.equal(result.accessToken, "refreshed-token");
      assert.equal(result.refreshToken, "rotated-token");
      assert.equal(result.expiresIn, 120);
      auth.nativeOAuth2.refreshTokenUrl = p.base + "/" + mode + "/error";
      const error = await f.call(
        "/api/oauth/native/refresh",
        { auth, refreshToken: "explicit-refresh {{opaque}} +%雪" },
        "POST",
        400,
      );
      assert(!JSON.stringify(error).includes(clientSecret));
      assert(!JSON.stringify(error).includes("explicit-refresh"));
    }
    assert.equal(p.seen.length, 4);
    assert.deepEqual(await f.app.store.get(project.id), before);
  },
);

test(
  "invalid native acquisition definitions and unauthenticated callers do zero provider I/O",
  { timeout: 30000 },
  async (t) => {
    const p = await peer(t, ({ res }) =>
      res.end('{"access_token":"unexpected"}'),
    );
    const f = await owner(t);
    const patches = [
      ...[
        "password",
        "password_credentials",
        "client_credentials",
        "implicit",
        "unknown",
        "",
      ].map((grant_type) => ({ grant_type })),
      ...["basic", "none", "", "unknown"].map((client_authentication) => ({
        client_authentication,
      })),
      { clientId: "" },
      { challengeAlgorithm: "plain" },
      { redirect_uri: "https://foreign.invalid/callback" },
      { state: "caller-state" },
      { code_verifier: "caller-verifier" },
      ...[
        "authRequestParams",
        "tokenRequestParams",
        "refreshRequestParams",
      ].map((key) => ({ [key]: [{ key: "extra", value: "x" }] })),
      ...["authUrl", "accessTokenUrl"].flatMap((key) =>
        [
          "",
          "file:///secret",
          "http://user:password@localhost/",
          "http://localhost/#fragment",
        ].map((value) => ({ [key]: value })),
      ),
      ...[
        "authUrl",
        "accessTokenUrl",
        "clientId",
        "clientSecret",
        "scope",
      ].flatMap((key) =>
        ["{{unresolved}}", "control\u0001", "x".repeat(8193)].map((value) => ({
          [key]: value,
        })),
      ),
      { unknown: "private-sentinel" },
    ];
    for (const patch of patches) {
      const error = await f.call(
        "/api/oauth/native/start",
        { auth: native(p.base, patch) },
        "POST",
        400,
      );
      assert(!JSON.stringify(error).includes("private-sentinel"));
      if (
        ![
          "challengeAlgorithm",
          "redirect_uri",
          "state",
          "code_verifier",
          "authUrl",
          "accessTokenUrl",
        ].some((key) => Object.hasOwn(patch, key))
      )
        await f.call(
          "/api/oauth/native/refresh",
          { auth: native(p.base, patch), refreshToken: "explicit" },
          "POST",
          400,
        );
    }
    for (const body of [
      {},
      { auth: { type: "oauth2", token: "legacy" } },
      { auth: native(p.base), extra: "not-supported" },
    ])
      await f.call("/api/oauth/native/start", body, "POST", 400);
    for (const key of [
      "grant_type",
      "client_authentication",
      "clientId",
      "authUrl",
      "accessTokenUrl",
    ]) {
      const auth = native(p.base);
      delete auth.nativeOAuth2[key];
      await f.call("/api/oauth/native/start", { auth }, "POST", 400);
    }
    for (const refreshToken of [
      undefined,
      "",
      "\n",
      "control\u0001",
      "雪".repeat(2731),
      "x".repeat(8193),
    ])
      await f.call(
        "/api/oauth/native/refresh",
        { auth: native(p.base), refreshToken },
        "POST",
        400,
      );
    for (const refreshTokenUrl of [
      "",
      "{{missing}}",
      "file:///secret",
      "http://localhost/#fragment",
      "x".repeat(8193),
    ])
      await f.call(
        "/api/oauth/native/refresh",
        { auth: native(p.base, { refreshTokenUrl }), refreshToken: "explicit" },
        "POST",
        400,
      );
    const unauthorized = await fetch(f.app.url + "/api/oauth/native/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: native(p.base) }),
    });
    assert.equal(unauthorized.status, 403);
    const unauthorizedRefresh = await fetch(
      f.app.url + "/api/oauth/native/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          auth: native(p.base),
          refreshToken: "explicit",
        }),
      },
    );
    assert.equal(unauthorizedRefresh.status, 403);
    assert.equal(p.seen.length, 0);
  },
);

test(
  "native callback state is instance-scoped, consumed on provider failure and absent after restart",
  { timeout: 30000 },
  async (t) => {
    const p = await peer(t, ({ res }) => {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "invalid_grant",
          error_description: clientSecret,
        }),
      );
    });
    const f = await owner(t),
      foreign = await owner(t);
    const flow = await f.call("/api/oauth/native/start", {
      auth: native(p.base),
    });
    assert.equal((await fetch(foreign.app.url + callback(flow))).status, 400);
    assert.equal(p.seen.length, 0);
    assert.equal(
      (await f.call("/api/oauth/status/" + flow.id)).status,
      "pending",
    );
    const failed = await fetch(f.app.url + callback(flow));
    assert.equal(failed.status, 400);
    assert(!(await failed.text()).includes(clientSecret));
    const status = await f.call("/api/oauth/status/" + flow.id);
    assert.equal(status.status, "error");
    assert(!JSON.stringify(status).includes(clientSecret));
    assert.equal((await fetch(f.app.url + callback(flow))).status, 400);
    assert.equal(p.seen.length, 1);
    const pending = await f.call("/api/oauth/native/start", {
      auth: native(p.base),
    });
    await f.restart();
    assert.equal((await fetch(f.app.url + callback(pending))).status, 400);
    assert.equal(p.seen.length, 1);
  },
);

test(
  "native token exchange disconnect cancels provider I/O and consumes callback state",
  { timeout: 30000 },
  async (t) => {
    const arrived = Promise.withResolvers(),
      disconnected = Promise.withResolvers();
    const p = await peer(t, ({ res }) => {
      res.once("close", () => disconnected.resolve());
      arrived.resolve();
    });
    const f = await owner(t);
    const flow = await f.call("/api/oauth/native/start", {
      auth: native(p.base),
    });
    const controller = new AbortController();
    const callbackResult = fetch(f.app.url + callback(flow), {
      signal: controller.signal,
    }).then(
      () => "unexpected response",
      () => "aborted",
    );
    await arrived.promise;
    controller.abort();
    assert.equal(await callbackResult, "aborted");
    await disconnected.promise;
    assert.equal((await fetch(f.app.url + callback(flow))).status, 400);
    assert.equal(p.seen.length, 1);
    await f.restart();
    assert.equal((await fetch(f.app.url + callback(flow))).status, 400);
    assert.equal(p.seen.length, 1);
  },
);

test("native grant adapter rejects descriptor tricks without evaluating getters and returns detached active fields", () => {
  let reads = 0;
  const getter = {
    enumerable: true,
    get() {
      reads++;
      throw Error("getter must not run");
    },
  };
  for (const layer of ["input", "auth", "definition"]) {
    for (const shape of ["getter", "hidden", "symbol", "prototype"]) {
      const input = { auth: native("https://provider.invalid") };
      const object =
        layer === "input"
          ? input
          : layer === "auth"
            ? input.auth
            : input.auth.nativeOAuth2;
      const key =
        layer === "input"
          ? "auth"
          : layer === "auth"
            ? "nativeOAuth2"
            : "clientId";
      if (shape === "getter") Object.defineProperty(object, key, getter);
      if (shape === "hidden")
        Object.defineProperty(object, key, {
          value: object[key],
          enumerable: false,
        });
      if (shape === "symbol") object[Symbol("hidden")] = "secret";
      if (shape === "prototype")
        Object.setPrototypeOf(object, { inherited: "secret" });
      assert.throws(() => nativeOAuth2GrantInput(input, "start"));
    }
  }
  assert.equal(reads, 0);
  for (const operation of ["start", "refresh"]) {
    for (const value of [
      "雪".repeat(2731),
      "{{value}}",
      "value}}",
      "control\u007f",
      "\ud800",
    ]) {
      for (const key of ["clientId", "clientSecret", "scope"]) {
        assert.throws(() =>
          nativeOAuth2GrantInput(
            {
              auth: native("https://provider.invalid", { [key]: value }),
              ...(operation === "refresh" ? { refreshToken: "explicit" } : {}),
            },
            operation,
          ),
        );
      }
    }
  }
  for (const challengeAlgorithm of [undefined, "", "S256"]) {
    const auth = native("https://provider.invalid");
    if (challengeAlgorithm === undefined)
      delete auth.nativeOAuth2.challengeAlgorithm;
    else auth.nativeOAuth2.challengeAlgorithm = challengeAlgorithm;
    const before = structuredClone(auth);
    const result = nativeOAuth2GrantInput({ auth }, "start");
    assert.equal(result.config.clientAuthentication, "basic");
    result.config.clientId = "detached";
    assert.deepEqual(auth, before);
  }
  const auth = native("https://provider.invalid", {
    redirect_uri: "{{unused}}",
    state: "{{unused}}",
    code_verifier: "{{unused}}",
    challengeAlgorithm: "plain",
    authUrl: "{{unused}}",
    accessTokenUrl: "{{unused}}",
  });
  const result = nativeOAuth2GrantInput(
    { auth, refreshToken: "explicit" },
    "refresh",
  );
  assert.deepEqual(result.grant, {
    grant_type: "refresh_token",
    refresh_token: "explicit",
  });
  assert.deepEqual(
    Object.keys(result.config).sort(),
    [
      "clientAuthentication",
      "clientId",
      "clientSecret",
      "scope",
      "tokenEndpoint",
    ].sort(),
  );
  assert.equal(result.config.tokenEndpoint, "https://provider.invalid/refresh");
  assert.throws(() => nativeOAuth2GrantInput({ auth }, "unknown"));
});

test(
  "closing the owner cancels a native exchange and a reopened owner cannot replay its state",
  { timeout: 30000 },
  async (t) => {
    const arrived = Promise.withResolvers(),
      disconnected = Promise.withResolvers();
    const p = await peer(t, ({ res }) => {
      res.once("close", () => disconnected.resolve());
      arrived.resolve();
    });
    const f = await owner(t);
    const flow = await f.call("/api/oauth/native/start", {
      auth: native(p.base),
    });
    const request = fetch(f.app.url + callback(flow)).then(
      async (response) => {
        await response.text();
        return response.status;
      },
      () => "disconnected",
    );
    await arrived.promise;
    await f.restart();
    await disconnected.promise;
    assert.notEqual(await request, 200);
    assert.equal((await fetch(f.app.url + callback(flow))).status, 400);
    assert.equal(p.seen.length, 1);
  },
);

for (const cancellation of ["caller disconnect", "owner close"])
  test(
    `native refresh ${cancellation} aborts the actual provider exchange without caching credentials`,
    { timeout: 30000 },
    async (t) => {
      const arrived = Promise.withResolvers(),
        disconnected = Promise.withResolvers();
      let attempts = 0;
      const p = await peer(t, ({ req, res, fields }) => {
        attempts++;
        assert.equal(req.url, "/refresh");
        assert.equal(req.method, "POST");
        credentials(req, fields, "header");
        assert.equal(fields.get("grant_type"), "refresh_token");
        assert.equal(
          fields.get("refresh_token"),
          attempts === 1 ? "cancelled-refresh" : "fresh-explicit-refresh",
        );
        if (attempts === 1) {
          res.once("close", () => disconnected.resolve());
          arrived.resolve();
        } else
          res.end(
            JSON.stringify({
              access_token: "fresh-after-cancellation",
              token_type: "Bearer",
            }),
          );
      });
      const f = await owner(t),
        project = await f.app.store.create("refresh cancellation isolation");
      const before = await f.app.store.get(project.id);
      const auth = native(p.base),
        controller = new AbortController();
      const pending = fetch(f.app.url + "/api/oauth/native/refresh", {
        method: "POST",
        headers: {
          "x-local-token": f.app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ auth, refreshToken: "cancelled-refresh" }),
        signal: controller.signal,
      }).then(
        async (response) => {
          await response.text();
          return response.status;
        },
        () => "disconnected",
      );
      await arrived.promise;
      if (cancellation === "caller disconnect") controller.abort();
      else await f.restart();
      assert.notEqual(await pending, 200);
      await disconnected.promise;
      assert.equal(p.seen.length, 1);
      assert.deepEqual(await f.app.store.get(project.id), before);
      // Neither the cancelled input nor the stored native access_token supplies a
      // hidden refresh credential to a later explicit acquisition request.
      await f.call("/api/oauth/native/refresh", { auth }, "POST", 400);
      assert.equal(p.seen.length, 1);
      const result = await f.call("/api/oauth/native/refresh", {
        auth,
        refreshToken: "fresh-explicit-refresh",
      });
      assert.equal(result.accessToken, "fresh-after-cancellation");
      assert.equal(p.seen.length, 2);
      assert.deepEqual(await f.app.store.get(project.id), before);
      await f.restart();
      assert.deepEqual(await f.app.store.get(project.id), before);
    },
  );
