import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { runPlan } from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secret = "Bearer repeat-fixture-private-A";
const credentials = (authorization = secret) => ({
  ws: { headers: { Authorization: authorization }, protocols: ["repeat-v1"] },
  sse: { headers: { Authorization: authorization } },
});
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("WS/SSE repeat fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-wire-workflow-"));
  let app = await createApp({ root, port: 0 });
  const wsRows = [],
    sseRows = [],
    consumed = [],
    clients = [],
    streams = new Set();
  let upgradeCount = 0,
    httpCount = 0,
    hanging,
    onConsume = async () => {};
  const peer = http.createServer(async (req, res) => {
    httpCount++;
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/events") {
      const n = sseRows.length + 1;
      sseRows.push({
        authorization: req.headers.authorization,
        body,
        token: `event-${n}`,
      });
      if (
        !req.headers.authorization?.startsWith("Bearer repeat-fixture-private-")
      ) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      streams.add(res);
      res.on("close", () => streams.delete(res));
      if (hanging?.type === "sse" && hanging.n === n) {
        res.flushHeaders();
        return;
      }
      // The second explicit connection must not inherit the first ID/retry state.
      res.end(
        `${n % 2 ? "id: first-id\nretry: 37\n" : ""}data: event-${n}\n\n`,
      );
      return;
    }
    consumed.push({
      ws: req.headers["x-ws"],
      sse: req.headers["x-sse"],
      url: req.url,
    });
    await onConsume();
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  const wss = new WebSocketServer({ noServer: true });
  peer.on("upgrade", (req, socket, head) => {
    upgradeCount++;
    if (
      !req.headers.authorization?.startsWith("Bearer repeat-fixture-private-")
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (socket, req) => {
    socket.on("error", () => {});
    socket.once("message", (bytes) => {
      const n = wsRows.length + 1;
      wsRows.push({
        message: bytes.toString(),
        token: `wire-${n}`,
        authorization: req.headers.authorization,
      });
      if (hanging?.type === "ws" && hanging.n === n) return;
      socket.send(`wire-${n}`);
      socket.close(1000, "done");
    });
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${peer.address().port}`;
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await closeApp();
    for (const s of wss.clients) s.terminate();
    for (const res of streams) res.destroy();
    await new Promise((r) => wss.close(r));
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
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
  const project = await app.store.create("WS/SSE repeat");
  project.environments[0].variables = {
    wire: "initial",
    event: "initial-event",
  };
  project.protocols = [
    normalizeProtocol({
      id: "saved-ws",
      type: "websocket",
      url: base.replace("http:", "ws:") + "/ws",
      handshake: { requiredHeaders: ["authorization"] },
    }),
    normalizeProtocol({
      id: "saved-sse",
      type: "sse",
      url: base + "/events",
      method: "POST",
      body: "{{wire}}",
      templateMode: "variables",
      handshake: { requiredHeaders: ["authorization"] },
    }),
  ];
  await app.store.save(project);
  const definition = () => ({
    name: "WS SSE HTTP twice",
    environmentId: project.environments[0].id,
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: [
          {
            id: "ws",
            type: "protocol",
            protocol: {
              definitionId: "saved-ws",
              message: "{{wire}}",
              duration: 5000,
            },
            extract: [{ name: "wire", path: "$.messages[0].data" }],
          },
          {
            id: "sse",
            type: "protocol",
            protocol: { definitionId: "saved-sse", duration: 5000 },
            extract: [{ name: "event", path: "$.events[0].data" }],
          },
          {
            id: "consume",
            request: {
              url: base + "/consume",
              headers: [
                { key: "X-WS", value: "{{wire}}" },
                { key: "X-SSE", value: "{{event}}" },
              ],
            },
          },
        ],
      },
    ],
  });
  return {
    root,
    project,
    post,
    definition,
    wsRows,
    sseRows,
    consumed,
    streams,
    wss,
    counts: () => [upgradeCount, httpCount],
    get app() {
      return app;
    },
    hang(type, n) {
      hanging = { type, n };
    },
    beforeConsume(fn) {
      onConsume = fn;
    },
    client() {
      const c = new Client({ name: "wire-repeat", version: "1" });
      clients.push(c);
      return c;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
  };
}
function checkRun(run, { saved = true, partial = false } = {}) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  if (saved) assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, 6);
  assert.equal(new Set(run.results.map((r) => r.repeat.occurrenceId)).size, 6);
  assert.deepEqual(
    run.results.map((r) => [r.stepId, r.repeat.iteration]),
    [
      ["ws", 0],
      ["sse", 0],
      ["consume", 0],
      ["ws", 1],
      ["sse", 1],
      ["consume", 1],
    ],
  );
  for (const r of run.results)
    assert.deepEqual(JSON.parse(r.repeat.occurrenceId), [
      "group",
      r.stepId,
      r.repeat.iteration,
    ]);
  for (const i of [0, 1, 3, 4])
    assert.equal(
      run.results[i].protocolResult.status,
      partial ? "partial" : "completed",
    );
  assert.equal(run.results[0].protocolResult.result.protocol, "repeat-v1");
  assert.equal(run.results[4].protocolResult.result.events[0].id, "");
  assert.equal(run.results[4].protocolResult.result.events[0].retry, undefined);
  assert.doesNotMatch(JSON.stringify(run), /Bearer repeat-fixture-private-/);
}
function checkExchange(f, offset) {
  const ws = f.wsRows.slice(offset, offset + 2),
    sse = f.sseRows.slice(offset, offset + 2);
  assert.equal(ws.length, 2);
  assert.equal(sse.length, 2);
  assert.deepEqual(
    ws.map((x) => x.message),
    ["initial", ws[0].token],
  );
  assert.deepEqual(
    sse.map((x) => x.body),
    ws.map((x) => x.token),
  );
  assert.deepEqual(
    f.consumed.slice(offset, offset + 2).map((x) => [x.ws, x.sse]),
    ws.map((x, i) => [x.token, sse[i].token]),
  );
}
function cli(root, projectId, planId) {
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
      stderr = "",
      failure;
    const timer = setTimeout(() => {
      failure = Error("WS/SSE repeat CLI timeout");
      child.kill("SIGKILL");
    }, 10000);
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    child.on("error", (e) => (failure = e));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        return reject(failure || Error(`CLI ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify({ protocolCredentials: credentials() }));
  });
}

test(
  "WS/SSE repeat owner, SDK HTTP/stdio and CLI preserve frozen definitions, transient credentials and backup/restart",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    const made = await f.post(`projects/${p.id}/plans`, f.definition());
    assert.equal(made.status, 200);
    const plan = made.value;
    const invoke = (projectId = p.id) =>
      f.post(`projects/${projectId}/run`, {
        planId: plan.id,
        protocolCredentials: credentials(),
      });
    const owner = await invoke();
    assert.equal(owner.status, 200);
    checkRun(owner.value);
    checkExchange(f, 0);
    const live = await f.app.store.get(p.id);
    for (const def of live.protocols) {
      def.url =
        def.type === "sse"
          ? "http://127.0.0.1:1/changed"
          : "ws://127.0.0.1:1/changed";
      def.handshake.requiredHeaders = ["x-live-only"];
    }
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
    const before = f.counts();
    assert.equal(
      (
        await sdk.callTool({
          name: "localapi_run_plan",
          arguments: {
            projectId: denied.id,
            planId: plan.id,
            protocolCredentials: credentials(),
          },
        })
      ).isError,
      true,
    );
    assert.deepEqual(f.counts(), before);
    const sdkRun = decode(
      await sdk.callTool({
        name: "localapi_run_plan",
        arguments: {
          projectId: p.id,
          planId: plan.id,
          protocolCredentials: credentials(),
        },
      }),
    );
    checkRun(sdkRun);
    checkExchange(f, 2);
    const deleted = await f.app.store.get(p.id);
    deleted.protocols = [];
    await f.app.store.save(deleted);
    const exported = await fetch(`${f.app.url}/api/projects/${p.id}/export`, {
      headers: { "x-local-token": f.app.token },
    });
    assert.equal(exported.status, 200);
    const backup = await exported.json();
    assert.doesNotMatch(
      JSON.stringify(backup),
      /Bearer repeat-fixture-private-/,
    );
    const restoration = await f.post("restore", { document: backup });
    assert.equal(restoration.status, 201);
    const restored = restoration.value;
    assert.notEqual(restored.id, p.id);
    assert.deepEqual(restored.plans[0].steps, plan.steps);
    await sdk.close();
    await f.restart();
    const beforeMissing = f.counts();
    assert.notEqual(
      (await f.post(`projects/${restored.id}/run`, { planId: plan.id })).status,
      200,
    );
    assert.deepEqual(f.counts(), beforeMissing);
    const restarted = await invoke(restored.id);
    checkRun(restarted.value);
    checkExchange(f, 4);
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
    const beforeDenied = f.counts();
    assert.equal(
      (
        await stdio.callTool({
          name: "localapi_run_plan",
          arguments: {
            projectId: denied.id,
            planId: plan.id,
            protocolCredentials: credentials(),
          },
        })
      ).isError,
      true,
    );
    assert.deepEqual(f.counts(), beforeDenied);
    const stdioRun = decode(
      await stdio.callTool({
        name: "localapi_run_plan",
        arguments: {
          projectId: restored.id,
          planId: plan.id,
          protocolCredentials: credentials(),
        },
      }),
    );
    checkRun(stdioRun);
    checkExchange(f, 6);
    await stdio.close();
    const cliRun = await cli(f.root, restored.id, plan.id);
    checkRun(cliRun);
    checkExchange(f, 8);
    for (const run of [sdkRun, restarted.value, stdioRun, cliRun])
      assert.equal(run.planHash, owner.value.planHash);
    const disk = await new Store(f.root).get(restored.id);
    assert.doesNotMatch(JSON.stringify(disk), /Bearer repeat-fixture-private-/);
    assert.deepEqual(disk.plans[0].steps, plan.steps);
    assert.equal(disk.protocols.length, 0);
    assert.deepEqual(
      disk.runs.find((r) => r.id === cliRun.id).results,
      cliRun.results,
    );
    await until(() => f.wss.clients.size === 0 && f.streams.size === 0);
  },
);

test("WS/SSE repeat required-auth and malformed temporary bindings preflight the whole plan before earlier HTTP", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps.unshift({
    id: "earlier",
    request: { url: f.definition().steps[0].steps[2].request.url },
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200);
  const invalid = [
    undefined,
    {},
    { ws: credentials().ws },
    { ...credentials(), sse: { headers: { Authorization: " " } } },
    { ...credentials(), '["group","ws",0]': {} },
    {
      ...credentials(),
      ws: { ...credentials().ws, url: "ws://other.invalid" },
    },
    { ...credentials(), sse: { ...credentials().sse, tls: {} } },
    { ...credentials(), ws: { ...credentials().ws, tls: { ca: "not-pem" } } },
  ];
  for (const protocolCredentials of invalid) {
    const response = await f.post(`projects/${f.project.id}/run`, {
      planId: made.value.id,
      protocolCredentials,
    });
    assert.notEqual(response.status, 200);
    assert.deepEqual(f.counts(), [0, 0]);
  }
  assert.deepEqual((await f.app.store.get(f.project.id)).runs, []);
  // Disabling the group removes required-auth preflight, not shape validation.
  input.steps[1].enabled = false;
  const disabled = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(disabled.status, 200);
  const run = await f.post(`projects/${f.project.id}/run`, {
    planId: disabled.value.id,
  });
  assert.equal(run.value.status, "passed");
  assert.deepEqual(f.counts(), [0, 1]);
});

test("WS/SSE repeat limited results are explicit partial and simultaneous credentials remain run-local", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  for (const [index, key] of [
    [0, "maxMessages"],
    [1, "maxEvents"],
  ]) {
    input.steps[0].steps[index].protocol[key] = 1;
    input.steps[0].steps[index].expectedStatus = "partial";
  }
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200);
  const limited = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    protocolCredentials: credentials(),
  });
  checkRun(limited.value, { partial: true });
  checkExchange(f, 0);
  for (const i of [0, 1, 3, 4])
    assert.equal(limited.value.results[i].protocolResult.result.limited, true);
  const parallel = await Promise.all(
    ["B", "C"].map((suffix) =>
      runPlan(
        made.value,
        { wire: `start-${suffix}`, event: "initial" },
        executeRequest,
        {
          executeProtocol: executeWireFlow,
          protocolCredentials: credentials(
            `Bearer repeat-fixture-private-${suffix}`,
          ),
        },
      ),
    ),
  );
  for (const [i, run] of parallel.entries()) {
    assert.equal(run.status, "passed", JSON.stringify(run.results));
    assert.doesNotMatch(JSON.stringify(run), /Bearer repeat-fixture-private-/);
    const suffix = ["B", "C"][i],
      rows = f.wsRows.filter((x) => x.authorization.endsWith(suffix)),
      events = f.sseRows.filter((x) => x.authorization.endsWith(suffix));
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.message),
      [`start-${suffix}`, rows[0].token],
    );
    assert.deepEqual(
      events.map((r) => r.body),
      rows.map((r) => r.token),
    );
    assert.equal(run.variables.wire, rows[1].token);
    assert.equal(run.variables.event, events[1].token);
  }
  await until(() => f.wss.clients.size === 0 && f.streams.size === 0);
});

test(
  "second-iteration WS/SSE cancellation and deadline stop subsequent leaves and close resources",
  { timeout: 20000 },
  async (t) => {
    for (const type of ["ws", "sse"])
      for (const mode of ["owner", "deadline"])
        await t.test(`${type}-${mode}`, async (t) => {
          const f = await fixture(t);
          f.hang(type, 2);
          const made = await f.post(
            `projects/${f.project.id}/plans`,
            f.definition(),
          );
          assert.equal(made.status, 200);
          const controller = new AbortController();
          const executing =
            mode === "owner"
              ? f.post(`projects/${f.project.id}/run`, {
                  planId: made.value.id,
                  runId: "wire-repeat-cancel",
                  protocolCredentials: credentials(),
                })
              : runPlan(
                  made.value,
                  { wire: "initial", event: "initial-event" },
                  executeRequest,
                  {
                    executeProtocol: executeWireFlow,
                    protocolCredentials: credentials(),
                    signal: controller.signal,
                  },
                );
          await until(
            () => (type === "ws" ? f.wsRows : f.sseRows).length === 2,
          );
          if (mode === "owner")
            assert.equal(
              (await f.post("cancel", { id: "wire-repeat-cancel" })).status,
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
            run = mode === "owner" ? response.value : response;
          assert.equal(run.status, "cancelled");
          assert.equal(run.results.length, type === "ws" ? 4 : 5);
          assert.equal(f.wsRows.length, 2);
          assert.equal(f.sseRows.length, type === "ws" ? 1 : 2);
          assert.equal(f.consumed.length, 1);
          assert.equal(run.variables.event, "event-1");
          assert.equal(run.results.at(-1).status, "failed");
          if (mode === "owner") assert.equal(run.recordSaved, true);
          await until(() => f.wss.clients.size === 0 && f.streams.size === 0);
        });
  },
);

test("WS/SSE repeat extraction batches are atomic without changing ordinary continuation policy", async (t) => {
  const f = await fixture(t),
    input = f.definition();
  input.steps[0].steps[1].extract.push({
    name: "missing",
    path: "$.absent.value",
  });
  const made = await f.post(`projects/${f.project.id}/plans`, input);
  assert.equal(made.status, 200);
  const response = await f.post(`projects/${f.project.id}/run`, {
    planId: made.value.id,
    protocolCredentials: credentials(),
  });
  assert.equal(response.value.status, "failed");
  assert.equal(response.value.results.length, 6);
  assert.equal(response.value.variables.event, "initial-event");
  assert.equal(response.value.variables.missing, undefined);
  for (const i of [1, 4]) {
    assert.equal(response.value.results[i].status, "failed");
    assert.deepEqual(response.value.results[i].extracted, {});
  }
  assert.deepEqual(
    f.consumed.map((x) => x.sse),
    ["initial-event", "initial-event"],
  );
});

test(
  "completed WS/SSE repeat has no automatic replay after append failure or genuine uncertain journal commit",
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
          f.beforeConsume(async () => {
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
          protocolCredentials: credentials(),
        });
        assert.equal(response.status, 200);
        const run = response.value;
        checkRun(run, { saved: false });
        checkExchange(f, 0);
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
        const before = f.counts(),
          recovered = await new Store(f.root).get(p.id);
        assert.equal(
          recovered.runs.some((r) => r.id === run.id),
          mode === "unknown",
        );
        if (mode === "unknown")
          assert.deepEqual(
            recovered.runs.find((r) => r.id === run.id).results,
            run.results,
          );
        await f.restart();
        assert.deepEqual(f.counts(), before);
        assert.equal(f.wsRows.length, 2);
        assert.equal(f.sseRows.length, 2);
        assert.equal(f.consumed.length, 2);
        await until(() => f.wss.clients.size === 0 && f.streams.size === 0);
      });
  },
);
