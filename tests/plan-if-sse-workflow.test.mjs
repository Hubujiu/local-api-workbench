import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
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
    if (Date.now() > deadline) throw Error("SSE repeat fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-sse-workflow-"));
  let app = await createApp({ root, port: 0 });
  const sockets = new Set(),
    received = [],
    consumed = [],
    clients = [];
  let connections = 0;
  let onSSE = async () => {},
    onHTTP = async () => {};
  const sse = http.createServer(async (request, response) => {
    connections++;
    const socket = response;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const token = `sse-token-${received.length + 1}`;
    received.push({ token, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    await onSSE(response, received.length);
    if (!response.destroyed && !response.writableEnded)
      response.end(`id: ${received.length}\ndata: ${token}\n\n`);
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
    }),
  ];
  await app.store.save(project);
  const definition = () => ({
    name: "HTTP to IF to SSE extraction to HTTP",
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
            protocol: { definitionId: "saved-sse" },
            extract: [{ name: "token", path: "$.events[0].data" }],
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
                ? "SSE repeat CLI timeout"
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
  assert.equal(run.snapshot.steps[1].steps[0].protocol.definition.type, "sse");
  assert.equal(run.snapshot.steps[1].steps[0].protocol.definitionId, undefined);
  assert.equal(
    run.variables.token,
    run.results[1].protocolResult.result.events[0].data,
  );
}
test(
  "IF SSE owner, SDK HTTP/stdio and CLI use frozen snapshots across backup, restore and restart",
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
    live.protocols[0].url = "http://127.0.0.1:1";
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

test("false IF SSE skips connection and scripts but still checks executor and credentials before earlier HTTP", async (t) => {
  const f = await fixture(t),
    p = f.project,
    input = f.definition();
  input.steps[1].condition.right.literal = false;
  input.steps[1].steps[0].protocolScripts = {
    version: 1,
    before: 'throw new Error("false SSE script executed")',
    after: 'throw new Error("false SSE post script executed")',
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
  "IF SSE cancellation retains executed evidence and never dispatches following HTTP",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    let entered;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    f.beforeSSE(
      (socket) =>
        new Promise((resolve) => {
          socket.once("close", resolve);
          socket.write("data: observed-before-cancel\n\n");
          entered();
        }),
    );
    const made = await f.post(`projects/${p.id}/plans`, f.definition());
    const running = f.post(`projects/${p.id}/run`, {
      planId: made.value.id,
      runId: "if-sse-cancel",
    });
    await pending;
    assert.equal((await f.post("cancel", { id: "if-sse-cancel" })).status, 200);
    const { value: run } = await running;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      ["setup", "wire"],
    );
    assert.equal(run.conditionResults[0].matched, true);
    assert.equal(run.results[1].protocolResult.status, "cancelled");
    assert.equal(run.results[1].protocolResult.result.events, undefined);
    assert.equal(run.variables.token, "initial");
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
test("IF SSE environment extraction commits once, unknown scope acknowledgement halts without replay", async (t) => {
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
        run.results[1].protocolResult.result.events[0].data,
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

test("IF SSE retains shared evidence cap and native/staged admission boundaries", async (t) => {
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

test("false IF SSE preflights its own required handshake before earlier HTTP", async (t) => {
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

test("IF SSE EOF, maxEvents and duration preserve existing completion and partial contracts without reconnect", async (t) => {
  for (const mode of ["eof", "limit", "timeout"])
    for (const acceptPartial of [false, true])
      await t.test(`${mode}/${acceptPartial}`, async (t) => {
        const f = await fixture(t),
          input = f.definition();
        const leaf = input.steps[1].steps[0];
        if (mode !== "eof" && acceptPartial) leaf.expectedStatus = "partial";
        leaf.protocol.duration = 150;
        leaf.protocol.maxEvents = mode === "limit" ? 1 : 20;
        f.beforeSSE((res) => {
          res.write("id: 17\ndata: first\n\ndata: second\n\n");
          if (mode === "eof") res.end("data: incomplete");
          else return new Promise((resolve) => res.once("close", resolve));
        });
        const made = await f.post(`projects/${f.project.id}/plans`, input);
        assert.equal(made.status, 200, JSON.stringify(made.value));
        const { value: run } = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
        });
        const record = run.results[1],
          result = record.protocolResult.result;
        assert.equal(
          record.protocolResult.status,
          mode === "eof" ? "completed" : "partial",
        );
        assert.equal(result.events.length, mode === "limit" ? 1 : 2);
        assert.equal(result.events[0].data, "first");
        assert.equal(result.events[0].id, "17");
        if (mode === "limit") assert.equal(result.limited, true);
        if (mode === "timeout") assert.equal(result.timedOut, true);
        const passed = mode === "eof" || acceptPartial;
        assert.equal(run.status, passed ? "passed" : "failed");
        assert.equal(run.variables.token, passed ? "first" : "initial");
        assert.equal(f.consumed[1].token, passed ? "first" : "initial");
        assert.equal(f.connections, 1);
        await until(() => f.sockets.size === 0);
      });
});

test("IF SSE nested in fixed repeat preserves occurrence IDs and fresh bounded captures", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps[1] = {
    id: "repeat",
    type: "repeat",
    count: 2,
    steps: [input.steps[1]],
  };
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(run.status, "passed");
  assert.equal(run.conditionResults.length, 2);
  assert.equal(f.connections, 2);
  assert.deepEqual(
    run.results.slice(1, 3).map((r) => r.repeat.occurrenceId),
    [
      JSON.stringify(["repeat", "wire", 0]),
      JSON.stringify(["repeat", "wire", 1]),
    ],
  );
  assert.equal(run.variables.token, "sse-token-2");
});
test(
  "completed IF SSE evidence is never replayed after generic append failure or genuine post-journal uncertainty",
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

test("true IF SSE uses per-run handshake credentials without persisting them", async (t) => {
  const f = await fixture(t),
    saved = await f.app.store.get(f.project.id);
  saved.protocols[0].handshake = { requiredHeaders: ["authorization"] };
  await f.app.store.save(saved);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const secret = "Bearer if-sse-test-private";
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

test("IF SSE composes with existing TCP, WebSocket and HTTP leaves in one branch", async (t) => {
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

  const wsMessages = [];
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => ws.on("listening", r));
  ws.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.once("message", (bytes) => {
      wsMessages.push(bytes.toString());
      socket.send("ws-followup");
      socket.close();
    });
  });
  t.after(() => {
    for (const socket of ws.clients) socket.terminate();
    return new Promise((r) => ws.close(r));
  });
  input.steps[1].steps.push({
    id: "ws",
    type: "protocol",
    protocol: {
      definition: {
        type: "websocket",
        url: `ws://127.0.0.1:${ws.address().port}`,
        duration: 5000,
      },
      message: "{{token}}",
    },
    extract: [{ name: "token", path: "$.messages[0].data" }],
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "wire", "tcp", "ws", "consume"],
  );
  assert.deepEqual(messages, ["sse-token-1"]);
  assert.deepEqual(wsMessages, ["tcp-followup"]);
  assert.equal(f.consumed[1].token, "ws-followup");
});
