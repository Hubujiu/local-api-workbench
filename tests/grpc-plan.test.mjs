import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { executeGrpc } from "../src/grpc.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";
const file = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(file, "utf8");
async function fixture(t) {
  const server = new grpc.Server();
  const seen = [];
  let started;
  const slowStarted = new Promise((resolve) => {
    started = resolve;
  });
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(file), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  );
  server.addService(pkg.fixture.Echo.service, {
    Unary(call, done) {
      seen.push(call.request);
      done(null, call.request);
    },
    Fail(call, done) {
      seen.push(call.request);
      done({ code: 7, details: "denied" });
    },
    Slow() {
      started();
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e, p) => (e ? reject(e) : resolve(p)),
    ),
  );
  t.after(() => server.forceShutdown());
  return {
    seen,
    slowStarted,
    definition: {
      id: "echo",
      name: "Echo",
      proto,
      target: `grpc://127.0.0.1:${port}`,
      service: "fixture.Echo",
      method: "Unary",
    },
  };
}
const step = (definition, extra = {}) => ({
  type: "grpc",
  name: "gRPC",
  grpc: { definition, messages: [{ text: "{{input}}" }] },
  ...extra,
});
test("gRPC plan freezes schema, executes real messages, extracts into following HTTP and keeps native status", async (t) => {
  const f = await fixture(t);
  let url;
  const httpServer = http.createServer((req, res) => {
    url = req.url;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const httpBase = `http://127.0.0.1:${httpServer.address().port}`;
  const plan = snapshotPlan({
    steps: [
      step(f.definition, { extract: [{ name: "reply", path: "$[0].text" }] }),
      { request: { url: httpBase + "/{{reply}}", method: "GET" } },
    ],
  });
  f.definition.target = "grpc://127.0.0.1:1";
  const run = await runPlan(plan, { input: "hello" }, executeRequest, {
    executeGrpc,
  });
  assert.equal(run.status, "passed");
  assert.equal(url, "/hello");
  assert.equal(run.results[0].grpcResult.status.code, 0);
  assert.equal(run.results[0].extracted.reply, "hello");
  assert.equal(f.seen.length, 1);
  assert.equal(run.results[0].response, undefined);
  const denied = await runPlan(
    snapshotPlan({
      steps: [step({ ...plan.steps[0].grpc.definition, method: "Fail" })],
    }),
    { input: "x" },
    () => {
      throw Error("HTTP must not run");
    },
    { executeGrpc },
  );
  assert.equal(denied.status, "failed");
  assert.equal(denied.results[0].grpcResult.status.code, 7);
});
test("gRPC plan refuses missing execution grant and unsupported saved credentials/scripts", async (t) => {
  const f = await fixture(t);
  const plan = snapshotPlan({ steps: [step(f.definition)] });
  const run = await runPlan(plan, { input: "x" }, () => {});
  assert.equal(run.status, "failed");
  assert.match(run.results[0].error, /授权/);
  assert.equal(f.seen.length, 0);
  for (const extra of [
    { beforeScript: "x" },
    {
      grpc: {
        definition: f.definition,
        messages: [{}],
        tls: { rejectUnauthorized: false },
      },
    },
  ])
    assert.throws(() => snapshotPlan({ steps: [step(f.definition, extra)] }));
});
test("MCP saves frozen gRPC plan, executes only with grant, reloads evidence and isolates projects", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(path.join(tmpdir(), "grpc-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const p = await store.create("gRPC");
  p.settings.grpcDefinitions = [f.definition];
  await store.save(p);
  const call = (name, args) => ({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_" + name,
      arguments: { projectId: p.id, ...args },
    },
  });
  const decode = (r) => {
    assert.notEqual(r.result.isError, true, JSON.stringify(r));
    return JSON.parse(r.result.content[0].text);
  };
  const writer = createMCP({ store, projects: [p.id], write: true });
  const saved = decode(
    await writer(
      call("save_plan", {
        plan: {
          name: "RPC",
          steps: [
            {
              type: "grpc",
              grpc: { definitionId: "echo", messages: [{ text: "persist" }] },
            },
          ],
        },
      }),
    ),
  );
  assert.equal(
    (await writer(call("execute_flow", { planId: saved.id }))).result.isError,
    true,
  );
  assert.equal(f.seen.length, 0);
  const runner = createMCP({
    store,
    projects: [p.id],
    write: true,
    execute: true,
  });
  const result = decode(
    await runner(call("execute_flow", { planId: saved.id })),
  );
  assert.equal(result.status, "passed");
  assert.equal(f.seen.length, 1);
  const reloaded = await new Store(root).get(p.id);
  assert.equal(
    reloaded.runs[0].results[0].grpcResult.messages[0].text,
    "persist",
  );
  assert.equal(reloaded.plans[0].steps[0].type, "grpc");
  const restored = restoreProject({ ...reloaded, version: 1 });
  assert.equal(
    restored.plans[0].steps[0].grpc.definition.target,
    f.definition.target,
  );
  assert.equal(
    restored.runs[0].results[0].grpcResult.messages[0].text,
    "persist",
  );
  const changed = await store.get(p.id);
  changed.settings.grpcDefinitions = [];
  await store.save(changed);
  const repeated = decode(
    await runner(call("execute_flow", { planId: saved.id })),
  );
  assert.equal(repeated.status, "passed");
  const foreign = await store.create("foreign");
  assert.equal(
    (
      await runner({
        id: 2,
        method: "tools/call",
        params: {
          name: "localapi_execute_flow",
          arguments: { projectId: foreign.id, planId: saved.id },
        },
      })
    ).result.isError,
    true,
  );
});

test("gRPC plan cancellation, failed extraction, assertion errors and concurrent variables stay truthful", async (t) => {
  const f = await fixture(t);
  const plan = snapshotPlan({
    steps: [
      step(f.definition, {
        extract: [{ name: "reply", path: "$[0].text" }],
        assertions: [{ target: "$[0].text", op: "eq", value: "one" }],
      }),
    ],
  });
  const [a, b] = await Promise.all(
    ["one", "two"].map((input) =>
      runPlan(plan, { input }, executeRequest, { executeGrpc }),
    ),
  );
  assert.equal(a.status, "passed");
  assert.equal(a.variables.reply, "one");
  assert.equal(b.status, "failed");
  assert.equal(b.variables.reply, undefined);
  const invalid = await runPlan(
    snapshotPlan({
      steps: [
        step(f.definition, {
          extract: [{ name: "missing", path: "$[0].absent" }],
        }),
      ],
    }),
    { input: "x" },
    executeRequest,
    { executeGrpc },
  );
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.results[0].grpcResult.status.code, 0);
  assert.match(invalid.results[0].error, /无法提取/);
  const controller = new AbortController();
  const pending = runPlan(
    snapshotPlan({
      steps: [step({ ...f.definition, method: "Slow", timeoutMs: 1000 })],
    }),
    { input: "x" },
    executeRequest,
    { executeGrpc, signal: controller.signal },
  );
  await f.slowStarted;
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.results[0].grpcResult.status.code, 1);
});

test("HTTP plan API freezes gRPC references, executes, persists and cancels through existing run endpoint", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const f = await fixture(t);
  const root = await mkdtemp(path.join(tmpdir(), "grpc-plan-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("plan");
  p.settings.grpcDefinitions = [f.definition];
  await app.store.save(p);
  const base = app.url + "/api/projects/" + p.id;
  const headers = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  const post = async (action, data) => {
    const response = await fetch(base + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const plan = await post("plans", {
    steps: [
      {
        type: "grpc",
        grpc: { definitionId: "echo", messages: [{ text: "api" }] },
        assertions: [{ target: "status", op: "eq", value: 0 }],
      },
    ],
  });
  const run = await post("run", { planId: plan.id, runId: "grpc-plan-api" });
  assert.equal(run.status, "passed");
  assert.equal(run.results[0].grpcResult.messages[0].text, "api");
  assert.equal((await new Store(root).get(p.id)).runs[0].id, run.id);
  const readOnly = createMCP({ store: app.store, projects: [p.id] });
  const list = await readOnly({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_list_grpc_definitions",
      arguments: { projectId: p.id },
    },
  });
  assert.notEqual(list.result.isError, true);
  assert.equal(JSON.parse(list.result.content[0].text)[0].id, "echo");
  const slow = await post("plans", {
    steps: [
      {
        type: "grpc",
        grpc: {
          definition: { ...f.definition, method: "Slow", timeoutMs: 3000 },
          messages: [{}],
        },
      },
    ],
  });
  const pending = post("run", { planId: slow.id, runId: "grpc-plan-slow" });
  await f.slowStarted;
  const duplicate = await fetch(base + "/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ planId: plan.id, runId: "grpc-plan-slow" }),
  });
  assert.equal(duplicate.ok, false);
  assert.match((await duplicate.json()).error, /正在使用/);
  const cancellation = await fetch(app.url + "/api/cancel", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "grpc-plan-slow" }),
  });
  assert.equal(cancellation.status, 200);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.results[0].grpcResult.status.code, 1);
  const next = await post("run", {
    planId: plan.id,
    runId: "grpc-plan-after-cancel",
  });
  assert.equal(next.status, "passed");
});

test("MCP plan persistence failure returns actual RPC evidence without retrying the operation", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(path.join(tmpdir(), "grpc-plan-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const p = await store.create("failure");
  p.plans = [snapshotPlan({ steps: [step(f.definition)] })];
  p.environments[0].variables.input = "once";
  await store.save(p);
  const originalAppend = store.append.bind(store);
  store.append = async (...args) => {
    if (args[1] === "runs") throw Error("fixture disk failure");
    return originalAppend(...args);
  };
  const d = createMCP({ store, projects: [p.id], write: true, execute: true });
  const response = await d({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_execute_flow",
      arguments: { projectId: p.id, planId: p.plans[0].id },
    },
  });
  assert.notEqual(response.result.isError, true);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, "passed");
  assert.equal(result.recordSaved, false);
  assert.match(result.persistenceError, /fixture disk failure/);
  assert.equal(result.results[0].grpcResult.messages[0].text, "once");
  assert.equal(f.seen.length, 1);
});

test("CLI executes the same frozen gRPC plan and persists independently readable evidence", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const f = await fixture(t);
  const root = await mkdtemp(path.join(tmpdir(), "grpc-plan-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const p = await store.create("cli");
  p.environments[0].variables.input = "command";
  p.plans = [snapshotPlan({ steps: [step(f.definition)] })];
  await store.save(p);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
      "--project",
      p.id,
      "--plan",
      p.plans[0].id,
    ],
    {
      env: { ...process.env, LOCAL_API_DATA: root },
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
  const run = JSON.parse(stdout);
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(run.results[0].grpcResult.messages[0].text, "command");
  assert.equal((await new Store(root).get(p.id)).runs[0].source, "cli");
  assert.equal(f.seen.length, 1);
});
test("gRPC plan validation refuses malformed extraction, ambiguous fields and invalid status before execution", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { extract: [{ name: "__proto__", path: "$" }] },
    { extract: [{ name: "x", path: "$[0].constructor" }] },
    { extract: [{ name: "x", path: "$[*]" }] },
    { extract: [{ name: "x", path: "$", scope: "local" }] },
    { assertions: [{ target: "$[*]", op: "exists" }] },
    { expectedStatus: 200 },
    { request: { url: "http://example.invalid" } },
  ])
    assert.throws(() => snapshotPlan({ steps: [step(f.definition, extra)] }));
  const expected = await runPlan(
    snapshotPlan({
      statusPolicy: "strict200",
      steps: [
        step(
          { ...f.definition, method: "Fail" },
          {
            expectedStatus: 7,
            assertions: [{ target: "status", op: "eq", value: 7 }],
          },
        ),
      ],
    }),
    { input: "x" },
    executeRequest,
    { executeGrpc },
  );
  assert.equal(expected.status, "passed");
  assert.equal(expected.results[0].grpcResult.status.code, 7);
});
