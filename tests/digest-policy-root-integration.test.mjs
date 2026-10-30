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
import { normalizeRequest, runPlan } from "../src/core.mjs";

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
    await app.close();
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

async function cliRun(f, projectId, planId, expectedStatus = "passed") {
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
  assert.equal(cli.code, expectedStatus === "passed" ? 0 : 1, cli.errors);
  assert.equal(JSON.parse(cli.output).status, expectedStatus);
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

const repeat = (id, count, steps, enabled = true) => ({
  id,
  type: "repeat",
  count,
  enabled,
  steps,
});
function digestRequest(url, extra = {}) {
  return normalizeRequest({
    id: "digest",
    name: "Digest root policy",
    url,
    auth: {
      type: "digest",
      username: "{{digestUser}}",
      password: "{{digestPassword}}",
      challengePolicy: { algorithm: "SHA-256", retry: true },
    },
    inheritAuth: false,
    ...extra,
  });
}
async function project(f) {
  const p = await f.app.store.create("Digest root integration");
  for (const environment of p.environments)
    Object.assign(environment.variables, {
      digestUser: credentials.username,
      digestPassword: credentials.password,
      selectedAlgorithm: "SHA-256",
    });
  await f.call("/api/projects/" + p.id, "PUT", p);
  return f.app.store.get(p.id);
}
async function sdk(f, p) {
  const config = await f.call("/api/mcp/config", "POST", {
    enabled: true,
    projects: [p.id],
    write: true,
    execute: true,
    remember: false,
  });
  const client = new Client(
    { name: "digest-root-policy", version: "1" },
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
  const names = new Set(
    (await client.listTools()).tools.map((tool) => tool.name),
  );
  for (const name of [
    "localapi_execute_api",
    "localapi_run_plan",
    "apipost_execute_api",
    "apipost_execute_flow",
  ])
    assert(names.has(name), name);
  return client;
}

test(
  "root nested repeats execute static Digest policy with templated credentials and fresh challenges; disabled ancestor sends no child HTTP",
  { timeout: 30000 },
  async (t) => {
    const f = await owner(t, destination()),
      p = await project(f);
    const request = digestRequest(f.url + "/SHA-256");
    p.requests = [request];
    await f.call("/api/projects/" + p.id, "PUT", p);
    const plan = await f.call("/api/projects/" + p.id + "/plans", "POST", {
      name: "Nested Digest",
      statusPolicy: "strict200",
      steps: [
        repeat("outer", 2, [repeat("inner", 2, [{ id: "leaf", request }])]),
        repeat(
          "disabled",
          3,
          [
            repeat("disabled-inner", 2, [
              {
                id: "never",
                request: { ...request, url: f.url + "/must-not-run" },
              },
            ]),
          ],
          false,
        ),
      ],
    });
    const run = await f.call("/api/projects/" + p.id + "/run", "POST", {
      planId: plan.id,
    });
    assert.equal(
      run.status,
      "passed",
      JSON.stringify({ run, errors: f.errors }),
    );
    assert.equal(f.seen.length, 8);
    assert(f.seen.every((url) => url === "/SHA-256"));
    const client = await sdk(f, p);
    const canonical = await client.callTool({
      name: "localapi_run_plan",
      arguments: { projectId: p.id, planId: plan.id },
    });
    assert.notEqual(canonical.isError, true, JSON.stringify(canonical));
    assert.equal(JSON.parse(canonical.content[0].text).status, "passed");
    assert.equal(f.seen.length, 16);
    // Native flow projection historically excludes canonical repeat nodes.
    const native = await client.callTool({
      name: "apipost_execute_flow",
      arguments: { project_id: p.id, flow_id: plan.id },
    });
    assert.equal(native.isError, true);
    assert.equal(f.seen.length, 16);
    await client.close();
    await cliRun(f, p.id, plan.id);
    assert.equal(f.seen.length, 24);
    assert(f.seen.every((url) => url === "/SHA-256"));
    assert.deepEqual(f.errors, []);
  },
);

test(
  "root deeply invalid raw static policy preflights before earlier executor/script effects; owner refuses storing it atomically",
  { timeout: 20000 },
  async (t) => {
    const f = await owner(t, () =>
        assert.fail("invalid root plan performed HTTP"),
      ),
      p = await project(f);
    const first = normalizeRequest({
      id: "first",
      url: f.url + "/first",
      beforeScript:
        "pm.sendRequest(" +
        JSON.stringify(f.url + "/script") +
        ',()=>{});pm.environment.set("forbidden","ran");',
    });
    const bad = {
      ...digestRequest(f.url + "/bad"),
      auth: {
        type: "digest",
        ...credentials,
        challengePolicy: { algorithm: "{{selectedAlgorithm}}", retry: true },
      },
    };
    const raw = {
      id: "raw-plan",
      name: "Deep invalid policy",
      steps: [
        { id: "first", request: first },
        repeat("outer", 2, [
          repeat("middle", 2, [
            repeat("inner", 2, [{ id: "bad", request: bad }]),
          ]),
        ]),
      ],
    };
    let executeCalls = 0,
      prepared = 0,
      scopeWrites = 0,
      steps = 0,
      dbCalls = 0;
    await assert.rejects(
      () =>
        runPlan(
          raw,
          { selectedAlgorithm: "SHA-256" },
          async () => {
            executeCalls++;
            return { status: 200, body: "{}", headers: {} };
          },
          {
            prepareRequest: (request) => {
              prepared++;
              return request;
            },
            onScopeChanges: () => {
              scopeWrites++;
            },
            onStep: () => {
              steps++;
            },
            databaseQuery: () => {
              dbCalls++;
            },
          },
        ),
      /Digest|challengePolicy/,
    );
    assert.deepEqual(
      { executeCalls, prepared, scopeWrites, steps, dbCalls },
      { executeCalls: 0, prepared: 0, scopeWrites: 0, steps: 0, dbCalls: 0 },
    );
    const before = await f.app.store.get(p.id);
    await f.call("/api/projects/" + p.id + "/plans", "POST", raw, 400);
    assert.deepEqual(await f.app.store.get(p.id), before);
    assert.deepEqual(f.seen, []);
    assert.deepEqual(f.errors, []);
  },
);

for (const retry of [true, false])
  test(
    `root Digest retry=${retry} with opt-in redirect remains unsupported across owner SDK and CLI with zero target HTTP`,
    { timeout: 30000 },
    async (t) => {
      const f = await owner(t, () =>
          assert.fail("Digest redirect must be rejected before target HTTP"),
        ),
        p = await project(f);
      const request = digestRequest(f.url + "/redirect", {
        redirect: { mode: "same-origin" },
        auth: {
          type: "digest",
          ...credentials,
          challengePolicy: { algorithm: "SHA-256", retry },
        },
      });
      p.requests = [request];
      await f.call("/api/projects/" + p.id, "PUT", p);
      const plan = await f.call("/api/projects/" + p.id + "/plans", "POST", {
        name: "Unsupported Digest redirect",
        steps: [{ id: "leaf", request }],
      });
      const ownerResult = await f.call(
        "/api/projects/" + p.id + "/execute",
        "POST",
        { request },
      );
      assert.equal(ownerResult.outcome, "failed");
      assert.match(ownerResult.error, /redirect/);
      const ownerRun = await f.call("/api/projects/" + p.id + "/run", "POST", {
        planId: plan.id,
      });
      assert.equal(ownerRun.status, "failed");
      const client = await sdk(f, p);
      for (const [name, args] of [
        ["localapi_execute_api", { projectId: p.id, apiId: request.id }],
        ["apipost_execute_api", { project_id: p.id, target_id: request.id }],
        ["localapi_run_plan", { projectId: p.id, planId: plan.id }],
        ["apipost_execute_flow", { project_id: p.id, flow_id: plan.id }],
      ]) {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.equal(JSON.parse(result.content[0].text).status, "failed");
      }
      await client.close();
      await cliRun(f, p.id, plan.id, "failed");
      assert.deepEqual(f.seen, []);
      assert.deepEqual(f.errors, []);
    },
  );
