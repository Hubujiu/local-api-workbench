// CI-only composition, not a duplicate of the interactive transport/state matrix.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { assertNativeHTTPResult } from "../src/native-mcp-http-shape.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const secret = "root-session-explicit-credential";
const sourceSecret = "root-session-imported-secret-must-be-erased";
const metadata = [{ key: "authorization", value: secret }];
const credentials = { rpc: { metadata } };
const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
async function until(read, label) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const result = await read();
    if (result) return result;
    assert(Date.now() < deadline, "Timed out: " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function privateTransport(value) {
  const json = JSON.stringify(value);
  for (const forbidden of [
    secret,
    sourceSecret,
    "x-private-response",
    "x-private-trailer",
    "BEGIN PRIVATE KEY",
    "BEGIN CERTIFICATE",
  ])
    assert(!json.includes(forbidden), forbidden + " must not persist");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "grpc-sessions-root-"));
  const clients = [],
    calls = [],
    sockets = new Set();
  let app,
    proxy,
    rpc,
    connections = 0;
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    if (app) await app.close();
    for (const socket of sockets) socket.destroy();
    if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
    rpc?.forceShutdown();
    await rm(root, { recursive: true, force: true });
  });
  const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
  const proto = await readFile(protoFile, "utf8");
  rpc = new grpc.Server();
  const service = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      keepCase: true,
      longs: String,
      bytes: String,
      enums: String,
      defaults: true,
    }),
  ).fixture.Echo.service;
  const begin = (method, call) => {
    const row = {
      method,
      message: call.request,
      auth: call.metadata.get("authorization"),
      cancelled: false,
    };
    calls.push(row);
    call.on("cancelled", () => {
      row.cancelled = true;
    });
    const headers = new grpc.Metadata();
    headers.set("x-private-response", secret);
    call.sendMetadata(headers);
    return row;
  };
  rpc.addService(service, {
    Unary(call, done) {
      begin("Unary", call);
      if (call.request.text !== "held-script-plan") {
        const trailers = new grpc.Metadata();
        trailers.set("x-private-trailer", secret);
        done(null, call.request, trailers);
      }
    },
    Watch(call) {
      begin("Watch", call);
      call.write(call.request);
      // Keep the response direction active until owner cancellation/deadline.
    },
  });
  const port = await new Promise((resolve, reject) =>
    rpc.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  // Count real TCP admission, not only service handlers: missing credentials must
  // be rejected before even an HTTP/2 connection to the selected target exists.
  proxy = net.createServer((downstream) => {
    connections++;
    const upstream = net.connect({ host: "127.0.0.1", port });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        downstream.destroy();
        upstream.destroy();
      });
      socket.on("close", () => sockets.delete(socket));
    }
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const target = `127.0.0.1:${proxy.address().port}`;
  app = await createApp({ root, port: 0 });
  const owner = async (route, method = "GET", body, expected = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const nativeSource = (required) => {
    const source = extendedProtocolFixture({ grpc: target });
    source.apis = source.apis.filter((node) => node.target_type === "grpc");
    const entry = source.apis[0].protos[0];
    entry.proto_content = proto;
    entry.services[0].service_name = "fixture.Echo";
    for (const method of entry.services[0].methods) {
      method.url = target;
      method.request.message[0].raw = JSON.stringify({
        text: "imported",
        big: "9007199254740993",
        blob: "/wA=",
      });
      if (required)
        method.request.metadata.parameter = [
          { key: "authorization", value: sourceSecret },
        ];
    }
    return source;
  };
  return {
    root,
    calls,
    target,
    owner,
    get app() {
      return app;
    },
    get connections() {
      return connections;
    },
    async imported(required = true) {
      const project = await owner(
        "/api/projects",
        "POST",
        {
          name: required
            ? "guarded native sessions"
            : "exportable native sessions",
        },
        201,
      );
      return owner(`/api/projects/${project.id}/import`, "POST", {
        document: nativeSource(required),
      });
    },
    async sdk(projectId, mode, execute = false) {
      const client = new Client({
        name: "grpc-session-root-" + mode,
        version: "1",
      });
      clients.push(client);
      if (mode === "http") {
        const config = await owner("/api/mcp/config", "POST", {
          enabled: true,
          projects: [projectId],
          write: execute,
          execute,
          remember: false,
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          }),
        );
      } else {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              path.join(repository, "src/mcp.mjs"),
              "--project",
              projectId,
              ...(execute ? ["--write", "--execute"] : []),
            ],
            env: { ...process.env, LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
      }
      return client;
    },
    async restart() {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      await app.close();
      app = await createApp({ root, port: 0 });
    },
  };
}
function scriptedStep(definitionId, held = false) {
  const payload = held ? "held-script-plan" : "finite-script-plan";
  return {
    id: "rpc",
    type: "grpc",
    grpc: { definitionId, messages: [{ text: "{{payload}}" }] },
    grpcScripts: {
      version: 1,
      before: `pm.variables.set('payload',${JSON.stringify(payload)});pm.variables.set('local','same-occurrence');console.log('session-root-before');`,
      after:
        "pm.test('real finite response',()=>{pm.expect(grpc.result.status.code).to.equal(0);pm.expect(grpc.result.messages[0].text).to.equal('finite-script-plan');pm.expect(pm.variables.get('local')).to.equal('same-occurrence');pm.expect(pm.response).to.equal(undefined);});console.log('session-root-after');",
    },
  };
}
function checkFinite(run, plan) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true, JSON.stringify(run));
  assert.deepEqual(run.snapshot.steps, plan.steps);
  assert.equal(
    run.results[0].grpcResult.messages[0].text,
    "finite-script-plan",
  );
  assert.equal(run.results[0].grpcResult.status.code, 0);
  assert.deepEqual(run.results[0].grpcResult.metadata, []);
  assert.deepEqual(run.results[0].grpcResult.trailers, []);
  assert.equal(run.results[0].response, undefined);
  assert(
    run.results[0].assertions.some(
      (item) => item.name === "real finite response" && item.passed,
    ),
  );
  privateTransport(run);
}
async function cli(f, projectId, planId) {
  const child = spawn(
    process.execPath,
    [
      "scripts/run-plan.mjs",
      "--project",
      projectId,
      "--plan",
      planId,
      "--credentials-stdin",
    ],
    {
      cwd: repository,
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ grpcCredentials: credentials }));
  try {
    assert.equal(await closed, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(deadline);
  }
}

test(
  "native required metadata, shared scripted-plan admission and typed session history compose through SDK, CLI and restore",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const p = await f.imported();
    privateTransport(p);
    let watch = p.settings.grpcDefinitions.find(
      (definition) => definition.method === "Watch",
    );
    let unary = p.settings.grpcDefinitions.find(
      (definition) => definition.method === "Unary",
    );
    for (const definition of [watch, unary])
      assert.deepEqual(definition.requiredMetadata, ["authorization"]);
    const base = `/api/projects/${p.id}`;
    const open = (extra = {}, status = 200) =>
      f.owner(
        base + "/grpc-sessions",
        "POST",
        {
          definitionId: watch.id,
          message: {
            text: "session-input",
            big: "9007199254740993",
            blob: "/wA=",
          },
          ...extra,
        },
        status,
      );
    const action = (id, operation) =>
      f.owner(`${base}/grpc-sessions/${id}/${operation}`, "POST", {});
    const poll = (id) => f.owner(`${base}/grpc-sessions/${id}`);
    for (const extra of [
      {},
      { metadata: [] },
      { metadata: [{ key: "x-not-authorization", value: secret }] },
    ]) {
      const error = await open(extra, 400);
      assert.match(error.error, /缺少gRPC运行时metadata/);
    }
    await open({ requiredMetadata: [], metadata }, 400);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.connections,
      0,
      "no connection before saved requiredMetadata preflight",
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.app.store.get(p.id)).protocolRuns.length, 0);
    // Keep the slot-composition exercise inside one fixed, non-renewing budget.
    watch = (
      await f.owner(base + "/grpc-definitions", "POST", {
        ...watch,
        timeoutMs: 30000,
      })
    ).definition;
    unary = (
      await f.owner(base + "/grpc-definitions", "POST", {
        ...unary,
        timeoutMs: 30000,
      })
    ).definition;
    const plan = await f.owner(base + "/plans", "POST", {
      name: "finite beside sessions",
      steps: [scriptedStep(unary.id)],
    });
    const heldPlan = await f.owner(base + "/plans", "POST", {
      name: "cancellable fifth slot",
      steps: [scriptedStep(unary.id, true)],
    });
    const sdk = await f.sdk(p.id, "http", true);
    const opened = [];
    for (let i = 0; i < 4; i++) opened.push(await open({ metadata }));
    await until(
      () => f.calls.filter((call) => call.method === "Watch").length === 4,
      "four live session transports",
    );
    for (const session of opened) {
      const state = await until(async () => {
        const state = await poll(session.id);
        return state.messages.length === 1 && state;
      }, "first real stream message");
      assert.equal(state.messages[0].big, "9007199254740993");
      assert.equal(state.lifecycle, "active");
      privateTransport(state);
    }
    const heldPromise = f.owner(base + "/run", "POST", {
      planId: heldPlan.id,
      runId: "root-held-script-plan",
      grpcCredentials: credentials,
    });
    // Attach rejection handling immediately even if the barrier fails below.
    heldPromise.catch(() => {});
    await until(
      () => f.calls.find((call) => call.message.text === "held-script-plan"),
      "scripted plan occupies the fifth host slot",
    );
    const fullCount = f.calls.length;
    assert.match((await open({ metadata }, 400)).error, /5个gRPC/);
    assert.match(
      (
        await f.owner(
          base + "/grpc-run",
          "POST",
          {
            definitionId: unary.id,
            messages: [{ text: "must-not-run" }],
            metadata,
          },
          400,
        )
      ).error,
      /5个gRPC/,
    );
    assert.match(
      (
        await f.owner(
          base + "/grpc-reflection",
          "POST",
          { target: "grpc://" + f.target },
          400,
        )
      ).error,
      /5个gRPC/,
    );
    const blocked = decode(
      await sdk.callTool({
        name: "localapi_execute_flow",
        arguments: {
          projectId: p.id,
          planId: plan.id,
          grpcCredentials: credentials,
        },
      }),
    );
    assert.equal(blocked.status, "failed", JSON.stringify(blocked));
    assert.equal(blocked.results[0].grpcResult, undefined);
    assert.match(blocked.results[0].error, /5个gRPC/);
    assert.equal(
      f.calls.length,
      fullCount,
      "capacity denial cannot invoke a peer or retry",
    );
    await f.owner("/api/cancel", "POST", { id: "root-held-script-plan" });
    const cancelled = await heldPromise;
    assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
    assert.equal(cancelled.recordSaved, true);
    assert.equal(
      cancelled.results[0].grpcResult.status.code,
      grpc.status.CANCELLED,
    );
    await until(
      () =>
        f.calls.find((call) => call.message.text === "held-script-plan")
          ?.cancelled,
      "real fifth-slot cancellation",
    );
    checkFinite(
      decode(
        await sdk.callTool({
          name: "localapi_execute_flow",
          arguments: {
            projectId: p.id,
            planId: plan.id,
            grpcCredentials: credentials,
          },
        }),
      ),
      plan,
    );
    checkFinite(
      await f.owner(base + "/run", "POST", {
        planId: plan.id,
        grpcCredentials: credentials,
      }),
      plan,
    );
    for (const session of opened)
      assert.equal((await poll(session.id)).lifecycle, "active");
    // One cancellation frees exactly one slot while the other streams remain live.
    const terminal = await action(opened[0].id, "cancel");
    assert.equal(terminal.recordSaved, true);
    assert.equal(terminal.terminationReason, "cancel");
    const replacementA = await open({ metadata });
    const replacementB = await open({ metadata });
    assert.match((await open({ metadata }, 400)).error, /5个gRPC/);
    for (const session of [...opened.slice(1), replacementA, replacementB])
      await action(session.id, "cancel");
    assert(f.calls.every((call) => call.auth[0] === secret));
    const persisted = await new Store(f.root).get(p.id);
    const record = persisted.protocolRuns.find(
      (record) => record.id === terminal.id,
    );
    assert.equal(record.mode, "session");
    assert.equal(record.type, "grpc");
    assert.equal(record.status, "partial");
    assert.deepEqual(record.definition.requiredMetadata, ["authorization"]);
    assert.equal(record.result.messages[0].text, "session-input");
    privateTransport(persisted);
    const beforeReconcile = f.calls.length;
    assert.deepEqual(await action(terminal.id, "reconcile"), terminal);
    assert.equal(f.calls.length, beforeReconcile);
    // Existing root Store duplicate-ID and aborted-save boundaries still apply to
    // the new typed codec, instead of bypassing the lock/identity path.
    await assert.rejects(
      f.app.store.append(p.id, "protocolRuns", record),
      /ID无效或重复|歧义/,
    );
    const aborted = new AbortController();
    aborted.abort();
    const altered = await f.app.store.get(p.id);
    altered.name = "must not save after abort";
    await assert.rejects(f.app.store.save(altered, { signal: aborted.signal }));
    assert.deepEqual(await f.app.store.get(p.id), persisted);
    assert.throws(() => assertNativeHTTPResult(record), /原版兼容结果/);
    assert.throws(() => assertNativeHTTPResult(record.result), /原版兼容结果/);
    // A sparse legacy envelope must not erase an actual nested session result.
    const sparse = {
      id: "legacy-session-result-envelope",
      createdAt: record.createdAt,
      status: "failed",
      results: [],
      result: record.result,
    };
    await f.app.store.append(p.id, "runs", sparse);
    const native = await sdk.callTool({
      name: "apipost_get_execution_result",
      arguments: { project_id: p.id, run_id: sparse.id },
    });
    assert.equal(native.isError, true);
    assert.match(native.content[0].text, /原版兼容结果/);
    assert.deepEqual(
      decode(
        await sdk.callTool({
          name: "localapi_get_execution_result",
          arguments: { projectId: p.id, runId: sparse.id },
        }),
      ).result,
      record.result,
    );
    await sdk.close();
    // Independent stdio and CLI hosts retain their existing finite-plan contract;
    // they do not receive a new live-session mutation capability.
    const stdio = await f.sdk(p.id, "stdio", true);
    const tools = await stdio.listTools();
    assert(!tools.tools.some((tool) => /grpc.*session/.test(tool.name)));
    checkFinite(
      decode(
        await stdio.callTool({
          name: "localapi_run_plan",
          arguments: {
            projectId: p.id,
            planId: plan.id,
            grpcCredentials: credentials,
          },
        }),
      ),
      plan,
    );
    await stdio.close();
    const cliRun = await cli(f, p.id, plan.id);
    assert.equal(cliRun.status, "passed", JSON.stringify(cliRun));
    assert.equal(cliRun.recordSaved, true);
    const fromCLI = (await new Store(f.root).get(p.id)).runs.find(
      (run) => run.id === cliRun.id,
    );
    assert.equal(fromCLI.source, "cli");
    checkFinite({ ...fromCLI, recordSaved: true }, plan);
    const readOnly = await f.sdk(p.id, "http");
    assert(
      !(await readOnly.listTools()).tools.some(
        (tool) =>
          tool.name === "localapi_run_plan" || /grpc.*session/.test(tool.name),
      ),
    );
    const summaries = decode(
      await readOnly.callTool({
        name: "localapi_list_protocol_runs",
        arguments: { projectId: p.id },
      }),
    );
    assert.equal(
      summaries.find((item) => item.id === record.id).mode,
      "session",
    );
    assert.deepEqual(
      decode(
        await readOnly.callTool({
          name: "localapi_get_protocol_run",
          arguments: { projectId: p.id, recordId: record.id },
        }),
      ),
      record,
    );
    for (const format of ["apipost", "apipost-directory"]) {
      const error = await f.owner(
        base + "/export?format=" + format,
        "GET",
        undefined,
        400,
      );
      assert.match(
        error.error,
        /已移除metadata值|已编辑派生消息计划|gRPC修改\/缺失/,
      );
      const mcpError = await readOnly.callTool({
        name: "localapi_export_project",
        arguments: { projectId: p.id, format },
      });
      assert.equal(mcpError.isError, true);
      assert.match(
        mcpError.content[0].text,
        /已移除metadata值|已编辑派生消息计划|gRPC修改\/缺失/,
      );
    }
    const backup = await f.owner(base + "/export");
    privateTransport(backup);
    const callsBeforeRestore = f.calls.length;
    const restored = await f.owner(
      "/api/restore",
      "POST",
      { document: backup },
      201,
    );
    assert.notEqual(restored.id, p.id);
    assert.deepEqual(restored.protocolRuns, backup.protocolRuns);
    assert.deepEqual(restored.runs, backup.runs);
    await f.restart();
    const reloaded = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(reloaded.protocolRuns, backup.protocolRuns);
    assert.deepEqual(reloaded.runs, backup.runs);
    const reader = await f.sdk(restored.id, "stdio");
    assert.deepEqual(
      decode(
        await reader.callTool({
          name: "localapi_get_protocol_run",
          arguments: { projectId: restored.id, recordId: record.id },
        }),
      ),
      record,
    );
    for (const projectId of [p.id, restored.id])
      await f.owner(
        `/api/projects/${projectId}/grpc-sessions/${record.id}`,
        "GET",
        undefined,
        400,
      );
    assert.equal(
      f.calls.length,
      callsBeforeRestore,
      "backup/restart/SDK reads never reopen or replay sessions",
    );

    // Native export is definition interchange, explicitly not an execution
    // backup. Live sessions and typed history must not disable that contract.
    const clean = await f.imported(false);
    const cleanBase = `/api/projects/${clean.id}`;
    for (const format of ["apipost", "apipost-directory"])
      await f.owner(cleanBase + "/export?format=" + format);
    const cleanWatch = clean.settings.grpcDefinitions.find(
      (definition) => definition.method === "Watch",
    );
    const cleanSession = await f.owner(cleanBase + "/grpc-sessions", "POST", {
      definitionId: cleanWatch.id,
      message: { text: "clean-native-session" },
    });
    await until(
      () =>
        f.calls.find((call) => call.message.text === "clean-native-session"),
      "clean native stream",
    );
    for (const format of ["apipost", "apipost-directory"]) {
      const document = await f.owner(cleanBase + "/export?format=" + format);
      assert.equal(document.protocolRuns, undefined);
      assert(!JSON.stringify(document).includes(cleanSession.id));
    }
    const cleanTerminal = await f.owner(
      `${cleanBase}/grpc-sessions/${cleanSession.id}/cancel`,
      "POST",
      {},
    );
    assert.equal(cleanTerminal.recordSaved, true);
    const cleanReader = await f.sdk(clean.id, "http");
    for (const format of ["apipost", "apipost-directory"]) {
      const document = await f.owner(cleanBase + "/export?format=" + format);
      assert.equal(document.protocolRuns, undefined);
      assert(!JSON.stringify(document).includes(cleanSession.id));
      const roundtrip = {
        requests: [],
        environments: [],
        folders: [],
        servers: [],
        settings: {},
        plans: [],
      };
      importIntoProject(roundtrip, document);
      const definitions = (project) =>
        project.settings.grpcDefinitions.map(
          ({
            target,
            proto,
            service,
            method,
            timeoutMs,
            requiredMetadata,
          }) => ({
            target,
            proto,
            service,
            method,
            timeoutMs,
            requiredMetadata,
          }),
        );
      assert.deepEqual(definitions(roundtrip), definitions(clean));
      assert.equal(roundtrip.protocolRuns, undefined);
      const exported = decode(
        await cleanReader.callTool({
          name: "localapi_export_project",
          arguments: { projectId: clean.id, format },
        }),
      );
      assert(!JSON.stringify(exported).includes(cleanSession.id));
    }
    assert.equal(
      (await f.owner(cleanBase + "/export")).protocolRuns[0].id,
      cleanSession.id,
    );
  },
);

test("session-only markers fail closed without inspecting ordinary HTTP business payload", () => {
  for (const key of [
    "lifecycle",
    "requestState",
    "receiptState",
    "remoteStatus",
    "terminationReason",
    "responseEnded",
    "requestWireBytes",
  ]) {
    for (const value of [undefined, null, false, {}]) {
      const marker = { [key]: value };
      for (const run of [
        marker,
        { results: [marker] },
        { result: marker },
        { results: [{ result: marker }] },
      ])
        assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
    }
  }
  for (const run of [
    { mode: "session" },
    { result: { mode: "session" } },
    { results: [{ mode: "session" }] },
  ])
    assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
  for (const run of [
    {},
    { status: "failed", results: [{ status: "failed" }] },
    {
      results: [
        {
          response: {
            status: 200,
            protocol: "HTTP/1.1",
            body: { type: "grpc", mode: "session", lifecycle: "active" },
          },
        },
      ],
    },
  ])
    assert.doesNotThrow(() => assertNativeHTTPResult(run));
});
