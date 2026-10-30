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
import { SocketIOSessions } from "../src/socketio.mjs";
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
      const reply = { token: row.token, binary: value.binary };
      socket.emit("answer", reply);
      ack?.(reply);
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
    definition,
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
  "Socket.IO repeat v2/v4 websocket/polling/auto consume independent responses through owner, SDK HTTP/stdio, CLI and restore",
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
  "nested Socket.IO required handshake headers are checked before an earlier HTTP step; concurrent credentials never persist",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      input = f.definition();
    input.steps.unshift({
      id: "sentinel",
      request: structuredClone(input.steps[0].steps[1].request),
    });
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 200);
    for (const socketioCredentials of [
      {},
      {
        [JSON.stringify(["group", defaultMode, 0])]:
          f.credentials()[defaultMode],
      },
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
      assert.equal(f.received.length, 0);
      assert.equal(f.consumed.length, 0);
    }
    const clean = await f.post(
      `projects/${f.project.id}/plans`,
      f.definition(),
    );
    const tokens = ["private-socketio-B", "private-socketio-C"];
    const runs = await Promise.all(
      tokens.map((token) =>
        f.post(`projects/${f.project.id}/run`, {
          planId: clean.value.id,
          socketioCredentials: f.credentials([defaultMode], token),
        }),
      ),
    );
    for (const r of runs) checkRun(r.value);
    for (const token of tokens)
      assert.equal(f.received.filter((r) => r.auth === token).length, 2);
    for (const [index, r] of runs.entries()) {
      const replies = r.value.results
        .filter((x) => x.type === "socketio")
        .map((x) => x.socketioResult.results[1].args[0].token);
      const auth = f.received
        .filter((x) => replies.includes(x.token))
        .map((x) => x.auth);
      assert.equal(replies.length, 2);
      assert.deepEqual(auth, [tokens[index], tokens[index]]);
    }
    const disk = JSON.stringify(await new Store(f.root).get(f.project.id));
    for (const token of tokens) assert.ok(!disk.includes(token));
  },
);
test(
  "Socket.IO repeat CA and mutual TLS remain mandatory and temporary",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, true),
      made = await f.post(`projects/${f.project.id}/plans`, f.definition());
    assert.equal(made.status, 200);
    const valid = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      socketioCredentials: f.credentials(),
    });
    checkRun(valid.value);
    for (const tls of [{ key, cert }, { ca: cert }]) {
      const credentials = f.credentials();
      credentials[defaultMode].tls = tls;
      const response = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
        socketioCredentials: credentials,
      });
      assert.equal(response.value.status, "failed");
      assert.equal(
        response.value.results.filter((r) => r.type === "socketio").length,
        2,
      );
      assert.ok(
        response.value.results
          .filter((r) => r.type === "socketio")
          .every((r) => r.socketioResult.status !== "passed"),
      );
    }
    const credentials = f.credentials();
    credentials[defaultMode].tls.rejectUnauthorized = false;
    const rejected = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      socketioCredentials: credentials,
    });
    assert.equal(rejected.status, 400);
    assert.equal(f.received.length, 2);
    const disk = JSON.stringify(await new Store(f.root).get(f.project.id));
    assert.ok(!disk.includes("PRIVATE KEY"));
    assert.ok(!disk.includes("BEGIN CERTIFICATE"));
    assert.ok(!disk.includes("private-socketio-token-A"));
  },
);
test(
  "Socket.IO repeat second call cancellation or external deadline prevents later HTTP and occurrences",
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
  "completed Socket.IO repeat is not replayed after genuine journal uncertainty or generic append failure",
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
test(
  "Socket.IO repeat second ack timeout, whole-flow deadline, disconnect and atomic extraction preserve prior state",
  { timeout: 20000 },
  async (t) => {
    for (const mode of [
      "ack-timeout",
      "flow-deadline",
      "disconnect",
      "atomic-extraction",
    ])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          input = f.definition();
        if (mode === "atomic-extraction")
          input.steps[0].steps[0].extract.push({
            name: "absent",
            path: "$[1].args[0].absent",
          });
        else if (mode === "disconnect") f.disconnect();
        else {
          f.stall();
          if (mode === "ack-timeout")
            input.steps[0].steps[0].socketio.commands[1].ackTimeoutMs = 100;
          else input.steps[0].steps[0].socketio.timeoutMs = 500;
        }
        const made = await f.post(`projects/${f.project.id}/plans`, input);
        assert.equal(made.status, 200);
        const response = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
          socketioCredentials: f.credentials(),
        });
        assert.equal(response.status, 200);
        assert.equal(response.value.status, "failed");
        assert.equal(response.value.results.length, 4);
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 2);
        if (mode === "atomic-extraction") {
          assert.equal(response.value.variables.token, "initial");
          assert.equal(response.value.variables.absent, undefined);
          for (const r of response.value.results.filter(
            (r) => r.type === "socketio",
          ))
            assert.deepEqual(r.extracted, {});
          assert.deepEqual(
            f.consumed.map((r) => r.token),
            ["initial", "initial"],
          );
        } else {
          const failed = response.value.results[2].socketioResult;
          assert.equal(failed.status, "failed");
          assert.equal(failed.state, "closed");
          assert.equal(response.value.variables.token, f.received[0].token);
          assert.deepEqual(
            f.consumed.map((r) => r.token),
            [f.received[0].token, f.received[0].token],
          );
          if (mode === "ack-timeout") {
            assert.equal(failed.results[1].status, "ack-timeout");
            assert.equal(failed.results[1].remoteOutcome, "unknown");
          }
          if (mode === "flow-deadline") assert.match(failed.error, /整体超时/);
        }
        await until(() => f.active.size === 0);
        f.lateAck();
        assert.equal(f.received.length, 2);
      });
  },
);
test(
  "v2/v4 shared Socket.IO pools settle pending ACK on repeat cancellation and release real listeners without closing another session",
  { timeout: 15000 },
  async (t) => {
    for (const selected of ["v2-websocket", "v4-websocket"])
      await t.test(selected, async (t) => {
        const f = await fixture(t);
        f.stall();
        const made = await f.post(
          `projects/${f.project.id}/plans`,
          f.definition([selected]),
        );
        assert.equal(made.status, 200);
        const sessions = new SocketIOSessions();
        t.after(() => sessions.close());
        const captures = [],
          start = sessions.start;
        sessions.start = function (projectId, input) {
          const result = start.call(this, projectId, input),
            socket = this.get(projectId, result.id).socket;
          const captured = { id: result.id, socket, allRemoved: 0, events: 0 };
          const offAny = socket.offAny;
          socket.offAny = function (...args) {
            if (args[0] === undefined) captured.allRemoved++;
            return offAny.apply(this, args);
          };
          socket.onAny(() => captured.events++);
          captures.push(captured);
          return result;
        };
        const controller = new AbortController();
        const pending = runPlan(
          made.value,
          { token: "initial" },
          executeRequest,
          {
            executeSocketIO: (input, signal) =>
              executeSocketIOFlow(input, signal, {
                sessions,
                projectId: f.project.id,
              }),
            socketioCredentials: f.credentials([selected]),
            signal: controller.signal,
          },
        );
        await until(
          () => f.received.length === 2 && f.received[1].inputs.length === 1,
        );
        const savedDefinition =
          made.value.steps[0].steps[0].socketio.definition;
        const survivor = sessions.start(f.project.id, {
          ...savedDefinition,
          ...f.credentials([selected], "private-survivor")[selected],
        });
        await until(
          () => sessions.snapshot(f.project.id, survivor.id).state === "open",
        );
        controller.abort();
        const run = await pending; // Resolving proves cancellation settled the in-flight send/ACK promise.
        assert.equal(run.status, "cancelled");
        assert.equal(run.results.length, 3);
        assert.equal(run.results[2].socketioResult.status, "cancelled");
        assert.equal(
          run.results[2].socketioResult.results[1].remoteOutcome,
          "unknown",
        );
        for (const captured of captures.slice(0, 2)) {
          assert.ok(captured.allRemoved >= 1);
          assert.equal(captured.socket.connected, false);
          assert.equal(captured.socket.listeners("disconnect").length, 0);
          assert.equal(captured.socket.listeners("connect_error").length, 0);
          if (typeof captured.socket.listenersAny === "function")
            assert.equal(captured.socket.listenersAny().length, 0);
          const state = sessions.get(f.project.id, captured.id);
          assert.equal(state.socket, null);
          assert.equal(state.pending.size, 0);
        }
        const evidence = JSON.stringify(run),
          count = captures[1].events;
        f.lateAck();
        const ack = await sessions.send(f.project.id, survivor.id, {
          event: "echo",
          args: [{ binary: { $binary: "AAEC/w==" } }],
          ackTimeoutMs: 1000,
        });
        assert.equal(ack.status, "acknowledged");
        assert.equal(ack.args[0].token, f.received[2].token);
        assert.equal(
          sessions.snapshot(f.project.id, survivor.id).state,
          "open",
        );
        assert.equal(captures[1].events, count);
        assert.equal(JSON.stringify(run), evidence);
        sessions.stop(f.project.id, survivor.id);
        await until(() => f.active.size === 0);
        assert.equal(f.received.length, 3);
        assert.equal(f.consumed.length, 1);
      });
  },
);
test(
  "Socket.IO repeat cancellation during second handshake or event wait closes transport without replay",
  { timeout: 15000 },
  async (t) => {
    for (const stage of ["handshake", "wait"])
      await t.test(stage, async (t) => {
        const f = await fixture(t);
        if (stage === "handshake") f.holdHandshake();
        else f.holdWait();
        const made = await f.post(
          `projects/${f.project.id}/plans`,
          f.definition(),
        );
        assert.equal(made.status, 200);
        const pending = f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
          runId: `socketio-${stage}-cancel`,
          socketioCredentials: f.credentials(),
        });
        await until(() =>
          stage === "handshake"
            ? f.handshakes.length === 2
            : f.received.length === 2 && f.received[1].serverAcks.length === 1,
        );
        assert.equal(
          (await f.post("cancel", { id: `socketio-${stage}-cancel` })).status,
          200,
        );
        const response = await pending;
        assert.equal(response.value.status, "cancelled");
        assert.equal(response.value.results.length, 3);
        assert.equal(response.value.results[2].socketioResult.state, "closed");
        assert.equal(response.value.variables.token, f.received[0].token);
        assert.equal(f.consumed.length, 1);
        assert.equal(f.handshakes.length, 2);
        assert.equal(f.received.length, stage === "handshake" ? 1 : 2);
        await until(() => f.active.size === 0 && f.engineClients === 0);
      });
  },
);
test(
  "Socket.IO optional auth/query values are rejected by the peer, not falsely claimed as mandatory-header preflight",
  { timeout: 15000 },
  async (t) => {
    for (const missing of ["auth", "query"])
      await t.test(missing, async (t) => {
        const f = await fixture(t),
          made = await f.post(`projects/${f.project.id}/plans`, f.definition());
        assert.equal(made.status, 200);
        const credentials = f.credentials();
        delete credentials[defaultMode][missing];
        const response = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
          socketioCredentials: credentials,
        });
        assert.equal(response.status, 200);
        assert.equal(response.value.status, "failed");
        const results = response.value.results.filter(
          (r) => r.type === "socketio",
        );
        assert.equal(results.length, 2);
        for (const r of results)
          assert.equal(r.socketioResult.status, "failed");
        assert.equal(f.handshakes.length, 2);
        assert.equal(f.received.length, 0);
        assert.equal(f.consumed.length, 2);
        assert.equal(response.value.variables.token, "initial");
        await until(() => f.engineClients === 0);
      });
  },
);
