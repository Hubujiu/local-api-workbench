import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { assertNativeLinearPlan } from "../src/native-mcp-plan.mjs";
import { prepareStagedLoad } from "../src/staged-load-plan.mjs";
import { runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("SSE repeat fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t, items = [{ value: "a" }, { value: "b" }]) {
  const root = await mkdtemp(path.join(tmpdir(), "rows-sse-workflow-"));
  let app = await createApp({ root, port: 0 });
  const sockets = new Set(),
    received = [],
    consumed = [],
    clients = [];
  let connections = 0,
    responseMode = "normal";
  let onSSE = async () => {},
    onHTTP = async () => {};
  const sse = http.createServer(async (request, response) => {
    connections++;
    const socket = response;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const token = `sse-token-${received.length + 1}`;
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({
      token,
      authorization: request.headers.authorization,
      method: request.method,
      body,
      lastEventId: request.headers["last-event-id"],
    });
    response.writeHead(responseMode === "unauthorized" ? 401 : 200, {
      "content-type":
        responseMode === "wrong-content-type"
          ? "application/json"
          : "text/event-stream",
    });
    response.flushHeaders();
    await onSSE(response, received.length);
    if (!response.destroyed && !response.writableEnded)
      response.end(
        `id: ${received.length}\ndata: ${token}\n\ndata: ${received.length % 2 === 0 ? "done" : "pending"}\n\n`,
      );
  });
  const peer = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    consumed.push({ url: req.url, token: req.headers["x-token"] });
    await onHTTP(req);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        items: req.url === "/setup" ? items : [{ value: "replacement" }],
      }),
    );
  });
  await Promise.all([
    new Promise((r) => sse.listen(0, "127.0.0.1", r)),
    new Promise((r) => peer.listen(0, "127.0.0.1", r)),
  ]);
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await closeApp();
    sse.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([sse, peer].map((s) => new Promise((r) => s.close(r))));
    await rm(root, { recursive: true, force: true });
  });
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
  const project = await app.store.create("SSE repeat");
  project.environments[0].variables = { token: "initial" };
  project.protocols = [
    normalizeProtocol({
      id: "saved-sse",
      type: "sse",
      url: `http://127.0.0.1:${sse.address().port}`,
      duration: 5000,
      method: "POST",
      templateMode: "variables",
      body: "row={{value}}",
    }),
  ];
  await app.store.save(project);
  const definition = () => ({
    name: "HTTP to frozen SSE rows to HTTP",
    environmentId: project.environments[0].id,
    steps: [
      {
        id: "setup",
        request: {
          url: `http://127.0.0.1:${peer.address().port}/setup`,
          extract: [{ name: "items", source: "json", path: "$.items" }],
        },
      },
      {
        id: "group",
        type: "repeat",
        rowsFrom: { scope: "runtime", name: "items" },
        maxRows: 3,
        steps: [
          {
            id: "wire",
            type: "protocol",
            protocol: { definitionId: "saved-sse" },
            protocolScripts: {
              version: 1,
              before: "apt.setVar('value', pm.iterationData.get('value'));",
              after:
                "pm.test('frozen row', () => pm.expect(pm.iterationData.get('value')).to.equal(apt.getVar('value')));",
            },
            extract: [
              { name: "token", path: "$.events[0].data" },
              { name: "done", path: "$.events[1].data" },
            ],
          },
          {
            id: "consume",
            request: {
              url: `http://127.0.0.1:${peer.address().port}/consume`,
              headers: [{ key: "X-Token", value: "{{token}}" }],
            },
          },
        ],
      },
    ],
  });
  return {
    root,
    project,
    received,
    consumed,
    sockets,
    post,
    definition,
    get connections() {
      return connections;
    },
    get app() {
      return app;
    },
    responseMode(mode) {
      responseMode = mode;
    },
    beforeSSE(fn) {
      onSSE = fn;
    },
    beforeHTTP(fn) {
      onHTTP = fn;
    },
    client() {
      const c = new Client({ name: "sse-repeat-workflow", version: "1" });
      clients.push(c);
      return c;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
async function execute(f, mode, planId, protocolCredentials) {
  const projectId = f.project.id;
  if (mode === "owner") {
    const result = await f.post(`projects/${projectId}/run`, {
      planId,
      protocolCredentials,
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  }
  if (mode === "CLI")
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
          "--output",
          path.join(f.root, "cli-result.json"),
        ],
        {
          cwd: repo,
          env: { ...process.env, LOCAL_API_DATA: f.root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== 1)
          return reject(
            Error(`SSE runtime rows CLI ${code}: ${stderr} ${stdout}`),
          );
        try {
          f.cliOutput = { stdout, stderr };
          const run = JSON.parse(stdout);
          assert.equal(code, run.status === "passed" ? 0 : 1);
          resolve(run);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({ protocolCredentials }));
    });
  const client = f.client();
  let transport;
  if (mode === "SDK HTTP") {
    const config = await f.post("mcp/config", {
      enabled: true,
      projects: [projectId],
      write: true,
      execute: true,
      remember: false,
    });
    assert.equal(config.status, 200);
    transport = new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + config.value.token },
      },
    });
  } else
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repo, "src/mcp.mjs"),
        "--project",
        projectId,
        "--write",
        "--execute",
      ],
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stderr: "pipe",
    });
  await client.connect(transport, { timeout: 5000 });
  const result = await client.callTool(
    {
      name: "localapi_run_plan",
      arguments: { projectId, planId, protocolCredentials },
    },
    undefined,
    { timeout: 10000 },
  );
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function save(f, input = f.definition()) {
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  return made.value;
}
const wireResults = (run) =>
  run.results.filter((record) => record.stepId === "wire");
const consumers = (f) =>
  f.consumed.filter((record) => record.url === "/consume");
for (const mode of ["owner", "SDK HTTP", "SDK stdio", "CLI"])
  test(
    `${mode} SSE runtime rows freeze row data and saved references, deliberately repeat POST and retain persistent extraction`,
    { timeout: 25000 },
    async (t) => {
      const f = await fixture(t),
        input = f.definition();
      const live = await f.app.store.get(f.project.id);
      live.protocols[0].handshake = { requiredHeaders: ["authorization"] };
      await f.app.store.save(live);
      const leaf = input.steps[1].steps[0];
      leaf.extract[0].scope = "environment";
      leaf.extract[1].scope = "global";
      input.steps[1].steps[1].request.extract = [
        { name: "items", source: "json", path: "$.items" },
      ];
      input.steps[1].steps[1].request.afterScript =
        "pm.environment.set('rounds', (pm.environment.get('rounds') || 0) + 1);";
      const plan = await save(f, input);
      const changed = await f.app.store.get(f.project.id);
      changed.protocols[0].url = "http://127.0.0.1:1/no-longer-live";
      changed.protocols[0].handshake.requiredHeaders = ["x-new-requirement"];
      await f.app.store.save(changed);
      const secret = "Bearer rows-sse-private-fixture";
      const run = await execute(f, mode, plan.id, {
        wire: { headers: { Authorization: secret } },
      });
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.deepEqual(
        run.results.map((r) => r.stepId),
        ["setup", "wire", "consume", "wire", "consume"],
      );
      assert.deepEqual(run.variables.items, [{ value: "replacement" }]);
      assert.deepEqual(
        f.received.map(({ method, body, lastEventId }) => ({
          method,
          body,
          lastEventId,
        })),
        ["a", "b"].map((value) => ({
          method: "POST",
          body: `row=${value}`,
          lastEventId: undefined,
        })),
      );
      assert.deepEqual(
        f.received.map((r) => r.authorization),
        [secret, secret],
      );
      assert.deepEqual(
        consumers(f).map((r) => r.token),
        f.received.map((r) => r.token),
      );
      assert.deepEqual(
        wireResults(run).map((r) => r.protocolResult.result.events[0].id),
        ["1", "2"],
      );
      assert.equal(
        run.snapshot.steps[1].steps[0].protocol.definitionId,
        undefined,
      );
      assert.deepEqual(run.snapshot.steps[1].rowsFrom, {
        scope: "runtime",
        name: "items",
      });
      assert.equal(Object.hasOwn(run.snapshot.steps[1], "count"), false);
      assert.equal(
        new Set(run.results.slice(1).map((r) => r.repeat.occurrenceId)).size,
        4,
      );
      const stored = await new Store(f.root).get(f.project.id);
      assert.equal(stored.environments[0].variables.rounds, 2);
      assert.equal(stored.environments[0].variables.token, "sse-token-2");
      assert.equal(stored.globalVariables.done, "done");
      assert.deepEqual(stored.runs[0].results, run.results);
      assert.ok(!JSON.stringify(stored).includes(secret));
      assert.ok(!JSON.stringify(run).includes(secret));
      assert.equal(f.connections, 2);
      await until(() => f.sockets.size === 0);
    },
  );

test("SSE runtime rows EOF, duration and event cap keep completed/partial and stop/continue extraction contracts", async (t) => {
  for (const mode of ["eof", "timeout", "limit"])
    for (const acceptPartial of [false, true])
      for (const failurePolicy of ["stop", "continue"])
        await t.test(`${mode}/${acceptPartial}/${failurePolicy}`, async (t) => {
          const f = await fixture(t, [{ value: "a" }]),
            input = f.definition(),
            leaf = input.steps[1].steps[0];
          input.failurePolicy = failurePolicy;
          leaf.extract = [{ name: "token", path: "$.events[0].data" }];
          leaf.protocol.duration = 100;
          leaf.protocol.maxEvents = mode === "limit" ? 1 : 20;
          if (acceptPartial && mode !== "eof") leaf.expectedStatus = "partial";
          f.beforeSSE((res) => {
            res.write("id: 17\ndata: first\n\ndata: second\n\n");
            if (mode === "eof") res.end("data: incomplete");
            else return new Promise((resolve) => res.once("close", resolve));
          });
          const plan = await save(f, input),
            run = await execute(f, "owner", plan.id);
          const record = wireResults(run)[0],
            result = record.protocolResult.result;
          assert.equal(
            record.protocolResult.status,
            mode === "eof" ? "completed" : "partial",
          );
          assert.equal(result.events.length, mode === "limit" ? 1 : 2);
          assert.equal(result.events[0].id, "17");
          if (mode === "limit") assert.equal(result.limited, true);
          if (mode === "timeout") assert.equal(result.timedOut, true);
          const passed = mode === "eof" || acceptPartial;
          assert.equal(run.status, passed ? "passed" : "failed");
          assert.equal(run.variables.token, passed ? "first" : "initial");
          assert.equal(
            consumers(f).length,
            passed || failurePolicy === "continue" ? 1 : 0,
          );
          if (!passed) assert.deepEqual(record.extracted, {});
          assert.equal(f.connections, 1);
          await until(() => f.sockets.size === 0);
        });
});

test("SSE runtime rows failed second capture cannot overwrite earlier successful extraction", async (t) => {
  for (const mode of [
    "timeout",
    "unauthorized",
    "wrong-content-type",
    "disconnect",
  ])
    for (const failurePolicy of ["stop", "continue"])
      await t.test(`${mode}/${failurePolicy}`, async (t) => {
        const f = await fixture(t),
          input = f.definition();
        input.failurePolicy = failurePolicy;
        input.steps[1].steps[0].protocol.duration = 100;
        f.beforeHTTP(() => {
          if (
            consumers(f).length === 1 &&
            ["unauthorized", "wrong-content-type"].includes(mode)
          )
            f.responseMode(mode);
        });
        f.beforeSSE(async (res, iteration) => {
          if (iteration !== 2) return;
          res.write("data: unsafe-token\n\ndata: done\n\n");
          if (mode === "disconnect") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            res.destroy();
          } else if (mode === "timeout")
            return new Promise((resolve) => res.once("close", resolve));
        });
        const plan = await save(f, input),
          run = await execute(f, "owner", plan.id);
        assert.equal(run.status, "failed");
        assert.equal(
          wireResults(run)[1].protocolResult.status,
          mode === "timeout" ? "partial" : "failed",
        );
        assert.deepEqual(wireResults(run)[1].extracted, {});
        assert.equal(run.variables.token, "sse-token-1");
        assert.equal(run.variables.done, "pending");
        assert.deepEqual(
          consumers(f).map((r) => r.token),
          failurePolicy === "stop"
            ? ["sse-token-1"]
            : ["sse-token-1", "sse-token-1"],
        );
        assert.equal(f.connections, 2);
        await until(() => f.sockets.size === 0);
      });
});

test(
  "SSE runtime rows cancellation retains earlier committed values and closes the active stream without reconnect",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      input = f.definition();
    input.steps[1].steps[0].extract[0].scope = "environment";
    let entered;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    f.beforeSSE((res, iteration) => {
      if (iteration !== 2) return;
      return new Promise((resolve) => {
        res.once("close", resolve);
        res.write("data: observed-before-cancel\n\n");
        entered();
      });
    });
    const plan = await save(f, input);
    const running = f.post(`projects/${f.project.id}/run`, {
      planId: plan.id,
      runId: "sse-rows-cancel",
    });
    await pending;
    assert.equal(
      (await f.post("cancel", { id: "sse-rows-cancel" })).status,
      200,
    );
    const { value: run } = await running;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      ["setup", "wire", "consume", "wire"],
    );
    assert.equal(wireResults(run)[1].protocolResult.status, "cancelled");
    assert.deepEqual(wireResults(run)[1].extracted, {});
    assert.equal(run.variables.token, "sse-token-1");
    assert.equal(f.connections, 2);
    assert.equal(consumers(f).length, 1);
    assert.equal(
      (await new Store(f.root).get(f.project.id)).environments[0].variables
        .token,
      "sse-token-1",
    );
    await until(() => f.sockets.size === 0);
  },
);

test("SSE runtime rows require stable credentials and executor before even an empty producer", async (t) => {
  const f = await fixture(t, []),
    saved = await f.app.store.get(f.project.id);
  saved.protocols[0].handshake = { requiredHeaders: ["authorization"] };
  await f.app.store.save(saved);
  const plan = await save(f),
    credential = { headers: { Authorization: "Bearer row-preflight-private" } };
  for (const protocolCredentials of [
    undefined,
    {},
    { '["group","wire",0]': credential },
    { wire: { headers: { Host: "invalid" } } },
  ]) {
    const denied = await f.post(`projects/${f.project.id}/run`, {
      planId: plan.id,
      protocolCredentials,
    });
    assert.equal(denied.status, 400);
  }
  for (const executeProtocol of [undefined, true, {}])
    await assert.rejects(
      runPlan(plan, {}, executeRequest, {
        allowRuntimeRows: true,
        executeProtocol,
        protocolCredentials: { wire: credential },
      }),
      /未授权protocol/,
    );
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
  const run = await execute(f, "owner", plan.id, { wire: credential });
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup"],
  );
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 1);
});

test("SSE runtime rows validate the complete source and later IF operands before first child", async (t) => {
  for (const items of [
    [{ value: "a", ok: true }, null],
    [
      { value: "a", ok: true },
      { value: "b", ok: 1 },
    ],
    [{}, {}, {}, {}],
  ])
    await t.test(JSON.stringify(items), async (t) => {
      const f = await fixture(t, items),
        input = f.definition(),
        group = input.steps[1];
      group.steps = [
        {
          id: "gate",
          type: "if",
          condition: {
            op: "eq",
            left: { scope: "iterationData", name: "ok" },
            right: { literal: true },
          },
          steps: group.steps,
        },
      ];
      const plan = await save(f, input),
        run = await execute(f, "owner", plan.id);
      assert.equal(run.status, "failed");
      assert.equal(run.stopReason, "runtime-rows-error");
      assert.equal(f.connections, 0);
      assert.equal(consumers(f).length, 0);
      assert.deepEqual(
        run.results.map((r) => r.stepId),
        ["setup"],
      );
    });
});

test("SSE runtime rows atomically reject extraction batches without partial persistent values", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.failurePolicy = "stop";
  input.steps[1].steps[0].extract = [
    { name: "token", path: "$.events[0].data", scope: "environment" },
    { name: "absent", path: "$.events[99].data", scope: "global" },
  ];
  const plan = await save(f, input),
    run = await execute(f, "owner", plan.id);
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "step-failure");
  assert.equal(run.variables.token, "initial");
  assert.deepEqual(wireResults(run)[0].extracted, {});
  assert.equal(wireResults(run)[0].protocolResult.status, "completed");
  assert.equal(f.connections, 1);
  assert.equal(consumers(f).length, 0);
  const stored = await new Store(f.root).get(f.project.id);
  assert.equal(stored.environments[0].variables.token, "initial");
  assert.equal(stored.globalVariables?.absent, undefined);
});

for (const failurePolicy of ["stop", "continue"])
  test(`SSE runtime rows unknown scope commit fails closed under ${failurePolicy} without replay`, async (t) => {
    const f = await fixture(t),
      input = f.definition();
    input.failurePolicy = failurePolicy;
    input.steps[1].steps[0].extract[0].scope = "environment";
    const plan = await save(f, input);
    let commits = 0;
    const run = await runPlan(plan, { token: "initial" }, executeRequest, {
      allowRuntimeRows: true,
      executeProtocol: executeWireFlow,
      onScopeChanges: async () => {
        commits++;
        throw new ProjectCommitUncertain("private fixture");
      },
    });
    assert.equal(commits, 1);
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(run.variables.token, "initial");
    assert.equal(run.variables.done, undefined);
    assert.deepEqual(wireResults(run)[0].extracted, {});
    assert.equal(wireResults(run)[0].protocolResult.status, "completed");
    assert.equal(f.connections, 1);
    assert.equal(consumers(f).length, 0);
    assert.ok(!JSON.stringify(run).includes("private fixture"));
  });

test("SSE runtime rows nest IF and until with frozen iterationData and freshly committed tail scopes", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    group = input.steps[1],
    [leaf, consumer] = group.steps;
  leaf.extract[1].scope = "environment";
  consumer.request.extract = [
    { name: "items", source: "json", path: "$.items" },
  ];
  group.steps = [
    {
      id: "until",
      type: "repeat",
      count: 3,
      untilCondition: {
        left: { scope: "environment", name: "done" },
        op: "eq",
        right: { literal: "done" },
      },
      steps: [
        {
          id: "gate",
          type: "if",
          condition: {
            left: { scope: "iterationData", name: "value" },
            op: "neq",
            right: { literal: "replacement" },
          },
          steps: [leaf, consumer],
        },
      ],
    },
  ];
  const plan = await save(f, input),
    run = await execute(f, "owner", plan.id);
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(
    f.received.map((r) => r.body),
    ["row=a", "row=a", "row=b", "row=b"],
  );
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, false, true, true, true, false, true, true],
  );
  assert.deepEqual(run.variables.items, [{ value: "replacement" }]);
  assert.equal(
    new Set(wireResults(run).map((r) => r.repeat.occurrenceId)).size,
    4,
  );
  assert.equal(
    (await new Store(f.root).get(f.project.id)).environments[0].variables.done,
    "done",
  );
  assert.throws(() => assertNativeLinearPlan(plan), /canonical|循环|条件/);
  assert.throws(
    () =>
      prepareStagedLoad(f.project, plan, {
        initialVUs: 1,
        stages: [{ durationSeconds: 1, targetVUs: 1 }],
        maxIterations: 1,
      }),
    /HTTP/,
  );
});

test("SSE until nests runtime rows and IF while persistent HTTP changes drive the outer tail", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    [producer, group] = input.steps,
    [leaf, consumer] = group.steps;
  consumer.request.extract = [
    { name: "items", source: "json", path: "$.items" },
  ];
  consumer.request.afterScript =
    "pm.environment.set('rounds', (pm.environment.get('rounds') || 0) + 1);";
  group.steps = [
    {
      id: "gate",
      type: "if",
      condition: {
        left: { scope: "iterationData", name: "value" },
        op: "neq",
        right: { literal: "replacement" },
      },
      steps: [leaf, consumer],
    },
  ];
  input.steps = [
    {
      id: "until",
      type: "repeat",
      count: 3,
      untilCondition: {
        left: { scope: "environment", name: "rounds" },
        op: "eq",
        right: { literal: 4 },
      },
      steps: [producer, group],
    },
  ];
  const plan = await save(f, input),
    run = await execute(f, "owner", plan.id);
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(
    f.received.map((r) => r.body),
    ["row=a", "row=b", "row=a", "row=b"],
  );
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, true, false, true, true, true],
  );
  assert.equal(run.variables.rounds, 4);
  assert.equal(
    (await new Store(f.root).get(f.project.id)).environments[0].variables
      .rounds,
    4,
  );
});

for (const body of ["", "data: incomplete"])
  test(`SSE runtime rows ${JSON.stringify(body)} EOF completes without synthesizing an event`, async (t) => {
    const f = await fixture(t),
      input = f.definition();
    delete input.steps[1].steps[0].extract;
    f.beforeSSE((res) => res.end(body));
    const plan = await save(f, input),
      run = await execute(f, "owner", plan.id);
    assert.equal(run.status, "passed");
    for (const record of wireResults(run)) {
      assert.equal(record.protocolResult.status, "completed");
      assert.deepEqual(record.protocolResult.result.events, []);
    }
    assert.equal(run.variables.token, "initial");
    assert.equal(f.connections, 2);
    await until(() => f.sockets.size === 0);
  });
