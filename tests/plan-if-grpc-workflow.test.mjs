import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { executeGrpc } from "../src/grpc.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protoFile = new URL("./fixtures/grpc.proto", import.meta.url);
const proto = await readFile(protoFile, "utf8");
const cert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
const key = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("gRPC repeat fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t, secure = false) {
  const root = await mkdtemp(path.join(tmpdir(), "if-grpc-workflow-"));
  let app = await createApp({ root, port: 0 });
  const received = [],
    consumed = [],
    clients = [],
    active = new Set();
  let beforeHTTP = async () => {},
    stallSecond = false;
  const server = new grpc.Server();
  const service = grpc.loadPackageDefinition(
    loader.loadSync(fileURLToPath(protoFile), {
      longs: String,
      bytes: String,
      defaults: true,
    }),
  ).fixture.Echo.service;
  const begin = (call, method) => {
    const row = {
      method,
      token: `reply-${received.length + 1}`,
      auth: call.metadata.get("authorization")[0],
      inputs: [],
    };
    received.push(row);
    call.on("cancelled", () => active.delete(call));
    call.on("close", () => active.delete(call));
    const headers = new grpc.Metadata();
    headers.set("x-private", String(row.auth));
    call.sendMetadata(headers);
    return row;
  };
  const reply = (row) => ({ text: row.token, count: row.inputs.length });
  server.addService(service, {
    Unary(call, done) {
      const row = begin(call, "Unary");
      row.inputs.push(call.request);
      if (stallSecond) {
        active.add(call);
        return;
      }
      done(null, reply(row));
    },
    Watch(call) {
      const row = begin(call, "Watch");
      row.inputs.push(call.request);
      call.write(reply(row));
      call.write({ text: `${row.token}-tail` });
      call.end();
    },
    Collect(call, done) {
      const row = begin(call, "Collect");
      call.on("data", (value) => row.inputs.push(value));
      call.on("end", () => done(null, reply(row)));
    },
    Chat(call) {
      const row = begin(call, "Chat");
      call.on("data", (value) => {
        row.inputs.push(value);
        call.write(reply(row));
      });
      call.on("end", () => call.end());
    },
    Fail(call, done) {
      begin(call, "Fail");
      done({ code: 7, details: "fixture refusal" });
    },
    Overflow(call) {
      begin(call, "Overflow");
      for (let i = 0; i < 101; i++) call.write({ text: `overflow-${i}` });
      call.end();
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      secure
        ? grpc.ServerCredentials.createSsl(
            Buffer.from(cert),
            [{ private_key: Buffer.from(key), cert_chain: Buffer.from(cert) }],
            true,
          )
        : grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const peer = http.createServer(async (req, res) => {
    consumed.push({ token: req.headers["x-token"], url: req.url });
    await beforeHTTP();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ready: true }));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await closeApp();
    server.forceShutdown();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("gRPC repeat");
  project.environments[0].variables = { token: "initial" };
  project.settings ??= {};
  project.settings.grpcDefinitions = [
    "Unary",
    "Watch",
    "Collect",
    "Chat",
    "Fail",
    "Overflow",
  ].map((method) => ({
    id: method,
    name: method,
    target: `${secure ? "grpcs" : "grpc"}://127.0.0.1:${port}`,
    proto,
    service: "fixture.Echo",
    method,
    timeoutMs: 3000,
    requiredMetadata: ["authorization"],
  }));
  await app.store.save(project);
  const definition = (methods = ["Unary"]) => ({
    name: "HTTP to IF gRPC to extracted condition",
    environmentId: project.environments[0].id,
    steps: [
      {
        id: "setup",
        request: {
          url: `http://127.0.0.1:${peer.address().port}/setup`,
          extract: [{ name: "ready", source: "json", path: "$.ready" }],
        },
      },
      {
        type: "if",
        id: "gate",
        condition: {
          left: { scope: "runtime", name: "ready" },
          op: "eq",
          right: { literal: true },
        },
        steps: methods.flatMap((method) => [
          {
            id: method,
            type: "grpc",
            grpc: {
              definitionId: method,
              messages: [
                { text: "{{token}}" },
                ...(["Collect", "Chat"].includes(method)
                  ? [{ text: "second" }]
                  : []),
              ],
            },
            extract: [{ name: "token", path: "$[0].text" }],
            grpcScripts: {
              version: 1,
              before: "apt.setVar('prepared',true);",
              after:
                "pm.test('native success',()=>pm.expect(grpc.result.status.code).to.equal(0));apt.setVar('scriptReady',true);",
            },
          },
          {
            id: `consume-${method}`,
            request: {
              url: `http://127.0.0.1:${peer.address().port}/consume`,
              headers: [{ key: "X-Token", value: "{{token}}" }],
            },
          },
        ]),
      },
      {
        type: "if",
        id: "after-gate",
        condition: {
          left: { scope: "runtime", name: "scriptReady" },
          op: "eq",
          right: { literal: true },
        },
        steps: [
          {
            id: "after",
            request: { url: `http://127.0.0.1:${peer.address().port}/after` },
          },
        ],
      },
    ],
  });
  const credentials = (methods = ["Unary"], token = "private-grpc-token-A") =>
    Object.fromEntries(
      methods.map((method) => [
        method,
        {
          metadata: [{ key: "authorization", value: token }],
          ...(secure ? { tls: { ca: cert, key, cert } } : {}),
        },
      ]),
    );
  const post = async (route, body) => {
    const response = await fetch(app.url + "/api/" + route, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    project,
    received,
    consumed,
    active,
    definition,
    credentials,
    post,
    get app() {
      return app;
    },
    client() {
      const client = new Client({ name: "grpc-repeat", version: "1" });
      clients.push(client);
      return client;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
    stall() {
      stallSecond = true;
    },
    beforeHTTP(fn) {
      beforeHTTP = fn;
    },
  };
}
function cli(root, projectId, planId, grpcCredentials) {
  return new Promise((resolve, reject) => {
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
        cwd: repo,
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(Error(`gRPC repeat CLI ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ grpcCredentials }));
  });
}
function checkRun(run, methods = ["Unary"]) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", ...methods.flatMap((m) => [m, `consume-${m}`]), "after"],
  );
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, true],
  );
  assert.equal(run.variables.prepared, true);
  assert.equal(run.variables.scriptReady, true);
  for (const row of run.results.filter((r) => r.type === "grpc")) {
    assert.equal(row.grpcResult.status.code, 0);
    assert.deepEqual(row.grpcResult.metadata, []);
    assert.deepEqual(row.grpcResult.trailers, []);
    assert.equal(row.grpc.definitionId, undefined);
  }
}
test(
  "IF gRPC four real RPC modes survive owner, official MCP HTTP/stdio, CLI, backup and reload",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      methods = ["Unary", "Watch", "Collect", "Chat"];
    const made = await f.post(
      `projects/${f.project.id}/plans`,
      f.definition(methods),
    );
    assert.equal(made.status, 200, JSON.stringify(made.value));
    const plan = made.value,
      grpcCredentials = f.credentials(methods);
    const owner = await f.post(`projects/${f.project.id}/run`, {
      planId: plan.id,
      grpcCredentials,
    });
    checkRun(owner.value, methods);
    assert.deepEqual(
      owner.value.results
        .filter((r) => r.type === "grpc")
        .map((r) => r.grpcResult.messages.length),
      [1, 2, 1, 2],
    );
    const live = await f.app.store.get(f.project.id);
    live.settings.grpcDefinitions = [];
    await f.app.store.save(live);
    const config = await f.post("mcp/config", {
      enabled: true,
      projects: [f.project.id],
      write: true,
      execute: true,
      remember: false,
    });
    const sdk = f.client();
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + config.value.token },
        },
      }),
    );
    const sdkRun = decode(
      await sdk.callTool({
        name: "localapi_run_plan",
        arguments: {
          projectId: f.project.id,
          planId: plan.id,
          grpcCredentials,
        },
      }),
    );
    checkRun(sdkRun, methods);
    await sdk.close();
    const backup = await (
      await fetch(`${f.app.url}/api/projects/${f.project.id}/export`, {
        headers: { "x-local-token": f.app.token },
      })
    ).json();
    assert.ok(!JSON.stringify(backup).includes("private-grpc-token-A"));
    const restored = await f.post("restore", { document: backup });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.value.plans[0].steps, plan.steps);
    await f.restart();
    const denied = await f.post(`projects/${restored.value.id}/run`, {
      planId: plan.id,
    });
    assert.equal(denied.status, 400);
    assert.equal(f.received.length, 8);
    assert.equal(f.consumed.length, 12);
    const restarted = await f.post(`projects/${restored.value.id}/run`, {
      planId: plan.id,
      grpcCredentials,
    });
    checkRun(restarted.value, methods);
    const stdio = f.client();
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repo, "src/mcp.mjs"),
          "--project",
          restored.value.id,
          "--write",
          "--execute",
        ],
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stderr: "pipe",
      }),
    );
    const stdioRun = decode(
      await stdio.callTool({
        name: "localapi_run_plan",
        arguments: {
          projectId: restored.value.id,
          planId: plan.id,
          grpcCredentials,
        },
      }),
    );
    checkRun(stdioRun, methods);
    await stdio.close();
    const cliRun = await cli(
      f.root,
      restored.value.id,
      plan.id,
      grpcCredentials,
    );
    checkRun(cliRun, methods);
    for (const run of [sdkRun, restarted.value, stdioRun, cliRun])
      assert.equal(run.planHash, owner.value.planHash);
    assert.equal(f.received.length, 20);
    assert.deepEqual(
      f.consumed.filter((r) => r.url === "/consume").map((r) => r.token),
      f.received.map((r) => r.token),
    );
    assert.deepEqual(
      f.received.map((r) => r.inputs.length),
      Array(5).fill([1, 1, 2, 2]).flat(),
    );
    const disk = await new Store(f.root).get(restored.value.id);
    assert.ok(!JSON.stringify(disk).includes("private-grpc-token-A"));
    assert.deepEqual(
      disk.runs.find((r) => r.id === cliRun.id).snapshot.steps,
      plan.steps,
    );
  },
);

test("false IF gRPC preflights executor and credentials before earlier HTTP; false and disabled never run scripts or transport", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps.pop();
  input.steps[1].condition.right.literal = false;
  input.steps[1].steps[0].grpcScripts = {
    version: 1,
    before: "throw Error('must not run')",
    after: "throw Error('must not run')",
  };
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  for (const executeGrpc of [undefined, true, {}])
    await assert.rejects(
      runPlan(made.value, {}, executeRequest, {
        executeGrpc,
        grpcCredentials: f.credentials(),
      }),
      /未授权grpc/,
    );
  for (const grpcCredentials of [
    {},
    { unknown: f.credentials().Unary },
    { Unary: { metadata: [], target: "grpc://127.0.0.1:1" } },
  ]) {
    const denied = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      grpcCredentials,
    });
    assert.equal(denied.status, 400);
  }
  assert.equal(f.consumed.length, 0);
  assert.equal(f.received.length, 0);
  const skipped = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    grpcCredentials: f.credentials(),
  });
  assert.equal(skipped.value.status, "passed");
  assert.equal(skipped.value.conditionResults[0].matched, false);
  assert.deepEqual(
    skipped.value.results.map((r) => r.stepId),
    ["setup"],
  );
  assert.equal(skipped.value.variables.token, "initial");
  input.steps[1].enabled = false;
  const disabled = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(disabled.status, 200);
  const run = await runPlan(
    disabled.value,
    { token: "initial" },
    executeRequest,
  );
  assert.equal(run.status, "passed");
  assert.equal(f.received.length, 0);
  assert.equal(f.consumed.length, 2);
});

test(
  "IF gRPC cancellation and external deadline stop later branch HTTP and conditions",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["owner-cancel", "deadline"])
      await t.test(mode, async (t) => {
        const f = await fixture(t);
        f.stall();
        const made = await f.post(
          `projects/${f.project.id}/plans`,
          f.definition(),
        );
        assert.equal(made.status, 200);
        const controller = new AbortController();
        const pending =
          mode === "owner-cancel"
            ? f.post(`projects/${f.project.id}/run`, {
                planId: made.value.id,
                runId: "if-grpc-cancel",
                grpcCredentials: f.credentials(),
              })
            : runPlan(made.value, { token: "initial" }, executeRequest, {
                executeGrpc,
                grpcCredentials: f.credentials(),
                signal: controller.signal,
              });
        await until(() => f.received.length === 1);
        if (mode === "owner-cancel")
          assert.equal(
            (await f.post("cancel", { id: "if-grpc-cancel" })).status,
            200,
          );
        else {
          const deadline = AbortSignal.timeout(50);
          deadline.addEventListener(
            "abort",
            () => controller.abort(deadline.reason),
            { once: true },
          );
        }
        const result = await pending,
          run = mode === "owner-cancel" ? result.value : result;
        assert.equal(run.status, "cancelled");
        assert.deepEqual(
          run.results.map((r) => r.stepId),
          ["setup", "Unary"],
        );
        assert.equal(run.results[1].grpcResult.status.code, 1);
        assert.equal(run.conditionResults.length, 1);
        assert.equal(run.variables.token, "initial");
        assert.equal(f.consumed.length, 1);
        assert.equal(f.received.length, 1);
        await until(() => f.active.size === 0);
      });
  },
);

test("IF gRPC scope commit unknown is fail-stop without replay even with continue policy", async (t) => {
  for (const scripted of [false, true])
    for (const kind of ["instance", "code"])
      await t.test(`scripted=${scripted}/${kind}`, async (t) => {
        const f = await fixture(t),
          input = f.definition();
        input.failurePolicy = "continue";
        const leaf = input.steps[1].steps[0];
        if (!scripted) delete leaf.grpcScripts;
        leaf.extract[0].scope = "environment";
        const made = await f.post(`projects/${f.project.id}/plans`, input);
        assert.equal(made.status, 200, JSON.stringify(made.value));
        let commits = 0;
        const run = await runPlan(
          made.value,
          { token: "initial" },
          executeRequest,
          {
            executeGrpc,
            grpcCredentials: f.credentials(),
            onScopeChanges: async () => {
              commits++;
              if (kind === "code")
                throw Object.assign(Error("unknown fixture"), {
                  code: "PROJECT_COMMIT_UNCERTAIN",
                });
              throw new ProjectCommitUncertain(
                "fixture",
                Error("unknown fixture"),
              );
            },
          },
        );
        assert.equal(commits, 1);
        assert.equal(run.stopReason, "scope-commit-unknown");
        assert.deepEqual(
          run.results.map((r) => r.stepId),
          ["setup", "Unary"],
        );
        assert.deepEqual(run.results[1].scopeCommit, {
          outcome: "unknown",
          retrySafe: false,
          ...(scripted ? { phase: "after" } : {}),
        });
        assert.equal(
          run.results[1].grpcResult.messages[0].text,
          f.received[0].token,
        );
        assert.equal(run.variables.token, "initial");
        assert.equal(run.conditionResults.length, 1);
        assert.equal(f.received.length, 1);
        assert.equal(f.consumed.length, 1);
      });
});

test("IF after gRPC reads extracted response and committed script environment variables", async (t) => {
  for (const scripted of [false, true])
    await t.test(`scripted=${scripted}`, async (t) => {
      const f = await fixture(t),
        input = f.definition();
      const leaf = input.steps[1].steps[0];
      if (!scripted) delete leaf.grpcScripts;
      else
        leaf.grpcScripts.after +=
          "pm.environment.set('committedReply',grpc.result.messages[0].text);";
      input.steps[2].condition = {
        left: {
          scope: scripted ? "environment" : "runtime",
          name: scripted ? "committedReply" : "token",
        },
        op: "eq",
        right: { literal: "reply-1" },
      };
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const result = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        grpcCredentials: f.credentials(),
      });
      assert.equal(result.value.status, "passed");
      assert.deepEqual(
        result.value.conditionResults.map((r) => r.matched),
        [true, true],
      );
      assert.deepEqual(
        result.value.results.map((r) => r.stepId),
        ["setup", "Unary", "consume-Unary", "after"],
      );
      assert.equal(result.value.variables.token, "reply-1");
      assert.equal(f.consumed[1].token, "reply-1");
      if (scripted)
        assert.equal(
          (await new Store(f.root).get(f.project.id)).environments[0].variables
            .committedReply,
          "reply-1",
        );
    });
});

test("IF gRPC real RPC deadline preserves default continue semantics and suppresses extraction", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  f.stall();
  const saved = await f.app.store.get(f.project.id);
  saved.settings.grpcDefinitions.find((d) => d.id === "Unary").timeoutMs = 100;
  await f.app.store.save(saved);
  delete input.steps[1].steps[0].grpcScripts;
  input.steps[2].condition = {
    left: { scope: "environment", name: "token" },
    op: "eq",
    right: { literal: "initial" },
  };
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const response = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    grpcCredentials: f.credentials(),
  });
  const run = response.value;
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "Unary", "consume-Unary", "after"],
  );
  assert.equal(
    run.results[1].grpcResult.status.code,
    grpc.status.DEADLINE_EXCEEDED,
  );
  assert.deepEqual(run.results[1].extracted, {});
  assert.equal(run.variables.token, "initial");
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, true],
  );
  assert.equal(f.received.length, 1);
  assert.equal(f.consumed[1].token, "initial");
  await until(() => f.active.size === 0);
});
