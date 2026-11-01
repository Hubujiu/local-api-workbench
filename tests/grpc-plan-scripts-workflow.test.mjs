// CI-only: real production VM, official grpc-js fixtures, HTTP/MCP and CLI entrypoints.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { executeGrpc } from "../src/grpc.mjs";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";
const file = new URL("./fixtures/grpc.proto", import.meta.url),
  proto = await readFile(file, "utf8");
async function fixture(t) {
  const server = new grpc.Server(),
    seen = [];
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(file), {
      longs: String,
      bytes: String,
      defaults: true,
      keepCase: true,
    }),
  );
  server.addService(pkg.fixture.Echo.service, {
    Unary(call, done) {
      seen.push([call.request]);
      done(null, call.request);
    },
    Watch(call) {
      seen.push([call.request]);
      call.write(call.request);
      call.write({ ...call.request, text: call.request.text + "-2" });
      call.end();
    },
    Collect(call, done) {
      const messages = [];
      call.on("data", (message) => messages.push(message));
      call.on("end", () => {
        seen.push(messages);
        done(null, {
          ...messages[0],
          text: messages.map((message) => message.text).join("|"),
        });
      });
    },
    Chat(call) {
      const messages = [];
      call.on("data", (message) => {
        messages.push(message);
        call.write(message);
      });
      call.on("end", () => {
        seen.push(messages);
        call.end();
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  t.after(() => server.forceShutdown());
  return {
    seen,
    definition: {
      id: "echo",
      name: "Echo",
      target: `grpc://127.0.0.1:${port}`,
      proto,
      service: "fixture.Echo",
      method: "Unary",
      timeoutMs: 3000,
    },
  };
}
const scripted = (definition, messages = [{ text: "{{prefix}}" }]) => ({
  id: "rpc",
  type: "grpc",
  grpc: { definition, messages },
  grpcScripts: {
    version: 1,
    before:
      "apt.setVar('prefix','native');pm.variables.set('local','same-step');console.log('before-native');",
    after:
      "pm.test('wire',()=>{pm.expect(grpc.result.status.code).to.equal(0);pm.expect(pm.response).to.equal(undefined);pm.expect(pm.variables.get('local')).to.equal('same-step');});apt.setVar('reply',grpc.result.messages[0].text);console.log('after-native');",
  },
});
test("native scripts preserve real unary/server/client/bidirectional message evidence and scalar precision", async (t) => {
  const f = await fixture(t);
  for (const method of ["Unary", "Watch", "Collect", "Chat"]) {
    const messages = [
      { text: "{{prefix}}", big: "9223372036854775807", blob: "AQID" },
    ];
    if (["Collect", "Chat"].includes(method))
      messages.push({
        text: "second",
        big: "-9223372036854775808",
        blob: "BAU=",
      });
    const run = await runPlan(
      snapshotPlan({
        steps: [scripted({ ...f.definition, method }, messages)],
      }),
      {},
      () => {
        throw Error("no HTTP");
      },
      { executeGrpc },
    );
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.results[0].grpcResult.status.code, 0);
    assert.equal(
      run.results[0].grpcResult.messages.length,
      ["Watch", "Chat"].includes(method) ? 2 : 1,
    );
    assert.equal(
      run.results[0].grpcResult.messages[0].big,
      "9223372036854775807",
    );
    assert.equal(run.results[0].grpcResult.messages[0].blob, "AQID");
    assert.equal(
      run.variables.reply,
      method === "Collect" ? "native|second" : "native",
    );
  }
  assert.equal(f.seen.length, 4);
});
test("owner HTTP, both MCP flow aliases and CLI retain frozen scripts and independently persisted evidence", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "grpc-script-workflow-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("native scripts");
  project.settings.grpcDefinitions = [f.definition];
  await app.store.save(project);
  const base = app.url + "/api/projects/" + project.id;
  const post = async (action, body) => {
    const response = await fetch(base + "/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const configured = scripted(f.definition);
  configured.grpc = {
    definitionId: "echo",
    messages: [{ text: "{{prefix}}" }],
  };
  const plan = await post("plans", { name: "scripted", steps: [configured] });
  assert.deepEqual(plan.steps[0].grpcScripts, configured.grpcScripts);
  const owned = await post("run", { planId: plan.id });
  assert.equal(owned.status, "passed", JSON.stringify(owned));
  assert.equal(owned.recordSaved, true);
  const changed = await app.store.get(project.id);
  changed.settings.grpcDefinitions = [];
  await app.store.save(changed);
  const runner = createMCP({
    store: app.store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  for (const name of ["localapi_execute_flow", "localapi_run_plan"]) {
    const response = await runner({
      id: 1,
      method: "tools/call",
      params: { name, arguments: { projectId: project.id, planId: plan.id } },
    });
    assert.notEqual(response.result.isError, true, JSON.stringify(response));
    const report = JSON.parse(response.result.content[0].text);
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.recordSaved, true);
    assert.equal(report.results[0].grpcResult.messages[0].text, "native");
  }
  const child = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
      "--project",
      project.id,
      "--plan",
      plan.id,
    ],
    {
      env: { ...process.env, LOCAL_API_DATA: root },
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const cli = JSON.parse(child.stdout);
  assert.equal(cli.status, "passed", JSON.stringify(cli));
  assert.equal(cli.recordSaved, true);
  const reloaded = await new Store(root).get(project.id);
  assert.equal(reloaded.runs.length, 4);
  assert.equal(reloaded.runs[0].source, "cli");
  const restored = restoreProject({ ...reloaded, version: 1 });
  assert.deepEqual(
    restored.plans[0].steps[0].grpcScripts,
    configured.grpcScripts,
  );
  assert.deepEqual(
    restored.runs[0].snapshot.steps[0].grpcScripts,
    configured.grpcScripts,
  );
  assert.equal(
    f.seen.length,
    4,
    "reads, restore and definition deletion must not execute",
  );
});
test("scripted RPC history-save failure returns actual phase evidence without replay", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "grpc-script-save-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    project = await store.create("save failure");
  project.plans = [snapshotPlan({ steps: [scripted(f.definition)] })];
  await store.save(project);
  const append = store.append.bind(store);
  store.append = async (...args) => {
    if (args[1] === "runs") throw Error("fixture storage failure");
    return append(...args);
  };
  const runner = createMCP({
    store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  const response = await runner({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_execute_flow",
      arguments: { projectId: project.id, planId: project.plans[0].id },
    },
  });
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  const report = JSON.parse(response.result.content[0].text);
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.recordSaved, false);
  assert.equal(report.persistenceOutcome.code, "RECORD_SAVE_FAILED");
  assert.equal(report.results[0].grpcResult.messages[0].text, "native");
  assert.deepEqual(
    report.results[0].logs
      .filter((log) => ["before", "after"].includes(log.phase))
      .map((log) => log.message),
    ["before-native", "after-native"],
  );
  assert.equal(f.seen.length, 1);
});
