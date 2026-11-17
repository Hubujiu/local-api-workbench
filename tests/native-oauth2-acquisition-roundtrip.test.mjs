// Root integration only: synthetic native interchange + Workbench OAuth provider.
// This is not an original-application runtime or proprietary implementation oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

async function owner(t) {
  const root = await mkdtemp(join(tmpdir(), "native-acquisition-roundtrip-"));
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
function source(base) {
  const definition = {
    addTokenTo: "header",
    headerPrefix: "Bearer",
    access_token: "before-acquisition",
    grant_type: "authorization_code_with_pkce",
    redirect_uri: "",
    authUrl: base + "/authorize",
    accessTokenUrl: base + "/token",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    username: "{{inert-user}}",
    password: "{{inert-password}}",
    challengeAlgorithm: "S256",
    code_verifier: "",
    scope: "read write",
    state: "",
    client_authentication: "body",
    refreshTokenUrl: base + "/refresh",
    authRequestParams: [],
    tokenRequestParams: [],
    refreshRequestParams: [],
  };
  assert.equal(Object.keys(definition).length, 20);
  const document = modernApipostFixture();
  const api = structuredClone(
    document.apis.find((item) => item.target_type === "api"),
  );
  Object.assign(api, {
    target_id: "oauth-acquisition",
    parent_id: "0",
    name: "Native acquisition",
    url: base + "/resource",
    method: "GET",
  });
  api.request.auth = { type: "oauth2", oauth2: structuredClone(definition) };
  api.request.header.parameter = [];
  api.request.query.parameter = [];
  document.apis = [api];
  document.global.envs[0].server_list[0].uri = base;
  return { definition, document };
}
function assertDefinition(project, expected) {
  assert.equal(project.requests.length, 1);
  assert.equal(project.requests[0].inheritAuth, false);
  assert.deepEqual(project.requests[0].auth, {
    type: "oauth2",
    nativeOAuth2: expected,
  });
  assert.equal(Object.keys(project.requests[0].auth.nativeOAuth2).length, 20);
}

test(
  "root native JSON acquisition, two-generation JSON/directory definitions, explicit refresh and frozen backup stay isolated",
  { timeout: 60000 },
  async (t) => {
    const seen = [],
      errors = [];
    let authorization,
      expectedResourceToken = "acquired-token";
    const peer = http.createServer(async (req, res) => {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        seen.push(req.url);
        if (req.url === "/resource") {
          assert.equal(req.method, "GET");
          assert.equal(
            req.headers.authorization,
            "Bearer " + expectedResourceToken,
          );
          res.end("authorized " + expectedResourceToken);
          return;
        }
        assert.equal(req.method, "POST");
        assert.match(
          req.headers["content-type"],
          /^application\/x-www-form-urlencoded/,
        );
        assert.equal(req.headers.authorization, undefined);
        const fields = new URLSearchParams(body);
        assert.equal(fields.get("client_id"), "fixture-client");
        assert.equal(fields.get("client_secret"), "fixture-secret");
        assert.equal(fields.get("scope"), "read write");
        for (const key of [
          "username",
          "password",
          "access_token",
          "state",
          "headerPrefix",
          "addTokenTo",
        ])
          assert.equal(fields.has(key), false);
        if (req.url === "/token") {
          assert.equal(fields.get("grant_type"), "authorization_code");
          assert.equal(fields.get("code"), "explicit-code");
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
              access_token: "acquired-token",
              refresh_token: "returned-but-not-cached",
              token_type: "Bearer",
            }),
          );
        } else {
          assert.equal(req.url, "/refresh");
          assert.equal(fields.get("grant_type"), "refresh_token");
          assert.equal(
            fields.get("refresh_token"),
            "external-refresh {{opaque}} +雪",
          );
          assert.equal(fields.has("code_verifier"), false);
          res.end(
            JSON.stringify({
              access_token: "refreshed-token",
              refresh_token: "rotated-not-cached",
              token_type: "Bearer",
            }),
          );
        }
      } catch (error) {
        errors.push(error);
        res.statusCode = 500;
        res.end("fixture verification failed");
      }
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      assert.deepEqual(errors, []);
    });
    const base = `http://127.0.0.1:${peer.address().port}`;
    const f = await owner(t),
      otherOwner = await owner(t);
    const untouched = await f.app.store.create("unrelated target"),
      other = await otherOwner.app.store.create("foreign owner");
    const untouchedBefore = await f.app.store.get(untouched.id),
      otherBefore = await otherOwner.app.store.get(other.id);
    const { document, definition } = source(base),
      original = structuredClone(document);
    const initial = await f.app.store.create("native acquisition source");
    let project = await f.call(`/api/projects/${initial.id}/import`, {
      document,
      inheritanceMode: "flatten",
    });
    assertDefinition(project, definition);
    assert.deepEqual(document, original);
    assert.deepEqual(seen, []);
    const before = await f.app.store.get(project.id);
    const flow = await f.call("/api/oauth/native/start", {
      auth: project.requests[0].auth,
    });
    authorization = new URL(flow.authorizationUrl);
    const callback =
      "/oauth/callback?" +
      new URLSearchParams({
        state: authorization.searchParams.get("state"),
        code: "explicit-code",
      });
    assert.equal((await fetch(otherOwner.app.url + callback)).status, 400);
    assert.deepEqual(seen, []);
    assert.equal((await fetch(f.app.url + callback)).status, 200);
    const status = await f.call("/api/oauth/status/" + flow.id);
    assert.equal(status.status, "completed");
    assert.equal(status.result.accessToken, "acquired-token");
    assert.deepEqual(await f.app.store.get(project.id), before);
    const acquired = { ...definition, access_token: status.result.accessToken };
    project = await f.app.store.get(project.id);
    project.requests[0].auth.nativeOAuth2.access_token = acquired.access_token;
    await f.call(`/api/projects/${project.id}`, project, "PUT");
    async function execute(current) {
      const result = await f.call(`/api/projects/${current.id}/execute`, {
        request: current.requests[0],
      });
      assert.equal(result.status, 200, JSON.stringify({ result, errors }));
      assert.equal(result.body, "authorized " + expectedResourceToken);
    }
    await execute(await f.app.store.get(project.id));
    // Native formats are definition-only. Do these projections before adding
    // frozen plans; complete projects below travel through full backups only.
    const sourceBefore = await f.app.store.get(project.id);
    for (const format of ["apipost", "apipost-directory"]) {
      let current = sourceBefore;
      for (let generation = 1; generation <= 2; generation++) {
        const count = seen.length;
        const exported = await f.call(
          `/api/projects/${current.id}/export?format=${format}`,
        );
        const target = await f.app.store.create(
          `${format} generation ${generation}`,
        );
        const imported = await f.call(`/api/projects/${target.id}/import`, {
          document: exported,
          inheritanceMode: "flatten",
        });
        assert.notEqual(imported.id, current.id);
        assertDefinition(imported, acquired);
        assert.equal(
          seen.length,
          count,
          "definition import/export must not acquire, refresh or execute",
        );
        await execute(imported);
        current = await f.app.store.get(imported.id);
      }
    }
    assert.deepEqual(await f.app.store.get(project.id), sourceBefore);
    const frozen = await f.call(`/api/projects/${project.id}/plans`, {
      name: "acquired token snapshot",
      steps: [{ request: sourceBefore.requests[0] }],
    });
    const beforeRefresh = await f.app.store.get(project.id);
    const refresh = await f.call("/api/oauth/native/refresh", {
      auth: beforeRefresh.requests[0].auth,
      refreshToken: "external-refresh {{opaque}} +雪",
    });
    assert.equal(refresh.accessToken, "refreshed-token");
    assert.deepEqual(
      await f.app.store.get(project.id),
      beforeRefresh,
      "refresh result is not an implicit definition/cache write",
    );
    await execute(await f.app.store.get(project.id)); // still the acquired token
    project = await f.app.store.get(project.id);
    project.requests[0].auth.nativeOAuth2.access_token = refresh.accessToken;
    await f.call(`/api/projects/${project.id}`, project, "PUT");
    project = await f.app.store.get(project.id);
    assertDefinition(project, { ...acquired, access_token: "refreshed-token" });
    assert.deepEqual(project.plans[0].steps, frozen.steps);
    assert.deepEqual(
      project.plans[0].steps[0].request.auth.nativeOAuth2,
      acquired,
    );
    expectedResourceToken = "refreshed-token";
    await execute(project);
    const backup = await f.call(`/api/projects/${project.id}/export`);
    const restored = await f.call(
      "/api/restore",
      { document: backup },
      "POST",
      201,
    );
    await f.restart();
    const disk = await f.app.store.get(restored.id);
    assertDefinition(disk, { ...acquired, access_token: "refreshed-token" });
    assert.deepEqual(disk.plans[0].steps, frozen.steps);
    await execute(disk);
    const count = seen.length;
    assert.equal((await fetch(f.app.url + callback)).status, 400);
    await f.call(
      "/api/oauth/native/refresh",
      { auth: disk.requests[0].auth },
      "POST",
      400,
    );
    assert.equal(
      seen.length,
      count,
      "restart does not persist old state or infer refresh credentials",
    );
    expectedResourceToken = "acquired-token";
    const run = await f.call(`/api/projects/${disk.id}/run`, {
      planId: disk.plans[0].id,
    });
    assert.equal(run.status, "passed", JSON.stringify({ run, errors }));
    assert.equal(run.recordSaved, true);
    assert.deepEqual(await f.app.store.get(untouched.id), untouchedBefore);
    assert.deepEqual(await otherOwner.app.store.get(other.id), otherBefore);
    assert.equal(seen.filter((url) => url === "/token").length, 1);
    assert.equal(seen.filter((url) => url === "/refresh").length, 1);
    assert.deepEqual(errors, []);
  },
);
