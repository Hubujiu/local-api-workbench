// Definition interchange and Workbench runtime only; no vendor runtime oracle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

async function owner(t, handler) {
  const errors = [],
    seen = [];
  const peer = http.createServer((req, res) => {
    try {
      const handled = handler(req, res);
      seen.push(req.url);
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
  const root = await mkdtemp(join(tmpdir(), "digest-policy-owner-"));
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

async function cliRun(f, projectId, planId) {
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

const algorithms = [
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
];
const credentials = {
  username: "fixture-user",
  password: "fixture-private-password",
};
function destination() {
  const challenges = new Map(),
    cnonces = new Set();
  let sequence = 0;
  return (req, res) => {
    const name = new URL(req.url, "http://fixture").pathname.slice(1);
    const algorithm = algorithms.includes(name) ? name : "SHA-256";
    if (!req.headers.authorization) {
      const nonce = "fixture-nonce-" + ++sequence;
      challenges.set(nonce, { url: req.url, algorithm });
      res.writeHead(401, {
        "WWW-Authenticate":
          name === "disabled"
            ? "Digest malformed-private-challenge"
            : `Digest realm="fixture", nonce="${nonce}", algorithm=${algorithm}, qop="auth"`,
      });
      res.end("challenge");
      return true;
    }
    assert(req.headers.authorization.startsWith("Digest "));
    const params = Object.fromEntries(
      [
        ...req.headers.authorization.matchAll(
          /([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g,
        ),
      ].map((m) => [m[1], m[2] ?? m[3]]),
    );
    const challenge = challenges.get(params.nonce);
    assert(challenge);
    assert.equal(challenge.url, req.url);
    challenges.delete(params.nonce);
    assert.equal(params.algorithm.toUpperCase(), algorithm.toUpperCase());
    assert.equal(params.username, credentials.username);
    assert.equal(params.uri, req.url);
    assert.equal(params.qop, "auth");
    assert.equal(params.nc, "00000001");
    assert(params.cnonce);
    assert(!cnonces.has(params.cnonce), "fresh cnonce per execution");
    cnonces.add(params.cnonce);
    const family = algorithm.replace(/-sess$/i, "");
    const hash = (value) =>
      createHash(
        { MD5: "md5", "SHA-256": "sha256", "SHA-512-256": "sha512-256" }[
          family
        ],
      )
        .update(value)
        .digest("hex");
    let ha1 = hash(credentials.username + ":fixture:" + credentials.password);
    if (algorithm.endsWith("-sess"))
      ha1 = hash(ha1 + ":" + params.nonce + ":" + params.cnonce);
    const ha2 = hash(req.method + ":" + req.url);
    assert.equal(
      params.response,
      hash(
        [ha1, params.nonce, params.nc, params.cnonce, "auth", ha2].join(":"),
      ),
    );
    return false;
  };
}
const policies = (project) =>
  project.requests.map((r) => r.auth.challengePolicy);

test(
  "Digest owner six canonical policies persist in frozen snapshots and restore/reopen; official SDK and CLI execute saved policy with independent verification",
  { timeout: 45000 },
  async (t) => {
    const f = await owner(t, destination());
    const source = await f.app.store.create("Digest policy source");
    source.requests = algorithms.map((algorithm) =>
      normalizeRequest({
        id: algorithm,
        name: algorithm,
        url: f.url + "/" + algorithm,
        auth: {
          type: "digest",
          ...(algorithm === "MD5"
            ? { username: "{{digestUser}}", password: "{{digestPassword}}" }
            : credentials),
          challengePolicy: { algorithm, retry: true },
        },
        inheritAuth: false,
      }),
    );
    for (const environment of source.environments)
      Object.assign(environment.variables, {
        digestUser: credentials.username,
        digestPassword: credentials.password,
      });
    await f.call("/api/projects/" + source.id, "PUT", source);
    const expected = policies(source);
    await f.restart();
    const reopened = await f.app.store.get(source.id);
    assert.deepEqual(policies(reopened), expected);
    assert.equal(reopened.requests[0].auth.username, "{{digestUser}}");
    assert.equal(reopened.requests[0].auth.password, "{{digestPassword}}");
    const plan = await f.call("/api/projects/" + source.id + "/plans", "POST", {
      name: "Frozen Digest",
      statusPolicy: "strict200",
      steps: source.requests.map((request) => ({ request })),
    });
    assert.deepEqual(
      plan.steps.map((s) => s.request.auth.challengePolicy),
      expected,
    );
    const live = await f.app.store.get(source.id);
    for (const request of live.requests)
      request.auth.challengePolicy.retry = false;
    await f.call("/api/projects/" + source.id, "PUT", live);
    const run = await f.call("/api/projects/" + source.id + "/run", "POST", {
      planId: plan.id,
    });
    assert.equal(
      run.status,
      "passed",
      JSON.stringify({ run, errors: f.errors }),
    );
    assert.equal(f.seen.length, 12);
    const backup = await f.call("/api/projects/" + source.id + "/export");
    const restored = await f.call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.notEqual(restored.id, source.id);
    await f.restart();
    const disk = await f.app.store.get(restored.id);
    assert.deepEqual(
      disk.plans[0].steps.map((s) => s.request.auth.challengePolicy),
      expected,
    );
    assert.equal(
      disk.plans[0].steps[0].request.auth.username,
      "{{digestUser}}",
    );
    assert.equal(
      disk.plans[0].steps[0].request.auth.password,
      "{{digestPassword}}",
    );
    assert(disk.requests.every((r) => r.auth.challengePolicy.retry === false));
    const rerun = await f.call("/api/projects/" + disk.id + "/run", "POST", {
      planId: disk.plans[0].id,
    });
    assert.equal(
      rerun.status,
      "passed",
      JSON.stringify({ rerun, errors: f.errors }),
    );
    assert.equal(f.seen.length, 24);
    disk.requests = disk.plans[0].steps.map((s) => s.request);
    await f.call("/api/projects/" + disk.id, "PUT", disk);
    const foreign = await f.app.store.create("Digest denied project"),
      foreignBefore = await f.app.store.get(foreign.id);
    const config = await f.call("/api/mcp/config", "POST", {
      enabled: true,
      projects: [disk.id],
      write: true,
      execute: true,
      remember: false,
    });
    const client = new Client(
      { name: "digest-policy-owner", version: "1" },
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
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const [name, args] of [
      [
        "localapi_execute_api",
        { projectId: disk.id, apiId: disk.requests[0].id },
      ],
      ["localapi_run_plan", { projectId: disk.id, planId: disk.plans[0].id }],
    ]) {
      assert(tools.has(name));
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).status, "passed");
    }
    assert.equal(f.seen.length, 38);
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: foreign.id, apiId: disk.requests[0].id },
    });
    assert.equal(denied.isError, true);
    assert.equal(f.seen.length, 38);
    await f.call(
      "/api/projects/" + foreign.id + "/run",
      "POST",
      { planId: plan.id },
      400,
    );
    assert.equal(f.seen.length, 38);
    await client.close();
    await cliRun(f, disk.id, disk.plans[0].id);
    assert.equal(f.seen.length, 50);
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "saved disabled and mismatch policies constrain owner execution while absent policy retains legacy ignored fields",
  { timeout: 20000 },
  async (t) => {
    const f = await owner(t, destination());
    const p = await f.app.store.create("Digest retry policy");
    p.requests = [
      normalizeRequest({
        name: "disabled",
        url: f.url + "/disabled",
        auth: {
          type: "digest",
          ...credentials,
          challengePolicy: { algorithm: "SHA-256", retry: false },
        },
      }),
      normalizeRequest({
        name: "mismatch",
        url: f.url + "/mismatch",
        auth: {
          type: "digest",
          ...credentials,
          challengePolicy: { algorithm: "MD5", retry: true },
        },
      }),
      normalizeRequest({
        name: "legacy",
        url: f.url + "/legacy",
        auth: {
          type: "digest",
          ...credentials,
          algorithm: "MD5",
          disableRetryRequest: true,
        },
      }),
    ];
    await f.call("/api/projects/" + p.id, "PUT", p);
    await f.restart();
    const saved = await f.app.store.get(p.id);
    assert.deepEqual(
      saved.requests.map((r) => r.auth),
      p.requests.map((r) => r.auth),
    );
    const disabled = await f.call(
      "/api/projects/" + p.id + "/execute",
      "POST",
      { request: saved.requests[0] },
    );
    assert.equal(disabled.status, 401);
    assert.equal(f.seen.length, 1);
    const mismatch = await f.call(
      "/api/projects/" + p.id + "/execute",
      "POST",
      { request: saved.requests[1] },
    );
    assert.equal(mismatch.outcome, "failed");
    assert.equal(f.seen.length, 2);
    const legacy = await f.call("/api/projects/" + p.id + "/execute", "POST", {
      request: saved.requests[2],
    });
    assert.equal(
      legacy.outcome,
      "passed",
      JSON.stringify({ legacy, errors: f.errors }),
    );
    assert.equal(f.seen.length, 4);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "Raw Digest policy schema fails owner save/import/restore/execute atomically before interpolation or HTTP",
  { timeout: 20000 },
  async (t) => {
    const f = await owner(t, () =>
      assert.fail("invalid policy must send no HTTP"),
    );
    const p = await f.app.store.create("Atomic policy target");
    const good = normalizeRequest({
      id: "good",
      name: "good",
      url: f.url + "/never",
      auth: {
        type: "digest",
        ...credentials,
        challengePolicy: { algorithm: "SHA-256", retry: true },
      },
    });
    p.requests = [good];
    for (const environment of p.environments)
      environment.variables.selectedAlgorithm = "SHA-256";
    await f.call("/api/projects/" + p.id, "PUT", p);
    const before = await f.app.store.get(p.id),
      backup = await f.call("/api/projects/" + p.id + "/export");
    const invalidAuths = [
      {
        type: "bearer",
        token: "private-policy-marker",
        challengePolicy: { algorithm: "MD5", retry: true },
      },
      {
        type: "digest",
        ...credentials,
        challengePolicy: { algorithm: "SHA-256" },
      },
      {
        type: "digest",
        ...credentials,
        challengePolicy: { algorithm: "SHA-256", retry: "false" },
      },
      {
        type: "digest",
        ...credentials,
        challengePolicy: { algorithm: "sha-256", retry: true },
      },
      {
        type: "digest",
        ...credentials,
        challengePolicy: {
          algorithm: "SHA-256",
          retry: true,
          privateUnknown: "private-policy-marker",
        },
      },
      { type: "digest", ...credentials, challengePolicy: null },
      {
        type: "digest",
        ...credentials,
        challengePolicy: { algorithm: "{{selectedAlgorithm}}", retry: true },
      },
    ];
    const projectIds = async () =>
      (await f.app.store.list()).map((p) => p.id).sort();
    const beforeIds = await projectIds();
    for (const auth of invalidAuths) {
      const request = { ...good, auth };
      const document = { ...structuredClone(backup), requests: [request] };
      for (const [route, method, data] of [
        [
          "/api/projects/" + p.id,
          "PUT",
          { ...structuredClone(before), requests: [request] },
        ],
        [
          "/api/projects/" + p.id + "/import",
          "POST",
          { document: { requests: [request] } },
        ],
        ["/api/restore", "POST", { document }],
        ["/api/projects/" + p.id + "/execute", "POST", { request }],
      ]) {
        const error = await f.call(route, method, data, 400);
        const text = JSON.stringify(error);
        assert(!text.includes("private-policy-marker"));
        assert(!text.includes(credentials.password));
        assert(!text.includes("privateUnknown"));
        assert.deepEqual(await f.app.store.get(p.id), before);
        assert.deepEqual(await projectIds(), beforeIds);
        assert.equal(f.seen.length, 0);
        assert.deepEqual(f.errors, []);
      }
    }
  },
);

test(
  "shared Digest owner policies freeze, reject malformed saves atomically and survive backup/restart/CLI",
  { timeout: 45000 },
  async (t) => {
    const inspect = destination();
    const f = await owner(t, (req, res) => {
      if (req.url === "/plain") {
        assert.equal(req.headers.authorization, undefined);
        return false;
      }
      return inspect(req, res);
    });
    const project = await f.app.store.create("Shared Digest policy");
    const auth = (algorithm) => ({
      type: "digest",
      ...credentials,
      challengePolicy: { algorithm, retry: true },
    });
    project.settings.globalAuth = auth("SHA-256");
    project.settings.folderAuth = {
      Private: auth("MD5-sess"),
      Public: { type: "none" },
    };
    project.requests = [
      normalizeRequest({ name: "global", url: f.url + "/SHA-256" }),
      normalizeRequest({
        name: "folder",
        folder: "Private",
        url: f.url + "/MD5-sess",
      }),
      normalizeRequest({
        name: "public",
        folder: "Public",
        url: f.url + "/plain",
      }),
    ];
    await f.call("/api/projects/" + project.id, "PUT", project);
    const before = await f.app.store.get(project.id);
    const invalid = structuredClone(before);
    invalid.settings.folderAuth.Private.challengePolicy.retry = "false";
    await f.call("/api/projects/" + project.id, "PUT", invalid, 400);
    assert.deepEqual(await f.app.store.get(project.id), before);
    assert.equal(f.seen.length, 0);
    const plan = await f.call(
      "/api/projects/" + project.id + "/plans",
      "POST",
      {
        name: "Shared frozen Digest",
        statusPolicy: "strict200",
        steps: project.requests.map((request) => ({ request })),
      },
    );
    assert.deepEqual(
      plan.steps.map((s) => s.request.auth),
      [
        project.settings.globalAuth,
        project.settings.folderAuth.Private,
        { type: "none" },
      ],
    );
    const live = await f.app.store.get(project.id);
    live.settings.globalAuth.challengePolicy.retry = false;
    live.settings.folderAuth.Private.challengePolicy.algorithm = "MD5";
    await f.call("/api/projects/" + project.id, "PUT", live);
    const run = await f.call("/api/projects/" + project.id + "/run", "POST", {
      planId: plan.id,
    });
    assert.equal(
      run.status,
      "passed",
      JSON.stringify({ run, errors: f.errors }),
    );
    assert.equal(f.seen.length, 5);
    const backup = await f.call("/api/projects/" + project.id + "/export");
    const restored = await f.call(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    await f.restart();
    const disk = await f.app.store.get(restored.id);
    assert.deepEqual(disk.settings, backup.settings);
    assert.deepEqual(
      disk.plans[0].steps.map((s) => s.request.auth),
      plan.steps.map((s) => s.request.auth),
    );
    const replay = await f.call("/api/projects/" + disk.id + "/run", "POST", {
      planId: disk.plans[0].id,
    });
    assert.equal(
      replay.status,
      "passed",
      JSON.stringify({ replay, errors: f.errors }),
    );
    assert.equal(f.seen.length, 10);
    await cliRun(f, disk.id, disk.plans[0].id);
    assert.equal(f.seen.length, 15);
    assert.deepEqual(f.errors, []);
  },
);
