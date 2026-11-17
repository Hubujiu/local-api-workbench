import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { executeRequest } from "../src/runtime.mjs";
import { createApp as createOwnerApp } from "../src/server.mjs";
import { normalizeRequest, snapshotPlan, runPlan } from "../src/core.mjs";
const secret = "root-oauth2-token";
const auth = (scope) => ({
  type: "oauth2",
  nativeOAuth2: {
    addTokenTo: scope === "folder" ? "header" : "queryParams",
    access_token: secret,
    headerPrefix: "Custom",
    clientSecret: "{{unused-grant-secret}}",
    state: "{{$randomUUID}}",
    authRequestParams: [{ param_id: "kept", nested: { value: "{{unused}}" } }],
  },
});
function graph(requests, enabled = true) {
  return [
    {
      type: "repeat",
      id: "outer",
      name: "Outer",
      count: 2,
      enabled,
      steps: [
        {
          type: "repeat",
          id: "inner",
          name: "Inner",
          count: 2,
          steps: requests.map((request, index) => ({
            id: "leaf-" + index,
            request,
          })),
        },
      ],
    },
  ];
}
async function fixture(t, { holdAt = 0 } = {}) {
  const seen = [],
    errors = [];
  let arrive;
  const arrived = new Promise((resolve) => (arrive = resolve));
  const peer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bytes = Buffer.concat(chunks),
        path = new URL(req.url, "http://fixture").pathname,
        scope = path.slice(1),
        bodyType = scope === "folder" ? "json" : "none";
      seen.push(path);
      assert(["global", "folder"].includes(scope));
      assert.equal(req.method, scope === "folder" ? "POST" : "GET");
      assert.equal(
        req.headers.authorization,
        scope === "folder" ? "Custom " + secret : undefined,
      );
      assert.equal(
        new URL(req.url, "http://fixture").search,
        "?dup=1&dup=2" + (scope === "global" ? "&access_token=" + secret : ""),
      );
      assert.deepEqual(
        bytes,
        Buffer.from(scope === "folder" ? '{"nested":"雪"}' : ""),
      );
      if (seen.length === holdAt) {
        arrive();
        await new Promise((resolve) => res.once("close", resolve));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    } catch (error) {
      errors.push(error.message);
      res.statusCode = 401;
      res.end("independent verification failed");
    }
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "oauth2-policy-root-"));
  let app = await createOwnerApp({ root, port: 0 });
  const clients = [];
  const stop = async () => {
    app.server.closeAllConnections();
    await app.close();
  };
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function call(route, data, method = "POST", status = 200) {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const project = await app.store.create("Root nested OAuth2");
  for (const env of project.environments) env.variables.oauthSecret = secret;
  project.settings.globalAuth = {
    ...auth("global"),
    nativeOAuth2: {
      ...auth("global").nativeOAuth2,
      access_token: "{{oauthSecret}}",
    },
  };
  project.settings.folderAuth = {
    Nested: {
      ...auth("folder"),
      nativeOAuth2: {
        ...auth("folder").nativeOAuth2,
        access_token: "{{oauthSecret}}",
      },
    },
  };
  const requests = [
    normalizeRequest({
      url: "http://127.0.0.1:" + peer.address().port + "/global?dup=1&dup=2",
      auth: { type: "none" },
    }),
    normalizeRequest({
      url: "http://127.0.0.1:" + peer.address().port + "/folder?dup=1&dup=2",
      folder: "Nested",
      method: "POST",
      bodyType: "json",
      body: '{"nested":"雪"}',
      auth: { type: "none" },
    }),
  ];
  project.requests = requests;
  await call("/api/projects/" + project.id, project, "PUT");
  const plan = await call("/api/projects/" + project.id + "/plans", {
    name: "Nested policy",
    environmentId: project.environments[0].id,
    statusPolicy: "strict200",
    steps: graph(requests),
  });
  return {
    root,
    call,
    project,
    plan,
    seen,
    errors,
    arrived,
    get app() {
      return app;
    },
    async restart() {
      await stop();
      app = await createOwnerApp({ root, port: 0 });
    },
    async stdio(projectId) {
      const client = new Client(
          { name: "oauth2-root-stdio", version: "1" },
          { capabilities: {} },
        ),
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            "--write",
            "--execute",
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
      transport.stderr.resume();
      clients.push(client);
      await client.connect(transport);
      return client;
    },
  };
}
test(
  "root OAuth2 nested shared policies freeze across live edits, restore/restart and actual stdio SDK execution",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      frozen = structuredClone(f.plan.steps),
      live = await f.app.store.get(f.project.id);
    const leaves = f.plan.steps[0].steps[0].steps;
    assert.deepEqual(
      leaves.map((s) => s.request.auth.nativeOAuth2.addTokenTo),
      ["queryParams", "header"],
    );
    assert(leaves.every((step) => step.request.authSnapshot === true));
    assert.deepEqual(
      leaves.map((step) => step.request.auth),
      [f.project.settings.globalAuth, f.project.settings.folderAuth.Nested],
    );
    live.settings.globalAuth.nativeOAuth2.access_token = "wrong-live-global";
    live.settings.folderAuth.Nested.nativeOAuth2.access_token =
      "wrong-live-folder";
    await f.call("/api/projects/" + live.id, live, "PUT");
    const run = await f.call("/api/projects/" + live.id + "/run", {
      planId: f.plan.id,
    });
    assert.equal(
      run.status,
      "passed",
      JSON.stringify({ run, errors: f.errors }),
    );
    assert.equal(run.recordSaved, true);
    assert.equal(f.seen.length, 8);
    const backup = await f.call(
        "/api/projects/" + live.id + "/export",
        undefined,
        "GET",
      ),
      restored = await f.call(
        "/api/restore",
        { document: backup },
        "POST",
        201,
      );
    await f.restart();
    const disk = await f.app.store.get(restored.id);
    assert.deepEqual(disk.plans[0].steps, frozen);
    const replay = await f.call("/api/projects/" + disk.id + "/run", {
      planId: disk.plans[0].id,
    });
    assert.equal(
      replay.status,
      "passed",
      JSON.stringify({ replay, errors: f.errors }),
    );
    assert.equal(f.seen.length, 16);
    const foreign = await f.app.store.create("Foreign OAuth2 root");
    foreign.requests = [
      normalizeRequest({
        id: "foreign",
        url: "http://127.0.0.1:1",
        auth: auth("global"),
      }),
    ];
    await f.app.store.save(foreign);
    const foreignBefore = await f.app.store.get(foreign.id);
    const client = await f.stdio(disk.id),
      tools = new Set(
        (await client.listTools()).tools.map((tool) => tool.name),
      );
    assert(tools.has("localapi_run_plan"));
    const result = await client.callTool({
      name: "localapi_run_plan",
      arguments: { projectId: disk.id, planId: disk.plans[0].id },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).status, "passed");
    assert.equal(f.seen.length, 24);
    const denied = await client.callTool({
      name: "localapi_execute_api",
      arguments: { projectId: foreign.id, apiId: "foreign" },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /项目未授权/);
    await client.close();
    await f.restart();
    const final = await f.app.store.get(disk.id);
    assert.deepEqual(final.plans[0].steps, frozen);
    assert.equal(final.runs.length, 3);
    assert(final.runs.every((r) => r.status === "passed"));
    assert.deepEqual(await f.app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(f.errors, []);
  },
);
test(
  "root OAuth2 nested cancellation stops after the third actual token request",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { holdAt: 3 }),
      pending = f.call("/api/projects/" + f.project.id + "/run", {
        planId: f.plan.id,
        runId: "root-oauth2-cancel",
      });
    const early = await Promise.race([
      f.arrived.then(() => ({ arrived: true })),
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
    await f.call("/api/cancel", { id: "root-oauth2-cancel" });
    const run = await pending;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.equal(f.seen.length, 3);
    assert.equal(run.results.length, 3);
    await f.restart();
    const saved = (await f.app.store.get(f.project.id)).runs.find(
      (item) => item.id === run.id,
    );
    assert(saved);
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.results.length, 3);
    assert.deepEqual(f.errors, []);
  },
);
test("root OAuth2 nested admission rejects malformed policy even beneath disabled groups before cloning or work", async () => {
  let reads = 0,
    executes = 0,
    prepares = 0;
  for (const enabled of [true, false]) {
    const request = {
        url: "https://fixture.invalid",
        auth: {
          ...auth("global"),
          nativeOAuth2: {
            ...auth("global").nativeOAuth2,
            addTokenTo: "{{placement}}",
          },
        },
      },
      plan = { steps: graph([request], enabled) };
    assert.throws(() => snapshotPlan(plan), /原生 OAuth2/);
    await assert.rejects(
      runPlan(
        plan,
        { placement: "header" },
        async () => {
          executes++;
        },
        {
          prepareRequest: () => {
            prepares++;
          },
        },
      ),
      /原生 OAuth2/,
    );
    const bad = auth("global");
    Object.defineProperty(bad.nativeOAuth2, "access_token", {
      enumerable: true,
      get() {
        reads++;
        return "must-not-read";
      },
    });
    const getterPlan = {
      steps: graph([{ url: "https://fixture.invalid", auth: bad }], enabled),
    };
    assert.throws(() => snapshotPlan(getterPlan), /循环计划.*访问器/);
    await assert.rejects(
      runPlan(getterPlan, {}, async () => {
        executes++;
      }),
      /循环计划.*访问器/,
    );
  }
  assert.equal(reads, 0);
  assert.equal(executes, 0);
  assert.equal(prepares, 0);
});
test("root OAuth2 explicit redirect remains refused before token transport for all policy placements", async (t) => {
  let received = 0;
  const peer = http.createServer((req, res) => {
    received++;
    req.resume();
    res.end("must-not-send");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
  });
  for (const [placement, bodyType] of [
    ["header", "none"],
    ["queryParams", "json"],
    ["", "urlencoded"],
  ])
    await assert.rejects(
      executeRequest({
        url: "http://127.0.0.1:" + peer.address().port,
        method: bodyType === "none" ? "GET" : "POST",
        bodyType,
        body: bodyType === "json" ? "{}" : "",
        form: [{ key: "x", value: "1" }],
        auth: {
          ...auth("global"),
          nativeOAuth2: {
            ...auth("global").nativeOAuth2,
            addTokenTo: placement,
          },
        },
        redirect: { mode: "same-origin", maxHops: 2 },
      }),
      /redirect 暂不支持此认证方式/,
    );
  assert.equal(received, 0);
});
