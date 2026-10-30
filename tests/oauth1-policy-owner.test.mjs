// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

async function owner(t, handler) {
  const errors = [],
    seen = [];
  const peer = http.createServer(async (req, res) => {
    try {
      seen.push(req.url);
      const handled = await handler(req, res);
      if (handled) return;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 401;
      res.end("independent verification failed");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "oauth1-policy-owner-"));
  let app = await createApp({ root, port: 0 });
  const cleanup = [];
  async function stop() {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
  t.after(async () => {
    // Child transports/processes must close before their server or data root.
    for (const close of cleanup.toReversed()) await close();
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function call(route, method = "GET", data, status = 200) {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return {
    get app() {
      return app;
    },
    root,
    cleanup: (close) => cleanup.push(close),
    call,
    seen,
    errors,
    url: "http://127.0.0.1:" + peer.address().port,
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}
const authByName = (project) =>
  Object.fromEntries(
    project.requests.map((request) => [request.name, request.auth]),
  );

function credentialEnvironment(project) {
  const selected = project.environments.find(
    (env) => env.variables?.oauthSecret === secret,
  );
  assert(
    selected,
    "explicit fixture credential environment must survive persistence",
  );
  return selected.id;
}
async function cliRun(f, projectId, planId, environmentId) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
      "--project",
      projectId,
      "--plan",
      planId,
      "--environment",
      environmentId,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let closed = false,
    output = "",
    errors = "",
    failure;
  // External fixture deadline only; never increases or retries product work.
  const timer = setTimeout(() => {
    failure = "CLI fixture deadline";
    child.kill("SIGKILL");
  }, 10000);
  const completion = new Promise((resolve) => {
    const collect = (field, chunk) => {
      if (field === "output") output += chunk;
      else errors += chunk;
      if (Buffer.byteLength(output) + Buffer.byteLength(errors) > 1024 * 1024) {
        failure = "CLI fixture output limit";
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => collect("output", chunk));
    child.stderr.on("data", (chunk) => collect("errors", chunk));
    child.once("error", (error) => {
      failure = error.message;
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, output, errors, failure });
    });
  });
  f.cleanup(async () => {
    if (!closed) child.kill("SIGKILL");
    await completion; // actual child close precedes server close/root removal
  });
  const cli = await completion;
  assert.equal(cli.failure, undefined, cli.failure);
  assert.equal(cli.code, 0, cli.errors);
  assert.equal(JSON.parse(cli.output).status, "passed");
}

import { verifyOAuth1Policy } from "./fixtures/oauth1-policy-oracle.mjs";
const secret = "fictional-oauth1-owner-secret";
const policy = (
  placement = "auto",
  includeBodyHash = true,
  includeEmptyParams = true,
  headerEncoding = "percent",
) => ({ placement, includeBodyHash, includeEmptyParams, headerEncoding });
function specifications(publicKey, privateKey) {
  const common = {
    type: "oauth1",
    consumerKey: "owner-key",
    consumerSecret: secret,
    accessToken: "owner-token",
    tokenSecret: "owner-token-secret",
    version: "1.0",
    nonce: "",
    timestamp: "",
    realm: "owner realm",
    callback: "",
    verifier: "",
  };
  const make = (
    name,
    method,
    bodyType,
    body,
    form,
    parameterPolicy,
    extras = {},
  ) => ({
    name,
    method,
    bodyType,
    body,
    form,
    auth: {
      ...common,
      ...extras,
      ...(parameterPolicy ? { parameterPolicy } : {}),
    },
    publicKey,
  });
  return [
    make("get-auto", "GET", "none", "", [], policy(), {
      accessToken: "",
      version: "",
    }),
    make("json-auto", "POST", "json", '{"unicode":"雪","n":1}', [], policy(), {
      signatureMethod: "HMAC-SHA256",
    }),
    make(
      "post-form",
      "POST",
      "urlencoded",
      "",
      [
        { key: "x", value: "1" },
        { key: "x", value: "2" },
        { key: "empty", value: "" },
      ],
      policy("auto", true, false),
    ),
    make(
      "put-form",
      "PUT",
      "urlencoded",
      "",
      [
        { key: "x", value: "a+b" },
        { key: "x", value: "雪" },
      ],
      policy(),
      { accessToken: "", version: "" },
    ),
    make(
      "rsa-header",
      "POST",
      "binary",
      Buffer.from([0, 255, 1, 128]).toString("base64"),
      [],
      policy("header", true, false),
      { signatureMethod: "RSA-SHA1", privateKey },
    ),
    make(
      "raw-header",
      "GET",
      "none",
      "",
      [],
      policy("header", false, false, "raw"),
      { verifier: "raw+percent%20" },
    ),
    make(
      "patch-form",
      "PATCH",
      "urlencoded",
      "",
      [
        { key: "x", value: "1" },
        { key: "empty", value: "" },
      ],
      policy(),
    ),
    make("legacy", "POST", "json", '{"legacy":true}', [], undefined),
  ];
}
const configuration = (p) => ({
  requests: p.requests,
  settings: p.settings,
  plans: p.plans,
  environments: p.environments,
});
async function seed(f, specs) {
  const p = await f.app.store.create("OAuth1 policy workflows");
  for (const env of p.environments) env.variables.oauthSecret = secret;
  const templated = (auth) => ({ ...auth, consumerSecret: "{{oauthSecret}}" });
  p.settings.globalAuth = templated(specs[0].auth);
  p.settings.folderAuth = { Scoped: templated(specs[1].auth) };
  p.requests = specs.map((s, index) =>
    normalizeRequest({
      id: s.name,
      name: s.name,
      method: s.method,
      url: f.url + "/" + s.name + "?dup=one&dup=two&empty=",
      bodyType: s.bodyType,
      body: s.body,
      form: s.form,
      folder: index === 1 ? "Scoped" : "",
      auth: index < 2 ? { type: "none" } : templated(s.auth),
      inheritAuth: index < 2,
    }),
  );
  await f.call("/api/projects/" + p.id, "PUT", p);
  return f.app.store.get(p.id);
}
function verifier(specs, errors, nonces) {
  const byName = new Map(specs.map((s) => [s.name, s]));
  return async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    const name = new URL(req.url, "http://fixture").pathname.slice(1),
      spec = byName.get(name);
    assert(spec, "known request path");
    assert.equal(req.method, spec.method);
    const checked = verifyOAuth1Policy({
      url: "http://" + req.headers.host + req.url,
      method: req.method,
      headers: req.headers,
      body: bytes,
      auth: spec.auth,
      bodyType: spec.bodyType,
      publicKey: spec.publicKey,
    });
    assert(!nonces.has(checked.protocol.oauth_nonce));
    nonces.add(checked.protocol.oauth_nonce);
    assert.deepEqual(checked.ordinaryQuery, [
      ["dup", "one"],
      ["dup", "two"],
      ["empty", ""],
    ]);
    if (spec.bodyType === "urlencoded")
      assert.deepEqual(
        checked.ordinaryForm,
        spec.form.map((f) => [f.key, f.value]),
      );
    else
      assert.deepEqual(
        bytes,
        spec.bodyType === "binary"
          ? Buffer.from(spec.body, "base64")
          : Buffer.from(spec.body || ""),
      );
    if (bytes.length)
      assert.equal(Number(req.headers["content-length"]), bytes.length);
    return false;
  };
}
test(
  "OAuth1 policy real owner shared/own signing, frozen live edits, backup/restart, two SDK aliases and CLI keep exact wire intent",
  { timeout: 60000 },
  async (t) => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      specs = specifications(
        rsa.publicKey,
        rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
      ),
      nonces = new Set();
    const f = await owner(t, verifier(specs, [], nonces)),
      source = await seed(f, specs),
      foreign = await seed(f, specs),
      foreignBefore = await f.app.store.get(foreign.id);
    const plan = await f.call("/api/projects/" + source.id + "/plans", "POST", {
      name: "Frozen OAuth1 policy",
      environmentId: credentialEnvironment(source),
      statusPolicy: "strict200",
      steps: source.requests.map((request) => ({ request })),
    });
    assert.deepEqual(
      plan.steps.map((s) => s.request.auth.parameterPolicy),
      specs.map((s) => s.auth.parameterPolicy),
    );
    const frozen = structuredClone(plan.steps),
      live = await f.app.store.get(source.id);
    live.settings.globalAuth.nonce = "later-global-nonce";
    live.settings.folderAuth.Scoped.nonce = "later-folder-nonce";
    for (const request of live.requests)
      if (request.auth.type === "oauth1") {
        request.auth.nonce = "later-own-nonce";
        if (request.auth.parameterPolicy)
          request.auth.parameterPolicy.includeBodyHash =
            !request.auth.parameterPolicy.includeBodyHash;
      }
    await f.call("/api/projects/" + source.id, "PUT", live);
    const run = await f.call("/api/projects/" + source.id + "/run", "POST", {
      planId: plan.id,
    });
    assert.equal(
      run.status,
      "passed",
      JSON.stringify({ run, errors: f.errors }),
    );
    assert.equal(f.seen.length, 8);
    assert.equal(run.recordSaved, true);
    assert(
      (await f.app.store.get(source.id)).runs.some((r) => r.id === run.id),
    );
    const backup = await f.call("/api/projects/" + source.id + "/export"),
      restored = await f.call(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
    await f.restart();
    let disk = await f.app.store.get(restored.id);
    assert.deepEqual(disk.plans[0].steps, frozen);
    const replay = await f.call("/api/projects/" + disk.id + "/run", "POST", {
      planId: disk.plans[0].id,
      environmentId: credentialEnvironment(disk),
    });
    assert.equal(
      replay.status,
      "passed",
      JSON.stringify({ replay, errors: f.errors }),
    );
    assert.equal(replay.recordSaved, true);
    assert.equal(f.seen.length, 16);
    disk = await f.app.store.get(disk.id);
    disk.requests = disk.plans[0].steps.map((step) => step.request);
    await f.call("/api/projects/" + disk.id, "PUT", disk);
    disk = await f.app.store.get(disk.id);
    const beforeConsumers = configuration(disk);
    const config = await f.call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [disk.id],
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "oauth1-policy-owner", version: "1" },
      { capabilities: {} },
    );
    f.cleanup(async () => {
      await client.close().catch(() => {});
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    for (const [name, args] of [
      [
        "localapi_execute_api",
        {
          projectId: disk.id,
          apiId: disk.requests[0].id,
          environmentId: credentialEnvironment(disk),
        },
      ],
      [
        "apipost_execute_api",
        {
          project_id: disk.id,
          target_id: disk.requests[1].id,
          environment_id: credentialEnvironment(disk),
        },
      ],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).status, "passed");
    }
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: foreign.id, apiId: foreign.requests[0].id },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /项目未授权/);
    assert.equal(f.seen.length, 18);
    await client.close();
    await cliRun(f, disk.id, disk.plans[0].id, credentialEnvironment(disk));
    assert.equal(f.seen.length, 26);
    await f.restart();
    const final = await f.app.store.get(disk.id);
    assert.deepEqual(configuration(final), beforeConsumers);
    assert.equal(final.runs.length, 3);
    assert(final.runs.every((r) => r.status === "passed"));
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.equal(nonces.size, 26);
    assert.deepEqual(f.errors, []);
  },
);
test(
  "OAuth1 static-policy owner save/import/restore/plan/execute rejection is atomic before any wire request",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, () => {
        throw Error("invalid request reached peer");
      }),
      specs = specifications(undefined, undefined).filter(
        (s) => s.name !== "rsa-header",
      ),
      source = await seed(f, specs);
    for (const change of [
      (a) => (a.parameterPolicy.placement = "{{placement}}"),
      (a) => (a.parameterPolicy.includeBodyHash = "true"),
      (a) => (a.parameterPolicy.privateField = "private-never-echo"),
      (a) => (a.consumerSecret = 17),
    ]) {
      const request = structuredClone(source.requests[2]);
      change(request.auth);
      const before = await f.app.store.get(source.id);
      const update = structuredClone(before);
      update.requests[2] = request;
      await f.call("/api/projects/" + source.id, "PUT", update, 400);
      await f.call(
        "/api/projects/" + source.id + "/import",
        "POST",
        { document: { requests: [request] } },
        400,
      );
      await f.call(
        "/api/projects/" + source.id + "/plans",
        "POST",
        { name: "invalid", steps: [{ request }] },
        400,
      );
      await f.call(
        "/api/projects/" + source.id + "/execute",
        "POST",
        { request },
        400,
      );
      const idsBefore = (await f.app.store.list()).map((p) => p.id).sort();
      const backup = await f.call("/api/projects/" + source.id + "/export");
      backup.requests[2] = request;
      const result = await f.call(
        "/api/restore",
        "POST",
        { document: backup },
        400,
      );
      assert(!JSON.stringify(result).includes("private-never-echo"));
      assert.deepEqual(
        (await f.app.store.list()).map((p) => p.id).sort(),
        idsBefore,
      );
      assert.deepEqual(await f.app.store.get(source.id), before);
      assert.equal(f.seen.length, 0);
    }
    const unsafe = structuredClone(
      source.requests.find((r) => r.name === "raw-header"),
    );
    unsafe.auth.verifier = 'bad"header';
    const result = await f.call(
      "/api/projects/" + source.id + "/execute",
      "POST",
      { request: unsafe },
    );
    assert.equal(result.outcome, "failed");
    assert.match(JSON.stringify(result), /Header/);
    assert.equal(f.seen.length, 0);
    assert.deepEqual(f.errors, []);
  },
);
test(
  "OAuth1 policy owner cancellation preserves one signed request and stops the later plan step",
  { timeout: 30000 },
  async (t) => {
    let arrive;
    const arrived = new Promise((resolve) => (arrive = resolve));
    const auth = {
      type: "oauth1",
      consumerKey: "cancel-key",
      consumerSecret: secret,
      accessToken: "cancel-token",
      tokenSecret: "cancel-secret",
      version: "1.0",
      parameterPolicy: policy(),
    };
    const f = await owner(t, async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      assert.equal(new URL(req.url, "http://fixture").pathname, "/hold");
      verifyOAuth1Policy({
        url: "http://" + req.headers.host + req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks),
        auth,
        bodyType: "json",
      });
      arrive();
      await new Promise((resolve) => res.once("close", resolve));
      return true;
    });
    const project = await f.app.store.create("Cancel OAuth1 policy");
    const first = normalizeRequest({
      url: f.url + "/hold",
      method: "POST",
      bodyType: "json",
      body: '{"cancel":true}',
      auth,
    });
    const later = normalizeRequest({ ...first, url: f.url + "/later" });
    const plan = await f.call(
      "/api/projects/" + project.id + "/plans",
      "POST",
      {
        name: "Cancel after signature",
        steps: [{ request: first }, { request: later }],
      },
    );
    const pending = f.call("/api/projects/" + project.id + "/run", "POST", {
      planId: plan.id,
      runId: "oauth1-policy-cancel",
    });
    const early = await Promise.race([
      arrived.then(() => ({ arrived: true })),
      pending.then(
        (result) => ({ result }),
        (error) => ({ error: error.message }),
      ),
    ]);
    assert.equal(
      early.arrived,
      true,
      JSON.stringify({ early, errors: f.errors }),
    );
    await f.call("/api/cancel", "POST", { id: "oauth1-policy-cancel" });
    const run = await pending;
    assert.equal(run.status, "cancelled");
    assert.equal(run.results.length, 1);
    assert.equal(f.seen.length, 1);
    assert(
      (await f.app.store.get(project.id)).runs.some((r) => r.id === run.id),
    );
    assert.deepEqual(f.errors, []);
  },
);
