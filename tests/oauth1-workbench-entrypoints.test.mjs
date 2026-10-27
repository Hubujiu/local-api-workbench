// Combined acceptance with fictional loopback credentials only. Owner exchange
// does not persist; explicit owner save deliberately persists both signing secrets.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
const consumerKey = "fictional client + /汉";
const consumerSecret = "fictional consumer secret +&=/";
const temporaryToken = "fictional temporary + /汉";
const temporarySecret = "fictional temporary secret + /";
const accessToken = "fictional access + /汉";
const tokenSecret = "fictional access secret + /";
const verifier = "fictional verifier + /汉";
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
// Independent RFC5849 oracle: decoded header + every query pair, encode/sort,
// signature base URI without query, HMAC-SHA1. Never import production signer.
function verifySignature(req, origin, secret) {
  const entries = [
    ...(req.headers.authorization || "").matchAll(/(oauth_\w+)="([^"]*)"/g),
  ].map(([, key, value]) => [key, decodeURIComponent(value)]);
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
  const oauth = Object.fromEntries(entries),
    url = new URL(req.url, origin);
  assert.equal(oauth.oauth_consumer_key, consumerKey);
  assert.equal(oauth.oauth_signature_method, "HMAC-SHA1");
  assert(oauth.oauth_nonce);
  assert.match(oauth.oauth_timestamp, /^\d+$/);
  const normalized = [
    ...entries.filter(([key]) => key !== "oauth_signature"),
    ...url.searchParams,
  ]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([key, value]) => key + "=" + value)
    .join("&");
  const base = [req.method.toUpperCase(), url.origin + url.pathname, normalized]
    .map(encode)
    .join("&");
  const expected = createHmac(
    "sha1",
    encode(consumerSecret) + "&" + encode(secret),
  )
    .update(base)
    .digest("base64");
  assert.equal(oauth.oauth_signature, expected);
  return oauth;
}
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const tool = (client, name, args) => client.callTool({ name, arguments: args });
const names = async (client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "oauth1-entrypoints-")),
    exchanges = [],
    resources = [],
    errors = [],
    clients = [];
  let origin;
  const peer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin),
        chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).length, 0);
      const auth = verifySignature(
        req,
        origin,
        url.pathname === "/request"
          ? ""
          : url.pathname === "/access"
            ? temporarySecret
            : tokenSecret,
      );
      if (url.pathname === "/request") {
        assert.equal(req.method, "POST");
        assert.equal(auth.oauth_token, undefined);
        assert.match(
          auth.oauth_callback,
          /^http:\/\/127\.0\.0\.1:\d+\/oauth1\/callback\/[a-f0-9]{48}$/,
        );
        exchanges.push({ kind: "request", auth });
        res.end(
          new URLSearchParams({
            oauth_token: temporaryToken,
            oauth_token_secret: temporarySecret,
            oauth_callback_confirmed: "true",
          }).toString(),
        );
        return;
      }
      if (url.pathname === "/access") {
        assert.equal(req.method, "POST");
        assert.equal(auth.oauth_token, temporaryToken);
        assert.equal(auth.oauth_verifier, verifier);
        exchanges.push({ kind: "access", auth });
        res.end(
          new URLSearchParams({
            oauth_token: accessToken,
            oauth_token_secret: tokenSecret,
          }).toString(),
        );
        return;
      }
      assert.equal(url.pathname, "/resource");
      assert.equal(req.method, "GET");
      assert.deepEqual(url.searchParams.getAll("repeat"), ["a", "b"]);
      assert.equal(url.searchParams.get("text"), "汉 +");
      assert.equal(auth.oauth_token, accessToken);
      assert.equal(req.headers["x-tenant"], "selected-environment");
      resources.push({ url: req.url, nonce: auth.oauth_nonce });
      res.writeHead(200, {
        "content-type": "application/json",
        "x-fixture": "oauth1-verified",
      });
      res.end('{"authorized":true}');
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("fixture signature validation failed");
    }
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${peer.address().port}`;
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const call = async (route, body, method = "POST") => {
    const r = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, value: await r.json() };
  };
  return {
    root,
    origin,
    exchanges,
    resources,
    call,
    get store() {
      return app.store;
    },
    get url() {
      return app.url;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async connect(projectId, { write = false, execute = false } = {}) {
      const configured = await call("/api/mcp/config", {
        enabled: true,
        projects: [projectId],
        write,
        execute,
        remember: false,
      });
      assert.equal(configured.status, 200);
      const client = new Client(
        { name: "oauth1-workbench-acceptance", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + configured.value.token },
          },
        }),
      );
      return { client, token: configured.value.token };
    },
  };
}
function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("OAuth entrypoint CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI fixture output exceeds bound");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}

test(
  "owner OAuth1 callback becomes explicitly saved signed auth across official SDK, frozen flow, CLI and restored restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.store.create("Owner saved OAuth1"),
      other = await f.store.create("Isolated project");
    p.environments[0].variables.tenant = "selected-environment";
    await f.store.save(p);
    const before = await f.store.get(p.id),
      otherBefore = await f.store.get(other.id);
    const config = {
      consumerKey,
      consumerSecret,
      callbackMode: "loopback",
      requestTokenEndpoint: f.origin + "/request",
      authorizationEndpoint: f.origin + "/authorize",
      tokenEndpoint: f.origin + "/access",
    };
    const read = await f.connect(p.id),
      readTools = await names(read.client);
    assert(!readTools.some((n) => /oauth/i.test(n)));
    assert(!readTools.includes("apipost_execute_flow"));
    const denied = await fetch(f.url + "/api/oauth1/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + read.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(config),
    });
    assert.equal(denied.status, 403);
    assert.equal(
      (await tool(read.client, "localapi_oauth1_start", config)).isError,
      true,
    );
    assert.equal(f.exchanges.length, 0);
    const start = await f.call("/api/oauth1/start", config);
    assert.equal(start.status, 200, JSON.stringify(start));
    const flow = start.value;
    assert.equal(
      new URL(flow.authorizationUrl).searchParams.get("oauth_token"),
      temporaryToken,
    );
    assert.equal(f.exchanges[0].auth.oauth_callback, flow.redirectUri);
    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set("oauth_token", temporaryToken);
    redirect.searchParams.set("oauth_verifier", verifier);
    assert.equal((await fetch(redirect)).status, 200);
    const completed = await f.call("/api/oauth1/complete", { id: flow.id });
    assert.equal(completed.status, 200);
    assert.deepEqual(completed.value, { accessToken, tokenSecret });
    assert.deepEqual(
      f.exchanges.map((x) => x.kind),
      ["request", "access"],
    );
    assert.deepEqual(
      await f.store.get(p.id),
      before,
      "exchange alone must not persist",
    );
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.deepEqual(await names(read.client), readTools);
    assert.equal(f.resources.length, 0);
    const explicit = await f.store.get(p.id);
    explicit.requests = [
      {
        id: "saved-oauth1",
        name: "Explicit OAuth1 auth",
        method: "GET",
        url: f.origin + "/resource?repeat=a&repeat=b&text=%E6%B1%89%20%2B",
        headers: [{ key: "X-Tenant", value: "{{tenant}}", enabled: true }],
        auth: {
          type: "oauth1",
          consumerKey,
          consumerSecret,
          ...completed.value,
        },
      },
    ];
    const save = await f.call(`/api/projects/${p.id}`, explicit, "PUT");
    assert.equal(save.status, 200);
    const savedAuth = structuredClone(save.value.requests[0].auth);
    assert.equal(savedAuth.consumerSecret, consumerSecret);
    assert.equal(savedAuth.tokenSecret, tokenSecret);
    assert.equal(
      (
        await tool(read.client, "apipost_execute_api", {
          project_id: p.id,
          target_id: "saved-oauth1",
        })
      ).isError,
      true,
    );
    assert.equal(f.resources.length, 0);
    const exec = await f.connect(p.id, { write: true, execute: true });
    assert.equal(
      (
        await tool(exec.client, "apipost_execute_api", {
          project_id: other.id,
          target_id: "saved-oauth1",
        })
      ).isError,
      true,
    );
    const apiRun = decode(
      await tool(exec.client, "apipost_execute_api", {
        project_id: p.id,
        target_id: "saved-oauth1",
      }),
    );
    assert.equal(apiRun.status, "passed");
    assert.equal(apiRun.record_saved, true);
    const plan = decode(
        await tool(exec.client, "apipost_create_execution_flow", {
          project_id: p.id,
          name: "Frozen OAuth1",
          environment_id: p.environments[0].id,
          steps: [{ target_id: "saved-oauth1" }],
        }),
      ),
      planId = plan.flow_id;
    const current = await f.store.get(p.id);
    current.requests[0].auth.tokenSecret = "edited-live-secret-never-send";
    current.requests[0].url = f.origin + "/edited-live-never-send";
    assert.equal(
      (await f.call(`/api/projects/${p.id}`, current, "PUT")).status,
      200,
    );
    const sdkRun = decode(
      await tool(exec.client, "apipost_execute_flow", {
        project_id: p.id,
        flow_id: planId,
      }),
    );
    assert.equal(sdkRun.status, "passed");
    assert.equal(sdkRun.record_saved, true);
    const result = await cli(f.root, p.id, planId);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    const cliRun = JSON.parse(result.stdout);
    assert.equal(cliRun.status, "passed");
    assert.equal(cliRun.recordSaved, true);
    assert.deepEqual(cliRun.snapshot.steps[0].request.auth, savedAuth);
    assert.equal(f.resources.length, 3);
    const backup = await f.call(
      `/api/projects/${p.id}/export`,
      undefined,
      "GET",
    );
    assert.equal(backup.status, 200);
    assert(JSON.stringify(backup.value).includes(consumerSecret));
    assert(JSON.stringify(backup.value).includes(tokenSecret));
    assert(!JSON.stringify(backup.value).includes(temporarySecret));
    assert(!JSON.stringify(backup.value).includes(verifier));
    const original = await f.store.get(p.id);
    assert.equal(
      original.runs[0].results[0].response.headers["x-fixture"],
      "oauth1-verified",
    );
    const restored = await f.call("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201);
    assert.notEqual(restored.value.id, p.id);
    await f.restart();
    assert.equal(f.exchanges.length, 2);
    assert.equal(f.resources.length, 3);
    const restoredRead = await f.connect(restored.value.id);
    assert(
      !(await names(restoredRead.client)).includes("apipost_execute_flow"),
    );
    assert.equal(
      (
        await tool(restoredRead.client, "localapi_get_execution_flow", {
          projectId: p.id,
          planId,
        })
      ).isError,
      true,
    );
    const replay = await cli(f.root, restored.value.id, planId);
    assert.equal(replay.code, 0, replay.stderr);
    const replayRun = JSON.parse(replay.stdout);
    assert.equal(replayRun.status, "passed");
    assert.equal(replayRun.recordSaved, true);
    assert.deepEqual(replayRun.snapshot.steps[0].request.auth, savedAuth);
    assert.equal(f.resources.length, 4);
    assert.equal(new Set(f.resources.map((x) => x.nonce)).size, 4);
    assert.equal(
      f.exchanges.length,
      2,
      "restore/execute must not repeat token exchange",
    );
    assert.deepEqual(await new Store(f.root).get(p.id), original);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
  },
);
