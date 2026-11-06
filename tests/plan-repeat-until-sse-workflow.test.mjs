import test from "node:test";
import assert from "node:assert/strict";
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
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
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
        id: "group",
        type: "repeat",
        count: 3,
        untilCondition: {
          left: { scope: "runtime", name: "done" },
          op: "eq",
          right: { literal: "done" },
        },
        steps: [
          {
            id: "wire",
            type: "protocol",
            protocol: { definitionId: "saved-sse" },
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
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["setup", "wire", "consume", "wire", "consume"],
  );
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [false, true],
  );
  assert.equal(run.snapshot.steps[1].steps[0].protocol.definition.type, "sse");
  assert.equal(run.snapshot.steps[1].steps[0].protocol.definitionId, undefined);
  assert.equal(
    run.variables.token,
    run.results[3].protocolResult.result.events[0].data,
  );
  assert.deepEqual(
    run.results.slice(1).map((r) => r.repeat.occurrenceId),
    [0, 1].flatMap((i) =>
      ["wire", "consume"].map((id) => JSON.stringify(["group", id, i])),
    ),
  );
}
test(
  "repeat-until SSE owner, SDK HTTP/stdio and CLI use frozen snapshots across backup, restore and restart",
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
    assert.equal(f.connections, 2);
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
    assert.equal(f.connections, 10);
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

const always = { left: { literal: true }, op: "eq", right: { literal: true } };
test("repeat-until SSE EOF, duration, event cap and stop/continue preserve extraction contracts", async (t) => {
  for (const mode of ["eof", "timeout", "limit"])
    for (const acceptPartial of [false, true])
      for (const failurePolicy of ["stop", "continue"])
        await t.test(`${mode}/${acceptPartial}/${failurePolicy}`, async (t) => {
          const f = await fixture(t),
            input = f.definition(),
            group = input.steps[1],
            leaf = group.steps[0];
          input.failurePolicy = failurePolicy;
          group.untilCondition = structuredClone(always);
          leaf.extract = [{ name: "token", path: "$.events[0].data" }];
          leaf.protocol.duration = 100;
          leaf.protocol.maxEvents = mode === "limit" ? 1 : 20;
          if (acceptPartial && mode !== "eof") leaf.expectedStatus = "partial";
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
          assert.equal(result.events[0].id, "17");
          if (mode === "limit") assert.equal(result.limited, true);
          if (mode === "timeout") assert.equal(result.timedOut, true);
          const passed = mode === "eof" || acceptPartial;
          assert.equal(run.status, passed ? "passed" : "failed");
          assert.equal(run.variables.token, passed ? "first" : "initial");
          const proceeds = passed || failurePolicy === "continue";
          assert.equal(f.consumed.length, proceeds ? 2 : 1);
          assert.equal(run.conditionResults.length, proceeds ? 1 : 0);
          if (proceeds)
            assert.equal(f.consumed[1].token, passed ? "first" : "initial");
          assert.equal(f.connections, 1);
          await until(() => f.sockets.size === 0);
        });
});

test("repeat-until SSE invalid extraction batches publish no stale or partial values", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.failurePolicy = "stop";
  input.steps[1].steps[0].extract = [
    { name: "token", path: "$.events[0].data", scope: "environment" },
    { name: "absent", path: "$.events[99].data", scope: "global" },
  ];
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "step-failure");
  assert.equal(run.variables.token, "initial");
  assert.deepEqual(run.results[1].extracted, {});
  assert.deepEqual(run.conditionResults, []);
  assert.equal(f.connections, 1);
  assert.equal(f.consumed.length, 1);
  const saved = await new Store(f.root).get(f.project.id);
  assert.equal(saved.environments[0].variables.token, "initial");
  assert.equal(saved.globalVariables?.absent, undefined);
});

test("repeat-until SSE credentials and executor preflight precede all HTTP; credentials never persist", async (t) => {
  const f = await fixture(t),
    saved = await f.app.store.get(f.project.id);
  saved.protocols[0].handshake = { requiredHeaders: ["authorization"] };
  await f.app.store.save(saved);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  await assert.rejects(
    runPlan(made.value, {}, executeRequest, {
      protocolCredentials: {
        wire: { headers: { Authorization: "Bearer executor-preflight" } },
      },
    }),
    /未授权protocol/,
  );
  for (const protocolCredentials of [
    undefined,
    { missing: {} },
    { wire: { headers: { Host: "private" } } },
  ]) {
    const denied = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      protocolCredentials,
    });
    assert.notEqual(denied.status, 200);
  }
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
  const secret = "Bearer until-sse-fixture-private";
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    protocolCredentials: { wire: { headers: { Authorization: secret } } },
  });
  checkRun(run);
  assert.deepEqual(
    f.received.map((r) => r.authorization),
    [secret, secret],
  );
  assert.ok(!JSON.stringify(run).includes(secret));
  assert.ok(
    !JSON.stringify(await new Store(f.root).get(f.project.id)).includes(secret),
  );
});

test(
  "repeat-until SSE cancellation closes the live stream and suppresses tail and following HTTP",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    let entered;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    f.beforeSSE(
      (res) =>
        new Promise((resolve) => {
          res.once("close", resolve);
          res.write("data: observed-before-cancel\n\n");
          entered();
        }),
    );
    const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
    assert.equal(made.status, 200, JSON.stringify(made.value));
    const running = f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      runId: "until-sse-cancel",
    });
    await pending;
    assert.equal(
      (await f.post("cancel", { id: "until-sse-cancel" })).status,
      200,
    );
    const { value: run } = await running;
    assert.equal(run.status, "cancelled");
    assert.equal(run.recordSaved, true);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      ["setup", "wire"],
    );
    assert.equal(run.results[1].protocolResult.status, "cancelled");
    assert.equal(run.variables.token, "initial");
    assert.deepEqual(run.conditionResults, []);
    assert.equal(f.connections, 1);
    assert.equal(f.consumed.length, 1);
    await until(() => f.sockets.size === 0);
  },
);

test("repeat-until SSE uncertain scope commit fails closed without publishing extraction or evaluating tail", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.failurePolicy = "continue";
  input.steps[1].steps[0].extract[0].scope = "environment";
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  let commits = 0;
  const run = await runPlan(made.value, { token: "initial" }, executeRequest, {
    executeProtocol: executeWireFlow,
    onScopeChanges: async () => {
      commits++;
      throw new ProjectCommitUncertain("fixture", Error("uncertain fixture"));
    },
  });
  assert.equal(commits, 1);
  assert.equal(run.stopReason, "scope-commit-unknown");
  assert.deepEqual(run.results[1].scopeCommit, {
    outcome: "unknown",
    retrySafe: false,
  });
  assert.equal(run.variables.token, "initial");
  assert.equal(run.variables.done, undefined);
  assert.deepEqual(run.conditionResults, []);
  assert.equal(f.connections, 1);
  assert.equal(f.consumed.length, 1);
});

test(
  "completed repeat-until SSE evidence is never replayed after generic append failure or genuine post-journal uncertainty",
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
        assert.equal(run.results.length, 5);
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
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed[1].token, f.received[0].token);
        assert.equal(run.conditionResults[1].matched, true);
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
        assert.equal(f.consumed.length, 3);
        await until(() => f.sockets.size === 0);
      });
  },
);

test("nested IF inside SSE until evaluates fresh evidence and preserves native/staged boundaries", async (t) => {
  const f = await fixture(t),
    input = f.definition(),
    group = input.steps[1];
  group.steps[0] = {
    id: "gate",
    type: "if",
    condition: structuredClone(always),
    steps: [group.steps[0]],
  };
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200, JSON.stringify(made.value));
  assert.throws(
    () => assertNativeLinearPlan(made.value),
    /canonical|循环|条件/,
  );
  assert.throws(
    () =>
      prepareStagedLoad(f.project, made.value, {
        initialVUs: 1,
        stages: [{ durationSeconds: 1, targetVUs: 1 }],
        maxIterations: 1,
      }),
    /HTTP/,
  );
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [true, false, true, true],
  );
  assert.equal(f.connections, 2);
  assert.deepEqual(
    f.consumed.slice(1).map((r) => r.token),
    f.received.map((r) => r.token),
  );
  assert.equal(
    new Set(run.results.slice(1).map((r) => r.repeat.occurrenceId)).size,
    4,
  );
  await until(() => f.sockets.size === 0);
});

test("repeat-until SSE failed second capture cannot overwrite last successful extraction or satisfy the tail", async (t) => {
  for (const failurePolicy of ["stop", "continue"])
    await t.test(failurePolicy, async (t) => {
      const f = await fixture(t),
        input = f.definition(),
        group = input.steps[1];
      input.failurePolicy = failurePolicy;
      group.count = 2;
      group.steps[0].protocol.duration = 100;
      f.beforeSSE((res, iteration) => {
        if (iteration !== 2) return;
        res.write("data: stale-unsafe-token\n\ndata: done\n\n");
        return new Promise((resolve) => res.once("close", resolve));
      });
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const { value: run } = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
      });
      assert.equal(run.status, "failed");
      assert.equal(run.results[3].protocolResult.status, "partial");
      assert.equal(run.variables.token, "sse-token-1");
      assert.equal(run.variables.done, "pending");
      assert.deepEqual(
        run.conditionResults.map((r) => r.matched),
        failurePolicy === "stop" ? [false] : [false, false],
      );
      assert.equal(f.connections, 2);
      assert.deepEqual(
        f.consumed.slice(1).map((r) => r.token),
        failurePolicy === "stop"
          ? ["sse-token-1"]
          : ["sse-token-1", "sse-token-1"],
      );
      await until(() => f.sockets.size === 0);
    });
});

test("repeat-until SSE POST deliberately repeats body effects without reusing Last-Event-ID", async (t) => {
  const f = await fixture(t),
    saved = await f.app.store.get(f.project.id);
  saved.protocols[0].method = "POST";
  saved.protocols[0].body = "explicit-repeat-effect";
  await f.app.store.save(saved);
  const made = await f.post(`projects/${f.project.id}/plans`, f.definition());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const { value: run } = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
  });
  checkRun(run);
  assert.deepEqual(
    f.received.map(({ method, body, lastEventId }) => ({
      method,
      body,
      lastEventId,
    })),
    Array.from({ length: 2 }, () => ({
      method: "POST",
      body: "explicit-repeat-effect",
      lastEventId: undefined,
    })),
  );
  assert.deepEqual(
    run.results
      .filter((r) => r.stepId === "wire")
      .map((r) => r.protocolResult.result.events[0].id),
    ["1", "2"],
  );
  assert.equal(f.connections, 2);
  await until(() => f.sockets.size === 0);
});

test("repeat-until SSE bad handshake and disconnect fail capture without publishing values", async (t) => {
  for (const mode of ["unauthorized", "wrong-content-type", "disconnect"])
    for (const failurePolicy of ["stop", "continue"])
      await t.test(`${mode}/${failurePolicy}`, async (t) => {
        const f = await fixture(t),
          input = f.definition();
        input.failurePolicy = failurePolicy;
        input.steps[1].untilCondition = structuredClone(always);
        if (mode === "disconnect") {
          f.beforeSSE(async (res) => {
            res.write("data: unsafe-token\n\ndata: done\n\n");
            await new Promise((resolve) => setImmediate(resolve));
            res.destroy();
          });
        } else f.responseMode(mode);
        const made = await f.post(`projects/${f.project.id}/plans`, input);
        assert.equal(made.status, 200, JSON.stringify(made.value));
        const { value: run } = await f.post(`projects/${f.project.id}/run`, {
          planId: made.value.id,
        });
        assert.equal(run.status, "failed");
        assert.equal(run.results[1].protocolResult.status, "failed");
        assert.equal(run.variables.token, "initial");
        assert.equal(run.variables.done, undefined);
        assert.deepEqual(run.results[1].extracted, {});
        assert.equal(
          run.conditionResults.length,
          failurePolicy === "stop" ? 0 : 1,
        );
        assert.equal(f.consumed.length, failurePolicy === "stop" ? 1 : 2);
        if (failurePolicy === "continue")
          assert.equal(f.consumed[1].token, "initial");
        assert.equal(f.connections, 1);
        await until(() => f.sockets.size === 0);
      });
});

test("repeat-until SSE empty and incomplete EOF complete without synthesizing an event", async (t) => {
  for (const body of ["", "data: incomplete"])
    await t.test(JSON.stringify(body), async (t) => {
      const f = await fixture(t),
        input = f.definition();
      input.steps[1].untilCondition = structuredClone(always);
      delete input.steps[1].steps[0].extract;
      f.beforeSSE((res) => res.end(body));
      const made = await f.post(`projects/${f.project.id}/plans`, input);
      assert.equal(made.status, 200, JSON.stringify(made.value));
      const { value: run } = await f.post(`projects/${f.project.id}/run`, {
        planId: made.value.id,
      });
      assert.equal(run.status, "passed");
      assert.equal(run.results[1].protocolResult.status, "completed");
      assert.deepEqual(run.results[1].protocolResult.result.events, []);
      assert.equal(run.variables.token, "initial");
      assert.equal(run.conditionResults[0].matched, true);
      assert.equal(f.connections, 1);
      await until(() => f.sockets.size === 0);
    });
});

test("disabled repeat-until SSE leaves still reject malformed static capture options", async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { duration: 99 },
    { maxEvents: 0 },
    { maxEvents: 101 },
    { message: "unsupported" },
    { maxMessages: 1 },
  ]) {
    const input = f.definition(),
      leaf = input.steps[1].steps[0];
    leaf.enabled = false;
    Object.assign(leaf.protocol, invalid);
    const made = await f.post(`projects/${f.project.id}/plans`, input);
    assert.equal(made.status, 400, JSON.stringify(made.value));
  }
  assert.equal(f.connections, 0);
  assert.equal(f.consumed.length, 0);
});
