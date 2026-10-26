// PR28 API-local task roundtrip, through existing public entrypoints only.
// There is no native export/import MCP tool: authenticated HTTP does those two
// operations; the official SDK creates/executes plans and reads saved evidence.
// Native formats do NOT export these executable plans. We create the plan only
// after reimport; project backup (not native export) preserves it for restart.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  enabled,
  data,
});
function sourceFor(base) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  const login = source.apis[1];
  login.name = "Login";
  login.url = base + "/login";
  login.request.header.parameter = [];
  login.request.query.parameter = [];
  login.request.pre_tasks = [
    task("before-prefix", "customScript", 'const prefix="pre:";'),
    task("before-wait", "wait", 10),
    task(
      "before-use",
      "customScript",
      'pm.environment.set("beforeProof",prefix+"literal {{token}}");pm.environment.set("beforeRuns",(pm.environment.get("beforeRuns")||0)+1);',
    ),
    task("disabled-wait", "wait", "{{MUST_REMAIN_LITERAL}}", 0),
  ];
  login.request.post_tasks = [
    task("post-prefix", "customScript", 'const prefix="post:";'),
    task("post-wait", "wait", 10),
    task("extract", "pickVars", {
      source: "responseJson",
      variables: [
        { name: "token", expression: "$.token", type: "envVars" },
        { name: "localToken", expression: "$.token", type: "tempVars" },
        { name: "globalProof", expression: "$.token", type: "globalVars" },
      ],
    }),
    task("business", "assert", {
      type: "responseJson",
      expression: { path: "$.ok", compareType: "eq", compareValue: "true" },
    }),
    task(
      "post-use",
      "customScript",
      'pm.environment.set("postProof",prefix+pm.variables.get("localToken"));pm.test("same lexical phase",()=>pm.expect(pm.variables.get("localToken")).to.equal(pm.environment.get("token")));',
    ),
    task(
      "disabled-script",
      "customScript",
      'throw Error("disabled {{token}} must not run")',
      -1,
    ),
  ];
  const resource = structuredClone(login);
  resource.target_id = "resource";
  resource.name = "Resource";
  resource.url = base + "/resource";
  resource.request.pre_tasks = [];
  resource.request.post_tasks = [];
  resource.request.auth = { type: "bearer", bearer: { key: "{{token}}" } };
  source.apis.push(resource);
  return source;
}
const comparableTasks = (pipeline) => ({
  ...pipeline,
  before: pipeline.before.map(({ id, ...item }) => item),
  after: pipeline.after.map(({ id, ...item }) => item),
});
function decode(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-export-entry-")),
    events = [],
    clients = [];
  let mode = "ok",
    counter = 0;
  const upstream = http.createServer((request, response) => {
    events.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(
      request.url === "/login"
        ? JSON.stringify({
            ...(mode === "missing"
              ? {}
              : { token: "fictional-token-" + ++counter }),
            ok: mode !== "business-false",
          })
        : JSON.stringify({ auth: request.headers.authorization }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    events,
    base: `http://127.0.0.1:${upstream.address().port}`,
    call,
    get app() {
      return app;
    },
    setMode(value) {
      mode = value;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async importProject(document) {
      const created = await call("/api/projects", {
        name: "Task roundtrip fixture",
      });
      assert.equal(created.status, 201);
      const imported = await call(`/api/projects/${created.value.id}/import`, {
        document,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported));
      return imported.value;
    },
    async connect(project) {
      const config = await call("/api/mcp/config", {
        enabled: true,
        projects: [project.id],
        write: true,
        execute: true,
        remember: false,
      });
      assert.equal(config.status, 200);
      const client = new Client({ name: "native-export-entry", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + config.value.token },
          },
        }),
      );
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [
        "localapi_get_api_detail",
        "localapi_create_execution_flow",
        "localapi_execute_flow",
        "localapi_get_run",
      ])
        assert(names.includes(name), name);
      return client;
    },
  };
}
function cli(f, project, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        project.id,
        "--plan",
        planId,
        "--environment",
        project.environments[0].id,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    // Preserve multibyte JSON/error text across arbitrary OS pipe chunks.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("native export CLI fixture exceeded 15s");
      child.kill();
    }, 15000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI fixture output exceeds 2MiB");
        child.kill();
      }
    });
    child.stderr.on("data", (bytes) => {
      stderr = (stderr + bytes).slice(-16000);
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
async function mcpRun(client, project, planId) {
  return decode(
    await client.callTool({
      name: "localapi_execute_flow",
      arguments: {
        projectId: project.id,
        planId,
        environmentId: project.environments[0].id,
      },
    }),
  );
}
async function savedRun(f, project, run, source) {
  assert.equal(run.recordSaved, true);
  const saved = await new Store(f.root).get(project.id),
    evidence = saved.runs.find((item) => item.id === run.id);
  assert.ok(evidence);
  assert.equal(evidence.source, source);
  assert.equal(evidence.status, run.status);
  assert.deepEqual(evidence.results, run.results);
  return saved;
}
async function successful(f, project, run, source, start, frozen) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.deepEqual(
    run.results.map((item) => item.status),
    ["passed", "passed"],
  );
  assert.deepEqual(
    f.events.slice(start).map((item) => item.path),
    ["/login", "/resource"],
  );
  const token = JSON.parse(run.results[0].response.body).token;
  assert.equal(f.events.at(-1).auth, "Bearer " + token);
  const saved = await savedRun(f, project, run, source),
    env = saved.environments[0].variables;
  assert.equal(env.token, token);
  assert.equal(env.postProof, "post:" + token);
  assert.equal(saved.globalVariables.globalProof, token);
  assert.equal(env.beforeProof, "pre:literal {{token}}");
  assert.equal(env.localToken, undefined);
  assert.deepEqual(run.snapshot.steps[0].request.nativeTasks, frozen);
  return token;
}
async function failed(f, project, run, source, start, before, error) {
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 1);
  assert.match(run.results[0].error, error);
  assert.equal(run.results[0].response.status, 200);
  assert.deepEqual(
    f.events.slice(start).map((item) => item.path),
    ["/login"],
    "failed post stage must not send a stale-token followup",
  );
  const saved = await savedRun(f, project, run, source),
    vars = saved.environments[0].variables,
    old = before.environments[0].variables;
  for (const name of ["token", "postProof"])
    assert.equal(vars[name], old[name]);
  assert.equal(
    saved.globalVariables.globalProof,
    before.globalVariables.globalProof,
  );
  assert.equal(
    vars.beforeRuns,
    old.beforeRuns + 1,
    "already committed before-stage work is not rolled back",
  );
  assert.equal(vars.localToken, undefined);
}
for (const format of ["apipost", "apipost-directory"])
  test(
    `native task ${format} roundtrip reaches official MCP and true CLI with failure evidence, project isolation and backup restart`,
    { timeout: 40000 },
    async (t) => {
      const f = await fixture(t),
        document = sourceFor(f.base),
        untouchedDocument = structuredClone(document),
        original = await f.importProject(document);
      original.environments[0].variables = {
        token: "original-stale",
        postProof: "original-proof",
        beforeRuns: 0,
      };
      original.globalVariables.globalProof = "original-global";
      await f.app.store.save(original);
      const originalBefore = await new Store(f.root).get(original.id),
        eventCount = f.events.length;
      const exported = await f.call(
        `/api/projects/${original.id}/export?format=${format}`,
        undefined,
        "GET",
      );
      assert.equal(exported.status, 200, JSON.stringify(exported));
      const copy = await f.importProject(exported.value);
      assert.notEqual(copy.id, original.id);
      assert.equal(f.events.length, eventCount);
      assert.deepEqual(
        comparableTasks(copy.requests[0].nativeTasks),
        comparableTasks(original.requests[0].nativeTasks),
      );
      assert.deepEqual(
        await new Store(f.root).get(original.id),
        originalBefore,
      );
      const client = await f.connect(copy),
        details = [];
      for (const api of copy.requests)
        details.push(
          decode(
            await client.callTool({
              name: "localapi_get_api_detail",
              arguments: { projectId: copy.id, apiId: api.id },
            }),
          ),
        );
      const login = details.find((api) => api.name === "Login"),
        resource = details.find((api) => api.name === "Resource");
      assert.ok(login);
      assert.ok(resource);
      const frozen = structuredClone(login.nativeTasks);
      const plan = decode(
        await client.callTool({
          name: "localapi_create_execution_flow",
          arguments: {
            projectId: copy.id,
            plan: {
              id: "roundtrip-flow",
              name: "Reimported task flow",
              environmentId: copy.environments[0].id,
              steps: [{ request: login }, { request: resource }],
            },
          },
        }),
      );
      assert.deepEqual(plan.steps[0].request.nativeTasks, frozen);
      const denied = await client.callTool({
        name: "localapi_get_api_detail",
        arguments: { projectId: original.id, apiId: original.requests[0].id },
      });
      assert.equal(denied.isError, true);
      assert.equal(f.events.length, eventCount);
      let start = f.events.length;
      const sdkRun = await mcpRun(client, copy, plan.id),
        sdkToken = await successful(f, copy, sdkRun, "mcp", start, frozen);
      const sdkEvidence = decode(
        await client.callTool({
          name: "localapi_get_run",
          arguments: { projectId: copy.id, runId: sdkRun.id },
        }),
      );
      assert.deepEqual(sdkEvidence.results, sdkRun.results);
      start = f.events.length;
      const cliOutput = await cli(f, copy, plan.id);
      assert.equal(cliOutput.code, 0, cliOutput.stdout + cliOutput.stderr);
      assert.equal(cliOutput.signal, null);
      const cliRun = JSON.parse(cliOutput.stdout),
        cliToken = await successful(f, copy, cliRun, "cli", start, frozen);
      assert.notEqual(
        cliToken,
        sdkToken,
        "reimported tasks must extract fresh responses, not saved values",
      );
      f.setMode("missing");
      start = f.events.length;
      const beforeMissing = await new Store(f.root).get(copy.id),
        missing = await mcpRun(client, copy, plan.id);
      await failed(f, copy, missing, "mcp", start, beforeMissing, /路径不存在/);
      f.setMode("business-false");
      start = f.events.length;
      const beforeFalse = await new Store(f.root).get(copy.id),
        failedOutput = await cli(f, copy, plan.id);
      assert.equal(
        failedOutput.code,
        1,
        failedOutput.stdout + failedOutput.stderr,
      );
      assert.equal(failedOutput.signal, null);
      const business = JSON.parse(failedOutput.stdout);
      await failed(f, copy, business, "cli", start, beforeFalse, /断言/);
      assert.equal(
        business.results[0].assertions.find((item) => item.name === "business")
          ?.passed,
        false,
      );
      assert.deepEqual(
        await new Store(f.root).get(original.id),
        originalBefore,
      );
      assert.deepEqual(document, untouchedDocument);
      const beforeBackup = await new Store(f.root).get(copy.id),
        backup = await f.call(
          `/api/projects/${copy.id}/export`,
          undefined,
          "GET",
        );
      assert.equal(backup.status, 200);
      const restoredResponse = await f.call("/api/restore", {
        document: backup.value,
      });
      assert.equal(
        restoredResponse.status,
        201,
        JSON.stringify(restoredResponse),
      );
      const restored = restoredResponse.value;
      assert.notEqual(restored.id, copy.id);
      assert.deepEqual(
        restored.requests[0].nativeTasks,
        copy.requests[0].nativeTasks,
      );
      const count = f.events.length;
      await f.restart();
      assert.equal(
        f.events.length,
        count,
        "backup/restart must not replay requests",
      );
      for (const project of [copy, restored]) {
        const saved = await new Store(f.root).get(project.id);
        for (const run of [sdkRun, cliRun, missing, business]) {
          const evidence = saved.runs.find((item) => item.id === run.id);
          assert.equal(evidence.status, run.status);
          assert.deepEqual(evidence.results, run.results);
        }
      }
      const restartedClient = await f.connect(restored);
      const restoredFailure = decode(
        await restartedClient.callTool({
          name: "localapi_get_run",
          arguments: { projectId: restored.id, runId: business.id },
        }),
      );
      assert.equal(restoredFailure.status, "failed");
      f.setMode("ok");
      start = f.events.length;
      const replayOutput = await cli(f, restored, plan.id);
      assert.equal(
        replayOutput.code,
        0,
        replayOutput.stdout + replayOutput.stderr,
      );
      assert.equal(replayOutput.signal, null);
      const fresh = await successful(
        f,
        restored,
        JSON.parse(replayOutput.stdout),
        "cli",
        start,
        frozen,
      );
      assert.notEqual(fresh, cliToken);
      assert.deepEqual(
        await new Store(f.root).get(copy.id),
        beforeBackup,
        "running restored project cannot mutate source copy",
      );
      assert.deepEqual(
        await new Store(f.root).get(original.id),
        originalBefore,
      );
    },
  );
