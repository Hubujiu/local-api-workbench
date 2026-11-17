import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import http from "node:http";
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
      const token = `websocket-token-${(received.length % 2) + 1}`;
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
    name: "WebSocket then HTTP, twice",
    environmentId: project.environments[0].id,
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 4,
        untilCondition: {
          op: "eq",
          left: { scope: "runtime", name: "token" },
          right: { literal: "websocket-token-2" },
        },
        steps: [
          {
            id: "wire",
            type: "protocol",
            protocol: { definitionId: "saved-websocket", message: "{{token}}" },
            extract: [{ name: "token", path: "$.messages[0].data" }],
          },
          {
            id: "consume",
            request: {
              method: "GET",
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
function checkRun(run) {
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [false, true],
  );
  assert.ok(run.conditionResults.every((r) => r.kind === "repeat-until"));
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.snapshot.steps[0].count, 4);
  assert.equal(
    run.snapshot.steps[0].steps[0].protocol.definition.type,
    "websocket",
  );
  assert.equal(run.snapshot.steps[0].steps[0].protocol.definitionId, undefined);
  assert.deepEqual(
    run.results.map((r) => [
      r.stepId,
      r.repeat.groupId,
      r.repeat.childId,
      r.repeat.iteration,
    ]),
    [
      ["wire", "group", "wire", 0],
      ["consume", "group", "consume", 0],
      ["wire", "group", "wire", 1],
      ["consume", "group", "consume", 1],
    ],
  );
  assert.equal(new Set(run.results.map((r) => r.repeat.occurrenceId)).size, 4);
  for (const r of run.results)
    assert.deepEqual(JSON.parse(r.repeat.occurrenceId), [
      "group",
      r.stepId,
      r.repeat.iteration,
    ]);
  assert.equal(run.results[0].protocolResult.status, "completed");
  assert.equal(run.results[2].protocolResult.status, "completed");
  assert.notEqual(
    run.results[0].protocolResult.result.messages[0].data,
    run.results[2].protocolResult.result.messages[0].data,
  );
}
function checkExchange(f, offset) {
  const rows = f.received.slice(offset, offset + 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message, "initial");
  assert.equal(rows[1].message, rows[0].token);
  assert.deepEqual(
    f.consumed.slice(offset, offset + 2).map((r) => r.token),
    rows.map((r) => r.token),
  );
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
test(
  "WebSocket repeat-until owner, canonical SDK HTTP/stdio and CLI preserve frozen references and backup graph identities",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    const made = await f.post(`projects/${p.id}/plans`, f.definition());
    assert.equal(made.status, 200);
    const plan = made.value;
    const owner = await f.post(`projects/${p.id}/run`, { planId: plan.id });
    assert.equal(owner.status, 200);
    checkRun(owner.value);
    checkExchange(f, 0);
    const live = await f.app.store.get(p.id);
    live.protocols[0].url = "ws://127.0.0.1:1";
    live.protocols[0].message = "live edit must not execute";
    await f.app.store.save(live);
    const denied = await f.app.store.create("not granted");
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
    assert.ok(
      (await sdk.listTools()).tools.some((x) => x.name === "localapi_run_plan"),
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
    assert.equal(f.connections, 2);
    assert.equal(f.received.length, 2);
    assert.equal(f.consumed.length, 2);
    const sdkRun = decode(
      await sdk.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: p.id, planId: plan.id },
      }),
    );
    checkRun(sdkRun);
    checkExchange(f, 2);
    assert.equal(sdkRun.planHash, owner.value.planHash);
    const deleted = await f.app.store.get(p.id);
    deleted.protocols = []; // Deletion cannot invalidate an already frozen graph.
    await f.app.store.save(deleted);
    const exported = await fetch(`${f.app.url}/api/projects/${p.id}/export`, {
      headers: { "x-local-token": f.app.token },
    });
    assert.equal(exported.status, 200);
    const backup = await exported.json();
    const restoration = await f.post("restore", { document: backup });
    assert.equal(restoration.status, 201);
    const restored = restoration.value;
    assert.notEqual(restored.id, p.id); // Backup restores an isolated project copy.
    assert.equal(restored.plans[0].id, plan.id);
    assert.deepEqual(restored.plans[0].steps, plan.steps);
    assert.deepEqual(
      restored.runs.find((r) => r.id === owner.value.id).snapshot.steps,
      owner.value.snapshot.steps,
    );
    await sdk.close();
    await f.restart();
    const restarted = await f.post(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(restarted.status, 200);
    checkRun(restarted.value);
    checkExchange(f, 4);
    assert.equal(restarted.value.planHash, owner.value.planHash);
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
    assert.ok(
      (await stdio.listTools()).tools.some(
        (x) => x.name === "localapi_run_plan",
      ),
    );
    assert.equal(
      (
        await stdio.callTool({
          name: "localapi_run_plan",
          arguments: { projectId: denied.id, planId: plan.id },
        })
      ).isError,
      true,
    );
    assert.equal(f.connections, 6);
    assert.equal(f.received.length, 6);
    const stdioRun = decode(
      await stdio.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: restored.id, planId: plan.id },
      }),
    );
    checkRun(stdioRun);
    checkExchange(f, 6);
    await stdio.close();
    const cliRun = await cli(f.root, restored.id, plan.id);
    checkRun(cliRun);
    checkExchange(f, 8);
    for (const run of [stdioRun, cliRun])
      assert.equal(run.planHash, owner.value.planHash);
    const disk = await new Store(f.root).get(restored.id);
    assert.deepEqual(disk.plans[0].steps, plan.steps);
    assert.deepEqual(
      disk.runs.find((r) => r.id === cliRun.id).snapshot.steps,
      cliRun.snapshot.steps,
    );
    assert.equal(disk.protocols.length, 0);
    assert.deepEqual((await f.app.store.get(denied.id)).runs, []);
    assert.throws(() => exportApipostDirectory(disk), /HTTP步骤/);
    assert.equal(f.received.length, 10);
    assert.equal(f.consumed.length, 10);
    await until(() => f.sockets.size === 0);
  },
);

test(
  "second-iteration hanging WebSocket cancellation and explicit deadline prevent the next HTTP and release sockets",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["owner-cancel", "deadline"])
      await t.test(mode, async (t) => {
        const f = await fixture(t),
          p = f.project;
        let entered;
        const pending = new Promise((r) => {
          entered = r;
        });
        f.beforeWebSocket((socket, count) => {
          if (count !== 2) return;
          return new Promise((resolve) => {
            socket.once("close", resolve);
            entered();
          });
        });
        const made = await f.post(`projects/${p.id}/plans`, f.definition());
        assert.equal(made.status, 200);
        const controller = new AbortController();
        const executing =
          mode === "owner-cancel"
            ? f.post(`projects/${p.id}/run`, {
                planId: made.value.id,
                runId: "websocket-until-cancel",
              })
            : runPlan(made.value, { token: "initial" }, executeRequest, {
                executeProtocol: executeWireFlow,
                signal: controller.signal,
              });
        await pending;
        if (mode === "owner-cancel")
          assert.equal(
            (await f.post("cancel", { id: "websocket-until-cancel" })).status,
            200,
          );
        else {
          // Start the deadline only after the second socket is actually waiting.
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
        assert.deepEqual(
          run.results.map((r) => [r.stepId, r.repeat.iteration]),
          [
            ["wire", 0],
            ["consume", 0],
            ["wire", 1],
          ],
        );
        assert.equal(run.results[2].status, "failed");
        assert.equal(run.variables.token, f.received[0].token);
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 1);
        await until(() => f.sockets.size === 0);
        if (mode === "owner-cancel") {
          assert.equal(run.recordSaved, true);
          const saved = await new Store(f.root).get(p.id);
          assert.equal(
            saved.runs.find((r) => r.id === run.id).results.length,
            3,
          );
        }
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 1);
      });
  },
);

test(
  "completed WebSocket repeat evidence is never replayed after generic append failure or genuine post-journal uncertainty",
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
        const receipt = JSON.stringify({
          message: run.persistenceError,
          outcome: run.persistenceOutcome,
        });
        assert.ok(!receipt.includes(f.root));
        assert.ok(!receipt.includes("private-obstacle-marker"));
        checkExchange(f, 0);
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
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 2);
        await until(() => f.sockets.size === 0);
      });
  },
);

test("WebSocket until reuses leaf credentials on fresh connections without persisting or caching secrets", async (t) => {
  const f = await fixture(t),
    saved = await f.app.store.get(f.project.id);
  saved.protocols[0].handshake = { requiredHeaders: ["authorization"] };
  await f.app.store.save(saved);
  const made = await f.post(`projects/${saved.id}/plans`, f.definition());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  for (const protocolCredentials of [
    undefined,
    { missing: {} },
    { '["group","wire",0]': {} },
    { wire: { headers: { Host: "forbidden" } } },
  ]) {
    const denied = await f.post(`projects/${saved.id}/run`, {
      planId: made.value.id,
      protocolCredentials,
    });
    assert.notEqual(denied.status, 200);
  }
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
  for (const secret of [
    "Bearer until-private-first",
    "Bearer until-private-second",
  ]) {
    const offset = f.received.length;
    const response = await f.post(`projects/${saved.id}/run`, {
      planId: made.value.id,
      protocolCredentials: { wire: { headers: { Authorization: secret } } },
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    checkRun(response.value);
    checkExchange(f, offset);
    assert.deepEqual(
      f.received.slice(offset).map((r) => r.authorization),
      [secret, secret],
    );
    assert.equal(f.connections, offset + 2);
    assert.ok(!JSON.stringify(response.value).includes(secret));
    assert.ok(
      !JSON.stringify(await new Store(f.root).get(saved.id)).includes(secret),
    );
    const denied = await f.post(`projects/${saved.id}/run`, {
      planId: made.value.id,
    });
    assert.notEqual(denied.status, 200);
    assert.equal(f.connections, offset + 2);
  }
  await until(() => f.sockets.size === 0);
});

test("WebSocket until bounded capture stays partial and only explicit partial permits extraction", async (t) => {
  for (const expectedStatus of ["completed", "partial"])
    await t.test(expectedStatus, async (t) => {
      const f = await fixture(t),
        input = f.definition();
      const wire = input.steps[0].steps[0];
      wire.expectedStatus = expectedStatus;
      wire.protocol.maxMessages = 1;
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const response = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
      });
      assert.equal(response.status, 200, JSON.stringify(response.value));
      const run = response.value;
      assert.equal(
        run.status,
        expectedStatus === "partial" ? "passed" : "failed",
      );
      assert.equal(run.recordSaved, true);
      const wires = run.results.filter((r) => r.stepId === "wire");
      assert.ok(wires.length > 0);
      for (const result of wires) {
        assert.equal(result.protocolResult.status, "partial");
        assert.equal(result.protocolResult.result.limited, true);
      }
      if (expectedStatus === "partial") {
        assert.deepEqual(
          run.conditionResults.map((r) => r.matched),
          [false, true],
        );
        assert.equal(run.variables.token, "websocket-token-2");
        assert.equal(f.connections, 2);
        checkExchange(f, 0);
      } else {
        assert.equal(run.variables.token, "initial");
        assert.ok(run.conditionResults.every((r) => !r.matched));
        assert.ok(f.received.every((r) => r.message === "initial"));
        assert.ok(f.consumed.every((r) => r.token === "initial"));
      }
      const disk = await new Store(f.root).get(f.project.id);
      assert.deepEqual(
        disk.runs.find((r) => r.id === run.id).results,
        run.results,
      );
      await until(() => f.sockets.size === 0);
    });
});

test("nested fixed and until WebSocket repeats create independent occurrences and carry extracted state", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps = [{ id: "outer", type: "repeat", count: 2, steps: input.steps }];
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const response = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const run = response.value;
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [false, true, false, true],
  );
  assert.equal(
    new Set(run.conditionResults.map((r) => r.occurrenceId)).size,
    4,
  );
  assert.equal(new Set(run.results.map((r) => r.repeat.occurrenceId)).size, 8);
  assert.deepEqual(
    f.received.map((r) => r.message),
    ["initial", "websocket-token-1", "websocket-token-2", "websocket-token-1"],
  );
  assert.deepEqual(
    f.consumed.map((r) => r.token),
    f.received.map((r) => r.token),
  );
  assert.equal(f.connections, 4);
  assert.equal(run.variables.token, "websocket-token-2");
  assert.deepEqual(
    (await new Store(f.root).get(f.project.id)).runs.find(
      (r) => r.id === run.id,
    ).conditionResults,
    run.conditionResults,
  );
  await until(() => f.sockets.size === 0);
});

test("silent WebSocket until duration timeout remains partial under default completed and does not extract", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps[0].count = 1;
  input.steps[0].steps[0].protocol.duration = 100;
  f.beforeWebSocket(
    (socket) => new Promise((resolve) => socket.once("close", resolve)),
  );
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const response = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const run = response.value,
    wire = run.results[0];
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, true);
  assert.equal(wire.protocolResult.status, "partial");
  assert.equal(wire.protocolResult.result.timedOut, true);
  assert.deepEqual(wire.protocolResult.result.messages, []);
  assert.equal(run.variables.token, "initial");
  assert.ok(run.conditionResults.every((r) => !r.matched));
  assert.equal(f.connections, 1);
  assert.equal(f.received.length, 1);
  assert.ok(f.consumed.every((r) => r.token === "initial"));
  assert.deepEqual(
    (await new Store(f.root).get(f.project.id)).runs.find(
      (r) => r.id === run.id,
    ).results,
    run.results,
  );
  await until(() => f.sockets.size === 0);
});

test("inline rows expose iterationData to real WebSocket until scripts and commit extraction before tail evaluation", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    loop = input.steps[0],
    wire = loop.steps[0];
  loop.untilCondition = {
    op: "eq",
    left: { scope: "environment", name: "token" },
    right: { scope: "iterationData", name: "expected" },
  };
  wire.protocol.message = "{{payload}}";
  wire.extract[0].scope = "environment";
  wire.protocolScripts = {
    version: 1,
    before:
      "pm.test('row is visible',()=>pm.expect(pm.iterationData.get('label')).to.be.a('string'));apt.setVar('payload',pm.iterationData.get('label'));",
    after:
      "pm.test('row response',()=>pm.expect(wire.result.result.messages[0].data).to.equal(pm.iterationData.get('expected')));pm.environment.set('observedRow',pm.iterationData.get('label'));",
  };
  input.steps = [
    {
      id: "rows",
      type: "repeat",
      count: 2,
      rows: [
        { label: "first-row", expected: "websocket-token-1" },
        { label: "second-row", expected: "websocket-token-2" },
      ],
      steps: [loop],
    },
  ];
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const response = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const run = response.value;
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, true],
  );
  assert.deepEqual(
    f.received.map((r) => r.message),
    ["first-row", "second-row"],
  );
  assert.deepEqual(
    f.consumed.map((r) => r.token),
    ["websocket-token-1", "websocket-token-2"],
  );
  assert.equal(f.connections, 2);
  assert.equal(new Set(run.results.map((r) => r.repeat.occurrenceId)).size, 4);
  const saved = await new Store(f.root).get(f.project.id);
  assert.equal(saved.environments[0].variables.token, "websocket-token-2");
  assert.equal(saved.environments[0].variables.observedRow, "second-row");
  assert.deepEqual(
    saved.runs.find((r) => r.id === run.id).conditionResults,
    run.conditionResults,
  );
  await until(() => f.sockets.size === 0);
});
