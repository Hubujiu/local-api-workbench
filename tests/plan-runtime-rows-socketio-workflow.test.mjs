import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Server } from "socket.io";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";
import { executeSocketIOFlow } from "../src/socketio-plan.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modes = [
  "v2-websocket",
  "v2-polling",
  "v2-auto",
  "v4-websocket",
  "v4-polling",
  "v4-auto",
];
const defaultMode = "v4-websocket";
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw Error("Socket.IO runtime rows fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t, items = [{ value: "a" }, { value: "b" }]) {
  const root = await mkdtemp(
    path.join(tmpdir(), "runtime-rows-socketio-workflow-"),
  );
  const app = await createApp({ root, port: 0 });
  const received = [],
    consumed = [],
    httpCalls = [],
    handshakes = [],
    clients = [],
    active = new Set();
  const cycleLength = 2;
  let stallSecond = false,
    disconnectSecond = false,
    holdHandshake = false,
    holdWait = false,
    pendingAck,
    rejection;
  const server = http.createServer();
  const io = new Server(server, { allowEIO3: true, path: "/repeat/" });
  const namespace = io.of("/private");
  namespace.use((socket, next) => {
    handshakes.push(socket.id);
    if (rejection) {
      assert.equal(socket.handshake.auth.nested.secret, rejection.secret);
      const error = Error(rejection.variants.join(" | "));
      error.data = {
        message: rejection.secret,
        description: { message: rejection.secret },
      };
      return next(error);
    }
    if (holdHandshake && handshakes.length === 2) return;
    if (
      !socket.handshake.headers["x-private"] ||
      !socket.handshake.query.token ||
      (socket.conn.protocol === 4 && !socket.handshake.auth.token)
    )
      return next(Error("fixture credentials missing"));
    next();
  });
  namespace.on("connection", (socket) => {
    const row = {
      id: socket.id,
      token: `reply-${received.length + 1}`,
      auth: socket.handshake.headers["x-private"],
      authToken: socket.handshake.auth.token,
      query: socket.handshake.query.token,
      version: socket.conn.protocol,
      transport: socket.conn.transport.name,
      inputs: [],
      serverAcks: [],
    };
    received.push(row);
    active.add(socket);
    socket.on("disconnect", () => active.delete(socket));
    socket.emit("welcome", { ready: true });
    socket.on("echo", (value, ack) => {
      row.inputs.push(value);
      if (received.length === 2 && disconnectSecond) {
        socket.disconnect(true);
        return;
      }
      if (received.length === 2 && stallSecond) {
        pendingAck = ack;
        return;
      }
      const reply = {
        token: row.token,
        binary: value.binary,
        echo: value.text,
        done: received.length % cycleLength === 0,
      };
      socket.emit("answer", reply);
      ack?.(reply, "second-argument", 42);
    });
    socket.on("ask", () =>
      socket.emit("question", { prompt: "reply" }, (value) => {
        row.serverAcks.push(value);
        if (!(holdWait && received.length === 2))
          socket.emit("ack-received", { ok: true });
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const peer = http.createServer(async (req, res) => {
    httpCalls.push(req.url);
    if (req.url === "/consume")
      consumed.push({ token: req.headers["x-token"], url: req.url });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        items: req.url === "/produce" ? items : [{ value: "replacement" }],
      }),
    );
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await closeApp();
    await new Promise((resolve) => io.close(resolve));
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Socket.IO runtime rows");
  project.environments[0].variables = { token: "initial" };
  project.settings.socketioDefinitions = modes.map((mode) => ({
    id: mode,
    name: mode,
    url: `http://127.0.0.1:${server.address().port}/private`,
    path: "/repeat/",
    version: Number(mode[1]),
    transport: mode.slice(3),
    handshake: { headers: {}, requiredHeaders: ["x-private"] },
  }));
  await app.store.save(project);
  const definition = (selected = [defaultMode]) => ({
    name: "Frozen Socket.IO runtime rows",
    environmentId: project.environments[0].id,
    steps: [
      {
        id: "producer",
        request: {
          url: `http://127.0.0.1:${peer.address().port}/produce`,
          extract: [{ name: "items", source: "json", path: "$.items" }],
        },
      },
      {
        type: "repeat",
        id: "group",
        rowsFrom: { scope: "runtime", name: "items" },
        maxRows: 3,
        steps: [
          {
            id: "bind",
            request: {
              url: `http://127.0.0.1:${peer.address().port}/bind`,
              beforeScript:
                "pm.environment.set('value', pm.iterationData.get('value'));",
            },
          },
          ...selected.flatMap((mode) => [
            {
              id: mode,
              type: "socketio",
              socketio: {
                definitionId: mode,
                timeoutMs: 5000,
                commands: [
                  { type: "wait", event: "welcome", timeoutMs: 2000 },
                  {
                    type: "emit",
                    event: "echo",
                    args: [
                      { text: "{{value}}", binary: { $binary: "AAEC/w==" } },
                    ],
                    ackTimeoutMs: 2000,
                  },
                  { type: "wait", event: "answer", timeoutMs: 2000 },
                  { type: "emit", event: "ask", args: [] },
                  { type: "wait", event: "question", timeoutMs: 2000 },
                  { type: "ack", args: ["client-confirmed"] },
                  { type: "wait", event: "ack-received", timeoutMs: 2000 },
                ],
              },
              extract: [
                { name: "token", path: "$[1].args[0].token" },
                { name: "done", path: "$[1].args[0].done" },
              ],
            },
            {
              id: `consume-${mode}`,
              request: {
                method: "GET",
                url: `http://127.0.0.1:${peer.address().port}/consume`,
                headers: [{ key: "X-Token", value: "{{token}}" }],
              },
            },
          ]),
        ],
      },
    ],
  });
  const credentials = (
    selected = [defaultMode],
    token = "private-socketio-token-A",
  ) =>
    Object.fromEntries(
      selected.map((mode) => [
        mode,
        {
          query: { token },
          headers: { "x-private": token },
          ...(mode.startsWith("v4") ? { auth: { token } } : {}),
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
    handshakes,
    consumed,
    active,
    definition,
    httpCalls,
    credentials,
    post,
    get app() {
      return app;
    },
    client() {
      const client = new Client({ name: "socketio-repeat", version: "1" });
      clients.push(client);
      return client;
    },
    get engineClients() {
      return io.engine.clientsCount;
    },
    rejectHandshake(secret, variants) {
      rejection = { secret, variants };
    },
    holdHandshake() {
      holdHandshake = true;
    },
    holdWait() {
      holdWait = true;
    },
    stall() {
      stallSecond = true;
    },
    disconnect() {
      disconnectSecond = true;
    },
    lateAck() {
      pendingAck?.({
        token: "late-old-session",
        binary: Buffer.from([0, 1, 2, 255]),
      });
    },
  };
}
async function execute(f, mode, planId, socketioCredentials) {
  const projectId = f.project.id;
  if (mode === "owner") {
    const result = await f.post(`projects/${projectId}/run`, {
      planId,
      socketioCredentials,
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
            Error(`Socket.IO runtime rows CLI ${code}: ${stderr} ${stdout}`),
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
      child.stdin.end(JSON.stringify({ socketioCredentials }));
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
      arguments: { projectId, planId, socketioCredentials },
    },
    undefined,
    { timeout: 10000 },
  );
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

for (const mode of ["owner", "SDK HTTP", "SDK stdio", "CLI"])
  test(
    `${mode} Socket.IO runtime rows freeze references and rows across real v2/v4 transports`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        input = f.definition(modes);
      // Replacing the source during the first iteration must not replace the frozen second row.
      input.steps[1].steps.at(-1).request.extract = [
        { name: "items", source: "json", path: "$.items" },
      ];
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const live = await f.app.store.get(f.project.id);
      for (const definition of live.settings.socketioDefinitions) {
        definition.url = "http://127.0.0.1:1/changed";
        definition.path = "/changed/";
        definition.handshake.requiredHeaders = ["x-live"];
      }
      await f.app.store.save(live);
      const run = await execute(f, mode, made.value.id, f.credentials(modes));
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 27);
      assert.equal(run.conditionResults, undefined);
      assert.deepEqual(run.snapshot.steps[1].rowsFrom, {
        scope: "runtime",
        name: "items",
      });
      assert.equal(Object.hasOwn(run.snapshot.steps[1], "count"), false);
      assert.deepEqual(run.variables.items, [{ value: "replacement" }]);
      assert.deepEqual(
        f.received.map((r) => r.inputs[0].text),
        ["a", "b"].flatMap((value) => modes.map(() => value)),
      );
      assert.deepEqual(
        f.consumed.map((r) => r.token),
        f.received.map((r) => r.token),
      );
      const leaves = run.results.filter((r) => r.type === "socketio");
      assert.equal(
        new Set(leaves.map((r) => r.socketioResult.sessionId)).size,
        12,
      );
      assert.equal(
        new Set(run.results.slice(1).map((r) => r.repeat.occurrenceId)).size,
        26,
      );
      for (const [index, leaf] of leaves.entries()) {
        const wireMode = modes[index % modes.length],
          row = f.received[index];
        assert.equal(row.version, wireMode.startsWith("v2") ? 3 : 4);
        if (!wireMode.endsWith("auto"))
          assert.equal(row.transport, wireMode.slice(3));
        assert.equal(row.auth, "private-socketio-token-A");
        assert.equal(row.query, "private-socketio-token-A");
        if (wireMode.startsWith("v4"))
          assert.equal(row.authToken, "private-socketio-token-A");
        assert.equal(row.inputs[0].binary.toString("base64"), "AAEC/w==");
        assert.deepEqual(row.serverAcks, ["client-confirmed"]);
        assert.equal(leaf.socketio.definitionId, undefined);
        assert.equal(leaf.socketioResult.status, "passed");
        assert.equal(leaf.socketioResult.state, "closed");
        assert.equal(leaf.socketioResult.results.length, 7);
        assert.equal(leaf.socketioResult.results[1].status, "acknowledged");
        assert.deepEqual(leaf.socketioResult.results[1].args.slice(1), [
          "second-argument",
          42,
        ]);
        assert.equal(
          leaf.socketioResult.results[1].args[0].binary.$binary,
          "AAEC/w==",
        );
        assert.equal(leaf.socketioResult.results[5].status, "ack-sent");
        assert.deepEqual(leaf.repeat, {
          groupId: "group",
          childId: wireMode,
          iteration: Math.floor(index / 6),
          occurrenceId: JSON.stringify([
            "group",
            wireMode,
            Math.floor(index / 6),
          ]),
        });
      }
      await until(() => f.active.size === 0 && f.engineClients === 0);
      const stored = await new Store(f.root).get(f.project.id);
      assert.deepEqual(stored.runs[0].results, run.results);
      assert.deepEqual(stored.runs[0].snapshot, run.snapshot);
      assert.ok(!JSON.stringify(stored).includes("private-socketio-token-A"));
      assert.ok(!JSON.stringify(run).includes("private-socketio-token-A"));
    },
  );

test("Socket.IO runtime rows preflight stable leaf credentials and dedicated executor before an empty producer", async (t) => {
  const f = await fixture(t, []),
    made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  for (const socketioCredentials of [
    {},
    { '["group","v4-websocket",0]': f.credentials()[defaultMode] },
    {
      [defaultMode]: {
        ...f.credentials()[defaultMode],
        url: "http://127.0.0.1:1",
      },
    },
  ]) {
    const denied = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      socketioCredentials,
    });
    assert.equal(denied.status, 400);
  }
  for (const executeSocketIO of [undefined, true, {}])
    await assert.rejects(
      runPlan(made.value, {}, executeRequest, {
        allowRuntimeRows: true,
        executeSocketIO,
        socketioCredentials: f.credentials(),
        executeProtocol() {
          throw Error("not Socket.IO");
        },
      }),
      /未授权socketio/,
    );
  assert.deepEqual(f.httpCalls, []);
  assert.deepEqual(f.handshakes, []);
  const run = await execute(f, "owner", made.value.id, f.credentials());
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["producer"],
  );
  assert.deepEqual(f.httpCalls, ["/produce"]);
  assert.deepEqual(f.handshakes, []);
});

test("Socket.IO runtime rows extraction commits environment and global scopes before consumers", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    leaf = input.steps[1].steps[1];
  leaf.extract[0].scope = "environment";
  leaf.extract[1].scope = "global";
  input.steps[1].steps[2].request.afterScript =
    "pm.environment.set('rounds', (pm.environment.get('rounds') || 0) + 1);";
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const run = await execute(f, "owner", made.value.id, f.credentials());
  assert.equal(run.status, "passed");
  assert.equal(run.variables.rounds, 2);
  assert.equal(run.variables.token, f.received[1].token);
  assert.equal(run.variables.done, true);
  assert.deepEqual(
    f.consumed.map((r) => r.token),
    f.received.map((r) => r.token),
  );
  const stored = await new Store(f.root).get(f.project.id);
  assert.equal(stored.environments[0].variables.rounds, 2);
  assert.equal(stored.environments[0].variables.token, f.received[1].token);
  assert.equal(stored.globalVariables.done, true);
});

for (const wireMode of ["v2-polling", "v4-websocket"])
  for (const mode of [
    "ack-timeout",
    "wait-timeout",
    "flow-deadline",
    "disconnect",
    "handshake-timeout",
  ])
    for (const failurePolicy of ["stop", "continue"])
      test(
        `Socket.IO runtime rows ${wireMode} ${mode}/${failurePolicy} preserves partial evidence and earlier extraction`,
        { timeout: 15000 },
        async (t) => {
          const f = await fixture(t),
            input = f.definition([wireMode]);
          input.failurePolicy = failurePolicy;
          const flow = input.steps[1].steps[1].socketio;
          if (mode === "ack-timeout") {
            f.stall();
            flow.commands[1].ackTimeoutMs = 100;
          }
          if (mode === "wait-timeout") {
            f.holdWait();
            flow.commands[6].timeoutMs = 100;
          }
          if (mode === "flow-deadline") {
            f.holdWait();
            flow.timeoutMs = 300;
          }
          if (mode === "disconnect") f.disconnect();
          if (mode === "handshake-timeout") {
            f.holdHandshake();
            flow.timeoutMs = 300;
          }
          const made = await f.post(`projects/${f.project.id}/plans`, input);
          assert.equal(made.status, 200, JSON.stringify(made.value));
          const run = await execute(
            f,
            "owner",
            made.value.id,
            f.credentials([wireMode]),
          );
          assert.equal(run.status, "failed");
          assert.equal(run.results.length, failurePolicy === "stop" ? 6 : 7);
          const failed = run.results[5];
          assert.equal(failed.socketioResult.status, "failed");
          assert.equal(failed.socketioResult.state, "closed");
          assert.deepEqual(failed.extracted, {});
          assert.equal(run.variables.token, f.received[0].token);
          assert.equal(run.variables.done, false);
          assert.equal(f.consumed.length, failurePolicy === "stop" ? 1 : 2);
          if (failurePolicy === "continue")
            assert.equal(f.consumed[1].token, f.received[0].token);
          if (mode === "ack-timeout") {
            assert.equal(
              failed.socketioResult.results[1].status,
              "ack-timeout",
            );
            assert.equal(
              failed.socketioResult.results[1].remoteOutcome,
              "unknown",
            );
          }
          if (["wait-timeout", "flow-deadline"].includes(mode))
            assert.equal(failed.socketioResult.results.length, 6);
          if (mode === "handshake-timeout")
            assert.equal(failed.socketioResult.results.length, 0);
          assert.equal(
            failed.repeat.occurrenceId,
            JSON.stringify(["group", wireMode, 1]),
          );
          await until(() => f.active.size === 0 && f.engineClients === 0);
          const evidence = JSON.stringify(run);
          f.lateAck();
          assert.equal(JSON.stringify(run), evidence);
          assert.equal(f.handshakes.length, 2);
          const stored = await new Store(f.root).get(f.project.id);
          assert.deepEqual(stored.runs[0].results, run.results);
          assert.ok(
            !JSON.stringify(stored).includes("private-socketio-token-A"),
          );
        },
      );

for (const wireMode of ["v2-polling", "v4-websocket"])
  test(
    `Socket.IO runtime rows ${wireMode} owner cancellation stops pending ACK, consumer and remaining rows`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, [
        { value: "a" },
        { value: "b" },
        { value: "c" },
      ]);
      f.stall();
      const made = await f.post(
        `projects/${f.project.id}/plans`,
        f.definition([wireMode]),
      );
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const executing = f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        runId: "rows-cancel",
        socketioCredentials: f.credentials([wireMode]),
      });
      await until(
        () => f.received.length === 2 && f.received[1].inputs.length === 1,
      );
      assert.equal((await f.post("cancel", { id: "rows-cancel" })).status, 200);
      const { status, value: run } = await executing;
      assert.equal(status, 200);
      assert.equal(run.status, "cancelled");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 6);
      assert.equal(run.results[5].socketioResult.status, "cancelled");
      assert.deepEqual(run.results[5].extracted, {});
      assert.equal(run.variables.token, f.received[0].token);
      assert.equal(f.received.length, 2);
      assert.equal(f.consumed.length, 1);
      await until(() => f.active.size === 0 && f.engineClients === 0);
      f.lateAck();
      assert.equal(f.handshakes.length, 2);
    },
  );

for (const wireMode of ["v2-polling", "v4-websocket"])
  test(`Socket.IO runtime rows ${wireMode} explicit expected failed status extracts bounded partial ACK evidence`, async (t) => {
    const f = await fixture(t),
      input = f.definition([wireMode]),
      leaf = input.steps[1].steps[1];
    leaf.expectedStatus = "failed";
    leaf.socketio.commands.push({
      type: "wait",
      event: "never",
      timeoutMs: 100,
    });
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 200, JSON.stringify(made.value));
    const run = await execute(
      f,
      "owner",
      made.value.id,
      f.credentials([wireMode]),
    );
    assert.equal(run.status, "passed");
    for (const leaf of run.results.filter((r) => r.type === "socketio")) {
      assert.equal(leaf.socketioResult.status, "failed");
      assert.equal(leaf.socketioResult.results.length, 7);
      assert.equal(leaf.socketioResult.state, "closed");
    }
    assert.deepEqual(
      f.consumed.map((r) => r.token),
      f.received.map((r) => r.token),
    );
    assert.equal(run.variables.token, f.received[1].token);
    await until(() => f.active.size === 0 && f.engineClients === 0);
  });

for (const kind of ["instance", "code"])
  test(`Socket.IO runtime rows uncertain ${kind} scope commit fails closed without replay`, async (t) => {
    const f = await fixture(t),
      input = f.definition();
    input.failurePolicy = "continue";
    input.steps[1].steps[1].extract[0].scope = "environment";
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 200, JSON.stringify(made.value));
    let commits = 0;
    const run = await runPlan(
      made.value,
      { token: "initial" },
      executeRequest,
      {
        allowRuntimeRows: true,
        executeSocketIO: executeSocketIOFlow,
        socketioCredentials: f.credentials(),
        onScopeChanges: async (changes) => {
          // Binding the row also persists a value. Fail only the Socket.IO extraction commit.
          if (!JSON.stringify(changes).includes("reply-")) return;
          commits++;
          if (kind === "code")
            throw Object.assign(Error("unknown"), {
              code: "PROJECT_COMMIT_UNCERTAIN",
            });
          throw new ProjectCommitUncertain("fixture", Error("unknown"));
        },
      },
    );
    assert.equal(commits, 1);
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(run.results.length, 3);
    assert.deepEqual(run.results[2].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(
      run.results[2].socketioResult.results[1].args[0].token,
      f.received[0].token,
    );
    assert.equal(run.variables.token, "initial");
    assert.equal(f.received.length, 1);
    assert.equal(f.consumed.length, 0);
  });

test("Socket.IO runtime rows extraction batch failure publishes no partial persistent values", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.failurePolicy = "stop";
  input.steps[1].steps[1].extract = [
    { name: "token", path: "$[1].args[0].token", scope: "environment" },
    { name: "missing", path: "$[1].args[0].absent", scope: "global" },
  ];
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const run = await execute(f, "owner", made.value.id, f.credentials());
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "step-failure");
  assert.equal(run.results.length, 3);
  assert.equal(run.results[2].socketioResult.status, "passed");
  assert.deepEqual(run.results[2].extracted, {});
  assert.equal(run.variables.token, "initial");
  assert.equal(run.variables.missing, undefined);
  const stored = await new Store(f.root).get(f.project.id);
  assert.equal(stored.environments[0].variables.token, "initial");
  assert.equal(stored.globalVariables?.missing, undefined);
  assert.equal(f.received.length, 1);
  assert.equal(f.consumed.length, 0);
});

for (const mode of ["owner", "SDK HTTP", "SDK stdio", "CLI"])
  test(
    `${mode} Socket.IO runtime rows hide rejected credential diagnostics in results and every saved artifact`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        secret = "synthetic-runtime-rows-auth-78523";
      const variants = [
        secret,
        Buffer.from(secret).toString("base64"),
        [...secret].reverse().join(""),
      ];
      const clean = (value) => {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        for (const marker of variants)
          assert.ok(
            !text.includes(marker),
            "credential diagnostic escaped redaction",
          );
      };
      f.rejectHandshake(secret, variants);
      const input = f.definition();
      input.failurePolicy = "continue";
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const credentials = f.credentials();
      credentials[defaultMode].auth.nested = { secret };
      const run = await execute(f, mode, made.value.id, credentials);
      assert.equal(run.status, "failed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 7);
      const leaves = run.results.filter((r) => r.type === "socketio");
      assert.equal(leaves.length, 2);
      assert.equal(
        new Set(leaves.map((r) => r.socketioResult.sessionId)).size,
        2,
      );
      for (const leaf of leaves) {
        assert.equal(leaf.socketioResult.status, "failed");
        assert.equal(leaf.socketioResult.results.length, 0);
        assert.match(leaf.socketioResult.error, /对端诊断已隐藏/);
        assert.deepEqual(leaf.extracted, {});
      }
      assert.equal(f.handshakes.length, 2);
      assert.equal(f.received.length, 0);
      clean(run);
      if (f.cliOutput) clean(f.cliOutput);
      const stored = await new Store(f.root).get(f.project.id);
      clean(stored);
      assert.deepEqual(stored.runs[0].results, run.results);
      async function checkFiles(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await checkFiles(file);
          else if (entry.isFile()) clean(await readFile(file, "utf8"));
        }
      }
      await checkFiles(f.root);
    },
  );

test("Socket.IO runtime rows preserve ordinary ACK and event data equal to a transient credential", async (t) => {
  const token = "private-socketio-token-A",
    f = await fixture(t, [{ value: token }]);
  const input = f.definition();
  input.steps[1].steps[1].extract.push({
    name: "echo",
    path: "$[1].args[0].echo",
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const run = await execute(f, "owner", made.value.id, f.credentials());
  assert.equal(run.status, "passed");
  const result = run.results[2].socketioResult;
  assert.equal(result.results[1].args[0].echo, token);
  assert.equal(result.results[2].args[0].echo, token);
  assert.equal(run.variables.echo, token);
  const stored = await new Store(f.root).get(f.project.id);
  assert.deepEqual(stored.runs[0].results, run.results);
});

test("Socket.IO runtime rows nest until and IF with frozen iterationData and newly committed scope conditions", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    group = input.steps[1];
  const [bind, leaf, consumer] = group.steps;
  leaf.extract[1].scope = "environment";
  consumer.request.extract = [
    { name: "items", source: "json", path: "$.items" },
  ];
  consumer.request.afterScript =
    "pm.test('frozen outer row', () => pm.expect(pm.iterationData.get('value')).to.equal(pm.environment.get('value')));";
  group.steps = [
    bind,
    {
      id: "until",
      type: "repeat",
      count: 3,
      untilCondition: {
        left: { scope: "environment", name: "done" },
        op: "eq",
        right: { literal: true },
      },
      steps: [
        {
          id: "gate",
          type: "if",
          condition: {
            left: { scope: "iterationData", name: "value" },
            op: "eq",
            right: { scope: "environment", name: "value" },
          },
          steps: [leaf, consumer],
        },
      ],
    },
  ];
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const run = await execute(f, "owner", made.value.id, f.credentials());
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(
    f.received.map((r) => r.inputs[0].text),
    ["a", "a", "b", "b"],
  );
  assert.deepEqual(
    f.consumed.map((r) => r.token),
    f.received.map((r) => r.token),
  );
  assert.deepEqual(run.variables.items, [{ value: "replacement" }]);
  assert.equal(run.variables.done, true);
  assert.equal(run.conditionResults.length, 8);
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, false, true, true, true, false, true, true],
  );
  const leaves = run.results.filter((r) => r.type === "socketio");
  assert.equal(new Set(leaves.map((r) => r.repeat.occurrenceId)).size, 4);
  const stored = await new Store(f.root).get(f.project.id);
  assert.equal(stored.environments[0].variables.done, true);
  assert.deepEqual(stored.runs[0].conditionResults, run.conditionResults);
});

test("Socket.IO until nests runtime rows and IF while HTTP scope changes drive the outer tail", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    [producer, group] = input.steps;
  const [bind, leaf, consumer] = group.steps;
  leaf.extract[0].scope = "environment";
  consumer.request.extract = [
    { name: "items", source: "json", path: "$.items" },
  ];
  consumer.request.afterScript =
    "pm.environment.set('rounds', (pm.environment.get('rounds') || 0) + 1);";
  group.steps = [
    bind,
    {
      id: "gate",
      type: "if",
      condition: {
        left: { scope: "iterationData", name: "value" },
        op: "eq",
        right: { scope: "environment", name: "value" },
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
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const run = await execute(f, "owner", made.value.id, f.credentials());
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(
    f.received.map((r) => r.inputs[0].text),
    ["a", "b", "a", "b"],
  );
  assert.deepEqual(
    f.consumed.map((r) => r.token),
    f.received.map((r) => r.token),
  );
  assert.equal(f.httpCalls.filter((url) => url === "/produce").length, 2);
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, true, false, true, true, true],
  );
  assert.equal(run.variables.rounds, 4);
  const leaves = run.results.filter((r) => r.type === "socketio");
  assert.equal(new Set(leaves.map((r) => r.repeat.occurrenceId)).size, 4);
  const stored = await new Store(f.root).get(f.project.id);
  assert.equal(stored.environments[0].variables.rounds, 4);
  assert.equal(stored.environments[0].variables.token, f.received[3].token);
});
