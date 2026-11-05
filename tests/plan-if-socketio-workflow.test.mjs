import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const cert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
const key = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const modes = [
  "v2-websocket",
  "v2-polling",
  "v2-auto",
  "v4-websocket",
  "v4-polling",
  "v4-auto",
];
const condition = {
  left: { literal: true },
  op: "eq",
  right: { literal: true },
};
const defaultMode = "v4-websocket";
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Socket.IO repeat fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t, secure = false) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-socketio-workflow-"));
  let app = await createApp({ root, port: 0 });
  const received = [],
    consumed = [],
    handshakes = [],
    clients = [],
    active = new Set();
  let beforeHTTP = async () => {},
    stallSecond = false,
    disconnectSecond = false,
    holdHandshake = false,
    holdWait = false,
    pendingAck;
  const server = secure
    ? https.createServer({
        key,
        cert,
        ca: cert,
        requestCert: true,
        rejectUnauthorized: true,
      })
    : http.createServer();
  const io = new Server(server, { allowEIO3: true, path: "/repeat/" });
  const namespace = io.of("/private");
  namespace.use((socket, next) => {
    handshakes.push(socket.id);
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
      afterDeadline: 0,
    };
    received.push(row);
    active.add(socket);
    socket.on("disconnect", () => active.delete(socket));
    socket.emit("welcome", { ready: true });
    socket.on("after-deadline", (ack) => {
      row.afterDeadline++;
      ack();
    });
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
      const reply = { token: row.token, binary: value.binary };
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
    consumed.push({ token: req.headers["x-token"], url: req.url });
    await beforeHTTP();
    res.setHeader("content-type", "application/json");
    res.end("{}");
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
  const project = await app.store.create("Socket.IO repeat");
  project.environments[0].variables = { token: "initial" };
  project.settings.socketioDefinitions = modes.map((mode) => ({
    id: mode,
    name: mode,
    url: `${secure ? "https" : "http"}://127.0.0.1:${server.address().port}/private`,
    path: "/repeat/",
    version: Number(mode[1]),
    transport: mode.slice(3),
    handshake: { headers: {}, requiredHeaders: ["x-private"] },
  }));
  await app.store.save(project);
  const definition = (selected = [defaultMode]) => ({
    name: "Frozen Socket.IO repeat",
    environmentId: project.environments[0].id,
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: selected.flatMap((mode) => [
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
                    { text: "{{token}}", binary: { $binary: "AAEC/w==" } },
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
            extract: [{ name: "token", path: "$[1].args[0].token" }],
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
    handshakes,
    consumed,
    active,
    definition: (...args) => {
      const input = definition(...args);
      input.steps = [
        {
          id: "gate",
          type: "if",
          condition: structuredClone(condition),
          steps: input.steps,
        },
      ];
      return input;
    },
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
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
    get engineClients() {
      return io.engine.clientsCount;
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
    beforeHTTP(fn) {
      beforeHTTP = fn;
    },
  };
}
function checkRun(run, selected = [defaultMode]) {
  assert.equal(run.conditionResults.length, 1);
  assert.equal(run.conditionResults[0].matched, true);
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, selected.length * 4);
  const expected = [0, 1].flatMap((iteration) =>
    selected.flatMap((mode) =>
      [mode, `consume-${mode}`].map((childId) => ({
        groupId: "group",
        childId,
        iteration,
        occurrenceId: JSON.stringify(["group", childId, iteration]),
      })),
    ),
  );
  assert.deepEqual(
    run.results.map((r) => r.repeat),
    expected,
  );
  const protocol = run.results.filter((r) => r.type === "socketio");
  assert.equal(
    new Set(protocol.map((r) => r.socketioResult.sessionId)).size,
    selected.length * 2,
  );
  for (const result of protocol) {
    assert.equal(result.socketioResult.status, "passed");
    assert.equal(result.socketioResult.state, "closed");
    assert.equal(result.socketioResult.events[0].sequence, 1);
    assert.equal(result.socketio.definitionId, undefined);
    assert.equal(result.socketioResult.results.length, 7);
    assert.equal(result.socketioResult.results[1].status, "acknowledged");
    assert.deepEqual(result.socketioResult.results[1].args.slice(1), [
      "second-argument",
      42,
    ]);
    assert.equal(
      result.socketioResult.results[1].args[0].binary.$binary,
      "AAEC/w==",
    );
    assert.equal(result.socketioResult.results[5].status, "ack-sent");
  }
}
function cli(root, projectId, planId, socketioCredentials) {
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
        return reject(Error(`Socket.IO repeat CLI ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ socketioCredentials }));
  });
}
test(
  "IF Socket.IO v2/v4 websocket/polling/auto consume independent responses through owner, SDK HTTP/stdio, CLI and restore",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      methods = modes,
      p = f.project;
    const made = await f.post(`projects/${p.id}/plans`, f.definition(methods));
    assert.equal(made.status, 200);
    const plan = made.value,
      socketioCredentials = f.credentials(methods);
    const owner = await f.post(`projects/${p.id}/run`, {
      planId: plan.id,
      socketioCredentials,
    });
    assert.equal(owner.status, 200);
    checkRun(owner.value, methods);
    for (let i = 0; i < 12; i++)
      assert.equal(f.consumed[i].token, f.received[i].token);
    const live = await f.app.store.get(p.id);
    for (const d of live.settings.socketioDefinitions) {
      d.url = "http://127.0.0.1:1/changed";
      d.path = "/changed/";
      d.events = ["different"];
      d.handshake = { headers: {}, requiredHeaders: ["x-live"] };
    }
    await f.app.store.save(live);
    const config = await f.post("mcp/config", {
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
      remember: false,
    });
    assert.equal(config.status, 200);
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
        arguments: { projectId: p.id, planId: plan.id, socketioCredentials },
      }),
    );
    checkRun(sdkRun, methods);
    assert.equal(sdkRun.planHash, owner.value.planHash);
    const deleted = await f.app.store.get(p.id);
    deleted.settings.socketioDefinitions = [];
    await f.app.store.save(deleted);
    const exported = await fetch(`${f.app.url}/api/projects/${p.id}/export`, {
      headers: { "x-local-token": f.app.token },
    });
    assert.equal(exported.status, 200);
    const backup = await exported.json();
    assert.ok(!JSON.stringify(backup).includes("private-socketio-token-A"));
    const restored = await f.post("restore", { document: backup });
    assert.equal(restored.status, 201);
    assert.deepEqual(restored.value.plans[0].steps, plan.steps);
    await sdk.close();
    await f.restart();
    const denied = await f.post(`projects/${restored.value.id}/run`, {
      planId: plan.id,
    });
    assert.equal(denied.status, 400);
    assert.equal(f.received.length, 24);
    const restarted = await f.post(`projects/${restored.value.id}/run`, {
      planId: plan.id,
      socketioCredentials,
    });
    checkRun(restarted.value, methods);
    assert.equal(restarted.value.planHash, owner.value.planHash);
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
          socketioCredentials,
        },
      }),
    );
    checkRun(stdioRun, methods);
    assert.equal(stdioRun.planHash, owner.value.planHash);
    await stdio.close();
    const cliRun = await cli(
      f.root,
      restored.value.id,
      plan.id,
      socketioCredentials,
    );
    checkRun(cliRun, methods);
    assert.equal(cliRun.planHash, owner.value.planHash);
    assert.equal(f.received.length, 60);
    assert.equal(f.consumed.length, 60);
    assert.equal(new Set(f.received.map((row) => row.id)).size, 60);
    for (let i = 0; i < f.received.length; i++) {
      const row = f.received[i],
        mode = modes[i % modes.length];
      assert.equal(row.version, mode.startsWith("v2") ? 3 : 4);
      if (!mode.endsWith("auto")) assert.equal(row.transport, mode.slice(3));
      assert.deepEqual(row.serverAcks, ["client-confirmed"]);
      assert.ok(Buffer.isBuffer(row.inputs[0].binary));
      assert.equal(row.inputs[0].binary.toString("base64"), "AAEC/w==");
    }
    await until(() => f.active.size === 0);
    for (let i = 0; i < 60; i++)
      assert.equal(f.consumed[i].token, f.received[i].token);
    const disk = await new Store(f.root).get(restored.value.id);
    assert.ok(!JSON.stringify(disk).includes("private-socketio-token-A"));
  },
);
test(
  "IF Socket.IO second call cancellation or external deadline prevents later HTTP and occurrences",
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
        const executing =
          mode === "owner-cancel"
            ? f.post(`projects/${f.project.id}/run`, {
                planId: made.value.id,
                runId: "socketio-repeat-cancel",
                socketioCredentials: f.credentials(),
              })
            : runPlan(made.value, { token: "initial" }, executeRequest, {
                executeSocketIO: executeSocketIOFlow,
                socketioCredentials: f.credentials(),
                signal: controller.signal,
              });
        await until(
          () => f.received.length === 2 && f.received[1].inputs.length === 1,
        );
        if (mode === "owner-cancel")
          assert.equal(
            (await f.post("cancel", { id: "socketio-repeat-cancel" })).status,
            200,
          );
        else {
          const deadline = AbortSignal.timeout(100);
          deadline.addEventListener(
            "abort",
            () => controller.abort(deadline.reason),
            { once: true },
          );
        }
        const response = await executing,
          run = mode === "owner-cancel" ? response.value : response;
        assert.equal(run.status, "cancelled");
        assert.equal(run.results.length, 3);
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 1);
        assert.equal(run.variables.token, f.received[0].token);
        assert.equal(run.results[2].socketioResult.status, "cancelled");
        await until(() => f.active.size === 0);
        f.lateAck();
        const next = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
          socketioCredentials: f.credentials(),
        });
        checkRun(next.value);
        assert.ok(!JSON.stringify(next.value).includes("late-old-session"));
        assert.equal(f.received.length, 4);
        assert.equal(f.consumed.length, 3);
      });
  },
);
test(
  "completed IF Socket.IO is not replayed after genuine journal uncertainty or generic append failure",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["generic", "unknown"])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          p = f.project,
          made = await f.post(`projects/${p.id}/plans`, f.definition());
        assert.equal(made.status, 200);
        const directory = f.app.store.directory(p.id),
          history = path.join(directory, "history"),
          kept = path.join(directory, "owned-history-backup"),
          journal = path.join(directory, ".transaction.json"),
          file = path.join(history, "requests.json");
        const original = await readFile(file, "utf8"),
          save = f.app.store.save,
          read = f.app.store.readUnlocked;
        let attempted = 0;
        t.after(() => {
          f.app.store.save = save;
          f.app.store.readUnlocked = read;
        });
        if (mode === "generic")
          f.beforeHTTP(async () => {
            if (f.consumed.length === 2)
              await writeFile(file, '{"owned-broken":');
          });
        else
          f.app.store.save = async function (project, options) {
            if (project.id !== p.id || !options?.activity)
              return save.call(this, project, options);
            attempted++;
            this.readUnlocked = async function (id) {
              const state = await read.call(this, id);
              this.readUnlocked = read;
              await rename(history, kept);
              await writeFile(history, "private-obstacle-marker");
              return state;
            };
            try {
              return await save.call(this, project, options);
            } finally {
              this.readUnlocked = read;
            }
          };
        const response = await f.post(`projects/${p.id}/run`, {
            planId: made.value.id,
            socketioCredentials: f.credentials(),
          }),
          run = response.value;
        assert.equal(response.status, 200);
        assert.equal(run.status, "passed");
        assert.equal(run.results.length, 4);
        assert.equal(run.recordSaved, false);
        assert.equal(run.recordId, null);
        assert.equal(run.attemptedRecordId, run.id);
        assert.equal(run.persistenceOutcome.retry_safe, false);
        assert.equal(
          run.persistenceOutcome.code,
          mode === "generic"
            ? "RECORD_SAVE_FAILED"
            : "PROJECT_COMMIT_UNCERTAIN",
        );
        f.app.store.save = save;
        f.app.store.readUnlocked = read;
        if (mode === "generic") {
          await assert.rejects(readFile(journal), { code: "ENOENT" });
          await writeFile(file, original);
        } else {
          assert.equal(attempted, 1);
          assert.equal(run.persistenceOutcome.commit_outcome, "unknown");
          assert.ok((await readFile(journal, "utf8")).length > 0);
          await rm(history);
          await rename(kept, history);
        }
        const recovered = await new Store(f.root).get(p.id);
        assert.equal(
          recovered.runs.some((r) => r.id === run.id),
          mode === "unknown",
        );
        if (mode === "unknown")
          assert.deepEqual(
            recovered.runs
              .find((r) => r.id === run.id)
              .results.map((r) => r.repeat),
            run.results.map((r) => r.repeat),
          );
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 2);
      });
  },
);

test("false IF Socket.IO preflights independent executor and credentials before HTTP, disabled descendants require neither", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  const gate = input.steps[0],
    repeat = gate.steps[0];
  gate.condition.left.literal = false;
  input.steps.unshift({
    id: "sentinel",
    request: structuredClone(repeat.steps[1].request),
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  for (const executeSocketIO of [undefined, true, {}]) {
    await assert.rejects(
      runPlan(made.value, {}, executeRequest, {
        executeSocketIO,
        socketioCredentials: f.credentials(),
        executeProtocol: () => {
          throw Error("not Socket.IO");
        },
      }),
      /未授权socketio/,
    );
  }
  for (const socketioCredentials of [
    {},
    { unknown: f.credentials()[defaultMode] },
    {
      [defaultMode]: {
        headers: { "x-private": "x" },
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
  assert.equal(f.consumed.length, 0);
  assert.equal(f.handshakes.length, 0);
  const skipped = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    socketioCredentials: f.credentials(),
  });
  assert.equal(skipped.value.status, "passed");
  assert.equal(skipped.value.conditionResults[0].matched, false);
  assert.deepEqual(
    skipped.value.results.map((r) => r.stepId),
    ["sentinel"],
  );
  for (const disabledAt of ["gate", "repeat", "leaf"]) {
    const copy = structuredClone(input);
    const g = copy.steps[1];
    (disabledAt === "gate"
      ? g
      : disabledAt === "repeat"
        ? g.steps[0]
        : g.steps[0].steps[0]
    ).enabled = false;
    const saved = await f.post(`projects/${f.project.id}/plans`, copy);
    assert.equal(saved.status, 200);
    const run = await runPlan(
      saved.value,
      { token: "initial" },
      executeRequest,
    );
    assert.equal(run.status, "passed");
  }
  assert.equal(f.handshakes.length, 0);
});

test("IF Socket.IO uncertain scope commit retains ACK evidence and fail-stops without replay for instance and code", async (t) => {
  for (const kind of ["instance", "code"])
    await t.test(kind, async (t) => {
      const f = await fixture(t),
        input = f.definition();
      input.failurePolicy = "continue";
      input.steps[0].steps[0].steps[0].extract[0].scope = "environment";
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200);
      let commits = 0;
      const run = await runPlan(
        made.value,
        { token: "initial" },
        executeRequest,
        {
          executeSocketIO: executeSocketIOFlow,
          socketioCredentials: f.credentials(),
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
      assert.equal(run.results.length, 1);
      assert.deepEqual(run.results[0].scopeCommit, {
        outcome: "unknown",
        retrySafe: false,
      });
      assert.equal(
        run.results[0].socketioResult.results[1].args[0].token,
        f.received[0].token,
      );
      assert.equal(run.variables.token, "initial");
      assert.equal(f.received.length, 1);
      assert.equal(f.consumed.length, 0);
    });
});

test("IF Socket.IO retains no-script contract and unknown scope fails before any network", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (leaf) => {
      leaf.socketioScripts = { version: 1, before: "throw Error('no')" };
    },
    (leaf) => {
      leaf.socketio.scripts = { before: "throw Error('no')" };
    },
    (leaf) => {
      leaf.extract[0].scope = "unknown";
    },
  ]) {
    const input = f.definition();
    mutate(input.steps[0].steps[0].steps[0]);
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 400);
  }
  assert.equal(f.handshakes.length, 0);
  assert.equal(f.consumed.length, 0);
});

test("active HTTP-only IF fail-stops non-IF Socket.IO sibling on unknown commit", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  const repeat = input.steps[0].steps[0];
  input.steps[0].condition.left.literal = false;
  input.steps[0].steps = [
    { id: "skipped-http", request: structuredClone(repeat.steps[1].request) },
  ];
  input.steps.push(repeat);
  repeat.steps[0].extract[0].scope = "environment";
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200);
  const run = await runPlan(made.value, { token: "initial" }, executeRequest, {
    executeSocketIO: executeSocketIOFlow,
    socketioCredentials: f.credentials(),
    onScopeChanges: async () => {
      throw new ProjectCommitUncertain("fixture", Error("unknown"));
    },
  });
  assert.equal(run.results.length, 1);
  assert.equal(run.stopReason, "scope-commit-unknown");
  assert.equal(run.variables.token, "initial");
  assert.equal(f.received.length, 1);
  assert.equal(f.consumed.length, 0);
});

test("IF Socket.IO condition with an unknown scope is rejected statically", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps[0].condition.left = { scope: "unknown", name: "token" };
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 400);
  assert.equal(f.handshakes.length, 0);
  assert.equal(f.consumed.length, 0);
});
