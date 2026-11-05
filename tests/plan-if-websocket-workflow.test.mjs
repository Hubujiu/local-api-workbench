import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { REPEAT_EVIDENCE_BYTES } from "../src/plan-repeat.mjs";
import { assertNativeLinearPlan } from "../src/native-mcp-plan.mjs";
import { prepareStagedLoad } from "../src/staged-load-plan.mjs";
import { runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("WebSocket repeat fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-websocket-workflow-"));
  let app = await createApp({ root, port: 0 });
  const sockets = new Set(),
    received = [],
    consumed = [],
    clients = [];
  let connections = 0;
  let onWebSocket = async () => {},
    onHTTP = async () => {};
  const websocket = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  websocket.on("connection", (socket, request) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("message", async (bytes) => {
      const token = `websocket-token-${received.length + 1}`;
      received.push({
        message: bytes.toString(),
        token,
        authorization: request.headers.authorization,
      });
      await onWebSocket(socket, received.length);
      if (socket.readyState === 1) {
        socket.send(token);
        socket.close(1000, "done");
      }
    });
  });
  const peer = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    consumed.push({ url: req.url, token: req.headers["x-token"] });
    await onHTTP(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ready: true }));
  });
  await Promise.all([
    new Promise((r) => websocket.on("listening", r)),
    new Promise((r) => peer.listen(0, "127.0.0.1", r)),
  ]);
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await closeApp();
    for (const socket of sockets) socket.terminate();
    peer.closeAllConnections();
    await Promise.all(
      [websocket, peer].map((s) => new Promise((r) => s.close(r))),
    );
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
  const project = await app.store.create("WebSocket repeat");
  project.environments[0].variables = { token: "initial" };
  project.protocols = [
    normalizeProtocol({
      id: "saved-websocket",
      type: "websocket",
      url: `ws://127.0.0.1:${websocket.address().port}`,
      duration: 5000,
    }),
  ];
  await app.store.save(project);
  const definition = () => ({
    name: "HTTP to IF to WebSocket extraction to HTTP",
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
        id: "gate",
        type: "if",
        condition: {
          left: { scope: "runtime", name: "ready" },
          op: "eq",
          right: { literal: true },
        },
        steps: [
          {
            id: "wire",
            type: "protocol",
            protocol: { definitionId: "saved-websocket", message: "{{token}}" },
            extract: [{ name: "token", path: "$.messages[0].data" }],
          },
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
    beforeWebSocket(fn) {
      onWebSocket = fn;
    },
    beforeHTTP(fn) {
      onHTTP = fn;
    },
    client() {
      const c = new Client({ name: "websocket-repeat-workflow", version: "1" });
      clients.push(c);
      return c;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", projectId, "--plan", planId],
      {
        cwd: repo,
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      timedOut = false,
      failure;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (e) => {
      failure = e;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || timedOut || code !== 0)
        return reject(
          failure ||
            Error(
              timedOut
                ? "WebSocket repeat CLI timeout"
                : `CLI exited ${code}: ${stderr}`,
            ),
        );
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}
function checkRun(run) {
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "wire", "consume"],
  );
  assert.equal(run.conditionResults.length, 1);
  assert.equal(run.conditionResults[0].matched, true);
  assert.equal(
    run.snapshot.steps[1].steps[0].protocol.definition.type,
    "websocket",
  );
  assert.equal(run.snapshot.steps[1].steps[0].protocol.definitionId, undefined);
  assert.equal(
    run.variables.token,
    run.results[1].protocolResult.result.messages[0].data,
  );
}
test(
  "IF WebSocket owner, SDK HTTP/stdio and CLI use frozen snapshots across backup, restore and restart",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    const made = await f.post(`projects/${p.id}/plans`, f.definition());
    assert.equal(made.status, 200, JSON.stringify(made.value));
    const plan = made.value;
    const owner = await f.post(`projects/${p.id}/run`, { planId: plan.id });
    checkRun(owner.value);
    const live = await f.app.store.get(p.id);
    live.protocols[0].url = "ws://127.0.0.1:1";
    await f.app.store.save(live);
    const denied = await f.app.store.create("not granted");
    const config = await f.post("mcp/config", {
      enabled: true,
      projects: [p.id],
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
    assert.equal(
      (
        await sdk.callTool({
          name: "localapi_run_plan",
          arguments: { projectId: denied.id, planId: plan.id },
        })
      ).isError,
      true,
    );
    assert.equal(f.connections, 1);
    const sdkRun = decode(
      await sdk.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: plan.id },
      }),
    );
    checkRun(sdkRun);
    await sdk.close();
    const deleted = await f.app.store.get(p.id);
    deleted.protocols = [];
    await f.app.store.save(deleted);
    const backup = await (
      await fetch(`${f.app.url}/api/projects/${p.id}/export`, {
        headers: { "x-local-token": f.app.token },
      })
    ).json();
    const restoration = await f.post("restore", { document: backup });
    assert.equal(restoration.status, 201);
    const restored = restoration.value;
    assert.deepEqual(restored.plans[0].steps, plan.steps);
    await f.restart();
    const restarted = await f.post(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    checkRun(restarted.value);
    const stdio = f.client();
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repo, "src/mcp.mjs"),
          "--project",
          restored.id,
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
        arguments: { projectId: restored.id, planId: plan.id },
      }),
    );
    checkRun(stdioRun);
    await stdio.close();
    const cliRun = await cli(f.root, restored.id, plan.id);
    checkRun(cliRun);
    for (const run of [sdkRun, restarted.value, stdioRun, cliRun])
      assert.equal(run.planHash, owner.value.planHash);
    assert.equal(f.connections, 5);
    assert.deepEqual(
      f.received.map((r) => r.message),
      Array(5).fill("initial"),
    );
    assert.deepEqual(
      f.consumed.filter((r) => r.url === "/consume").map((r) => r.token),
      f.received.map((r) => r.token),
    );
    const disk = await new Store(f.root).get(restored.id);
    assert.deepEqual(
      disk.runs.find((r) => r.id === cliRun.id).snapshot.steps,
      plan.steps,
    );
    assert.throws(() => exportApipostDirectory(disk));
    await until(() => f.sockets.size === 0);
  },
);

test("false IF WebSocket skips connection and scripts but still checks executor and credentials before earlier HTTP", async (t) => {
  const f = await fixture(t),
    p = f.project,
    input = f.definition();
  input.steps[1].condition.right.literal = false;
  input.steps[1].steps[0].protocolScripts = {
    version: 1,
    before: 'throw new Error("false WebSocket script executed")',
    after: 'throw new Error("false WebSocket post script executed")',
  };
  const made = await f.post(`projects/${p.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  await assert.rejects(
    runPlan(made.value, {}, executeRequest),
    /未授权protocol/,
  );
  const unscripted = structuredClone(made.value);
  delete unscripted.steps[1].steps[0].protocolScripts;
  await assert.rejects(
    runPlan(unscripted, {}, executeRequest),
    /未授权protocol/,
  );
  for (const protocolCredentials of [
    { wire: { headers: { Host: "private" } } },
    { missing: {} },
  ]) {
    const response = await f.post(`projects/${p.id}/run`, {
      planId: made.value.id,
      protocolCredentials,
    });
    assert.notEqual(response.status, 200);
  }
  assert.equal(f.consumed.length, 0);
  assert.equal(f.connections, 0);
  const response = await f.post(`projects/${p.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(response.value.status, "passed");
  assert.equal(response.value.conditionResults[0].matched, false);
  assert.deepEqual(
    response.value.results.map((r) => r.stepId),
    ["setup", "consume"],
  );
  assert.equal(f.connections, 0);
  assert.equal(response.value.variables.token, "initial");
});

test(
  "IF WebSocket cancellation retains executed evidence and never dispatches following HTTP",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    let entered;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    f.beforeWebSocket(
      (socket) =>
        new Promise((resolve) => {
          socket.once("close", resolve);
          entered();
        }),
    );
    const made = await f.post(`projects/${p.id}/plans`, f.definition());
    const running = f.post(`projects/${p.id}/run`, {
      planId: made.value.id,
      runId: "if-websocket-cancel",
    });
    await pending;
    assert.equal(
      (await f.post("cancel", { id: "if-websocket-cancel" })).status,
      200,
    );
    const { value: run } = await running;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      ["setup", "wire"],
    );
    assert.equal(run.conditionResults[0].matched, true);
    assert.equal(f.connections, 1);
    assert.equal(f.consumed.length, 1);
    await until(() => f.sockets.size === 0);
    assert.equal(
      (await new Store(f.root).get(p.id)).runs.find((r) => r.id === run.id)
        .results.length,
      2,
    );
  },
);
test(
  "completed IF WebSocket evidence is never replayed after generic append failure or genuine post-journal uncertainty",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["generic", "unknown"])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          p = f.project;
        const made = await f.post(`projects/${p.id}/plans`, f.definition());
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
        });
        assert.equal(response.status, 200);
        const run = response.value;
        assert.equal(run.status, "passed");
        assert.equal(run.results.length, 3);
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
        const receipt = JSON.stringify({
          message: run.persistenceError,
          outcome: run.persistenceOutcome,
        });
        assert.ok(!receipt.includes(f.root));
        assert.ok(!receipt.includes("private-obstacle-marker"));
        assert.equal(f.received.length, 1);
        assert.equal(f.consumed[1].token, f.received[0].token);
        assert.equal(run.conditionResults[0].matched, true);
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
          mode !== "generic",
        );
        assert.equal(f.received.length, 1);
        assert.equal(f.consumed.length, 2);
        await until(() => f.sockets.size === 0);
      });
  },
);

test("IF WebSocket does not bypass a later active transport's required credentials before HTTP", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps[1].condition.right.literal = false;
  input.steps.push({
    id: "protected",
    type: "protocol",
    protocol: {
      definition: {
        type: "websocket",
        url: "ws://127.0.0.1:1",
        handshake: { requiredHeaders: ["authorization"] },
      },
      message: "never",
    },
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const response = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.notEqual(response.status, 200);
  assert.match(response.value.error, /缺少协议运行时Header/);
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
});

test("IF WebSocket environment extraction commits once, unknown scope acknowledgement halts without replay", async (t) => {
  for (const unknown of [false, true])
    await t.test(String(unknown), async (t) => {
      const f = await fixture(t),
        input = f.definition();
      input.steps[1].steps[0].extract[0].scope = "environment";
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      let commits = 0;
      const run = await runPlan(
        made.value,
        { token: "initial" },
        executeRequest,
        {
          executeProtocol: executeWireFlow,
          onScopeChanges: async () => {
            commits++;
            if (unknown)
              throw new ProjectCommitUncertain(
                "fixture",
                Error("uncertain fixture"),
              );
          },
        },
      );
      assert.equal(commits, 1);
      assert.equal(f.connections, 1);
      assert.equal(run.conditionResults[0].matched, true);
      assert.equal(
        run.results[1].protocolResult.result.messages[0].data,
        f.received[0].token,
      );
      if (unknown) {
        assert.equal(run.stopReason, "scope-commit-unknown");
        assert.deepEqual(run.results[1].scopeCommit, {
          outcome: "unknown",
          retrySafe: false,
        });
        assert.equal(run.variables.token, "initial");
        assert.equal(f.consumed.length, 1);
      } else {
        assert.equal(run.status, "passed");
        assert.equal(run.variables.token, f.received[0].token);
        assert.equal(f.consumed[1].token, f.received[0].token);
      }
    });
});

test("IF WebSocket retains shared evidence cap and native/staged admission boundaries", async (t) => {
  const f = await fixture(t);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  assert.throws(() => assertNativeLinearPlan(made.value), /canonical|条件/);
  assert.throws(
    () =>
      prepareStagedLoad(f.project, made.value, {
        initialVUs: 1,
        stages: [{ durationSeconds: 1, targetVUs: 1 }],
        maxIterations: 1,
      }),
    /HTTP/,
  );
  let calls = 0;
  const run = await runPlan(made.value, { token: "initial" }, executeRequest, {
    executeProtocol: async () => {
      calls++;
      return {
        status: "completed",
        durationMs: 0,
        result: { body: "x".repeat(REPEAT_EVIDENCE_BYTES + 1) },
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(run.stopReason, "evidence-limit");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "wire"],
  );
  assert.equal(run.conditionResults[0].matched, true);
  assert.equal(f.consumed.length, 1);
  assert.equal(f.connections, 0); // Deliberately injected oversized evidence, not wire acceptance.
});

test("until-only and disabled IF do not change legacy top-level WebSocket executor admission", async (t) => {
  const f = await fixture(t);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  for (const disabledIF of [false, true]) {
    const plan = structuredClone(made.value);
    const [setup, gate, consume] = plan.steps;
    const wire = gate.steps[0];
    plan.steps = [
      {
        id: "until",
        type: "repeat",
        count: 1,
        untilCondition: {
          left: { literal: true },
          op: "eq",
          right: { literal: true },
        },
        steps: [setup],
      },
      wire,
      consume,
    ];
    if (disabledIF)
      plan.steps.unshift({
        ...gate,
        enabled: false,
        steps: [{ id: "disabled-http", request: { url: setup.request.url } }],
      });
    const before = f.consumed.length;
    const run = await runPlan(plan, { token: "initial" }, executeRequest);
    assert.equal(run.status, "failed");
    assert.equal(run.results[0].stepId, "setup");
    assert.match(run.results[1].error, /未授权protocol/);
    assert.equal(f.consumed.length, before + 2);
  }
  assert.equal(f.connections, 0);
});

test("legacy HTTP IF with WebSocket sibling keeps admission while nested IF WebSocket preflights", async (t) => {
  const f = await fixture(t);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  const legacy = structuredClone(made.value);
  const [setup, gate, consume] = legacy.steps;
  const wire = gate.steps[0];
  gate.steps = [{ id: "http-child", request: { url: setup.request.url } }];
  legacy.steps = [setup, gate, wire, consume];
  const run = await runPlan(legacy, { token: "initial" }, executeRequest);
  assert.equal(run.status, "failed");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "http-child", "wire", "consume"],
  );
  assert.match(run.results[2].error, /未授权protocol/);
  assert.equal(f.consumed.length, 3);
  const nested = structuredClone(made.value);
  nested.steps[1].steps = [
    { id: "fixed", type: "repeat", count: 2, steps: nested.steps[1].steps },
  ];
  await assert.rejects(
    runPlan(nested, { token: "initial" }, executeRequest),
    /未授权protocol/,
  );
  assert.equal(f.consumed.length, 3);
  assert.equal(f.connections, 0);
});

test("false IF WebSocket preflights its own required handshake before earlier HTTP", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps[1].condition.right.literal = false;
  const saved = await f.app.store.get(f.project.id);
  saved.protocols[0].handshake = { requiredHeaders: ["authorization"] };
  await f.app.store.save(saved);
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const denied = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.notEqual(denied.status, 200);
  assert.match(denied.value.error, /缺少协议运行时Header/);
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
  const allowed = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    protocolCredentials: {
      wire: { headers: { Authorization: "Bearer fixture-only" } },
    },
  });
  assert.equal(allowed.value.status, "passed");
  assert.equal(allowed.value.conditionResults[0].matched, false);
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 2);
  assert.ok(!JSON.stringify(allowed.value).includes("Bearer fixture-only"));
});

test("nested IF and fixed repeat WebSocket share extracted values and preserve occurrence evidence", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  const gate = input.steps[1];
  gate.steps = [
    {
      id: "fixed",
      type: "repeat",
      count: 2,
      steps: [{ ...structuredClone(gate), id: "inner" }],
    },
  ];
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(run.status, "passed");
  assert.equal(run.conditionResults.length, 3);
  assert.ok(run.conditionResults.every((r) => r.matched));
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "wire", "wire", "consume"],
  );
  assert.deepEqual(
    f.received.map((r) => r.message),
    ["initial", "websocket-token-1"],
  );
  assert.equal(f.consumed[1].token, "websocket-token-2");
  assert.notEqual(
    run.results[1].repeat.occurrenceId,
    run.results[2].repeat.occurrenceId,
  );
  assert.deepEqual(
    run.results.slice(1, 3).map((r) => r.repeat.iteration),
    [0, 1],
  );
  assert.equal(run.recordSaved, true);
});

test("IF WebSocket composes with existing TCP and HTTP leaves in one branch", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    messages = [];
  const tcp = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (bytes) => {
      messages.push(bytes.toString());
      socket.end("tcp-followup");
    });
  });
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => tcp.close(r)));
  input.steps[1].steps.push({
    id: "tcp",
    type: "protocol",
    protocol: {
      definition: {
        type: "tcp",
        url: "127.0.0.1",
        port: tcp.address().port,
        completion: "end",
        duration: 5000,
      },
      message: "{{token}}",
    },
    extract: [{ name: "token", path: "$.body" }],
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "wire", "tcp", "consume"],
  );
  assert.deepEqual(messages, ["websocket-token-1"]);
  assert.equal(f.consumed[1].token, "tcp-followup");
});

test("false and disabled IF WebSocket reject malformed static payload, definition and scripts", async (t) => {
  const f = await fixture(t);
  for (const disabled of [false, true]) {
    for (const mutate of [
      (wire) => {
        wire.protocol.message = { encoding: "unsupported", data: "bad" };
      },
      (wire) => {
        wire.protocol.definition = {
          type: "websocket",
          url: "http://127.0.0.1:1",
        };
        delete wire.protocol.definitionId;
      },
      (wire) => {
        wire.protocolScripts = { version: 2, before: "", after: "" };
      },
    ]) {
      const input = f.definition();
      if (disabled) input.steps[1].enabled = false;
      else input.steps[1].condition.right.literal = false;
      mutate(input.steps[1].steps[0]);
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.notEqual(made.status, 200, JSON.stringify(made.value));
    }
  }
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
});

test("true IF WebSocket uses per-run handshake credentials without persisting them", async (t) => {
  const f = await fixture(t),
    saved = await f.app.store.get(f.project.id);
  saved.protocols[0].handshake = { requiredHeaders: ["authorization"] };
  await f.app.store.save(saved);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const secret = "Bearer if-websocket-test-private";
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    protocolCredentials: { wire: { headers: { Authorization: secret } } },
  });
  checkRun(run);
  assert.equal(f.received[0].authorization, secret);
  assert.ok(!JSON.stringify(run).includes(secret));
  assert.ok(
    !JSON.stringify(await new Store(f.root).get(f.project.id)).includes(secret),
  );
  const denied = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.notEqual(denied.status, 200);
  assert.equal(f.connections, 1);
  assert.equal(f.consumed.length, 2);
});

test("legacy IF TCP does not change unrelated SSE and WebSocket siblings's unknown scope handling", async (t) => {
  for (const type of ["sse", "websocket"])
    await t.test(type, async (t) => {
      const f = await fixture(t),
        input = f.definition();
      input.steps[1].condition.right.literal = false;
      input.steps[1].steps[0] = {
        id: "tcp",
        type: "protocol",
        protocol: {
          definition: { type: "tcp", url: "127.0.0.1", port: 1 },
          message: "never",
        },
      };
      input.steps.splice(2, 0, {
        id: "sibling",
        type: "protocol",
        protocol: {
          definition: {
            type,
            url: type === "sse" ? "http://127.0.0.1:1" : "ws://127.0.0.1:1",
          },
          ...(type === "websocket" ? { message: "fixture" } : {}),
        },
        extract: [
          {
            name: "token",
            path: type === "sse" ? "$.events[0].data" : "$.messages[0].data",
            scope: "environment",
          },
        ],
      });
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      let dispatches = 0,
        commits = 0;
      const run = await runPlan(
        made.value,
        { token: "initial" },
        executeRequest,
        {
          executeProtocol: async (protocol) => {
            assert.equal(protocol.definition.type, type);
            dispatches++;
            return {
              status: "completed",
              durationMs: 0,
              result: {
                [type === "sse" ? "events" : "messages"]: [
                  { data: "fixture-token" },
                ],
              },
            };
          },
          onScopeChanges: async () => {
            commits++;
            throw new ProjectCommitUncertain(
              "fixture",
              Error("uncertain fixture"),
            );
          },
        },
      );
      assert.equal(dispatches, 1);
      assert.equal(commits, 1);
      assert.equal(run.status, "failed");
      assert.equal(run.stopReason, undefined);
      assert.deepEqual(
        run.results.map((r) => r.stepId),
        ["setup", "sibling", "consume"],
      );
      assert.deepEqual(run.results[1].scopeCommit, {
        outcome: "unknown",
        retrySafe: false,
      });
      assert.equal(run.variables.token, "initial");
      assert.equal(f.consumed.length, 2);
      assert.equal(f.consumed[1].token, "initial");
      assert.equal(f.connections, 0);
    });
});
