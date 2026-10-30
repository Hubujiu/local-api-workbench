import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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
    if (Date.now() > deadline) throw Error("TCP repeat fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
// Delimiter is a root-only composition with PR12; feature PR44 uses EOF.
async function fixture(t, { delimiter = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-tcp-workflow-"));
  let app = await createApp({ root, port: 0 });
  const sockets = new Set(),
    received = [],
    consumed = [],
    clients = [];
  let connections = 0;
  let onTCP = async () => {},
    onHTTP = async () => {};
  const tcp = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", async (bytes) => {
      const token = `tcp-token-${received.length + 1}${delimiter ? "|" : ""}`;
      received.push({ message: bytes.toString(), token });
      await onTCP(socket, received.length);
      if (!socket.destroyed) {
        if (delimiter)
          socket.write(token); // Never send EOF: client must find marker.
        else socket.end(token);
      }
    });
  });
  const peer = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    consumed.push({ url: req.url, token: req.headers["x-token"] });
    await onHTTP(req);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await Promise.all(
    [tcp, peer].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))),
  );
  const closeApp = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await closeApp();
    for (const socket of sockets) socket.destroy();
    peer.closeAllConnections();
    await Promise.all([tcp, peer].map((s) => new Promise((r) => s.close(r))));
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
  const project = await app.store.create("TCP repeat");
  project.environments[0].variables = { token: "initial" };
  project.protocols = [
    normalizeProtocol({
      id: "saved-tcp",
      type: "tcp",
      url: "127.0.0.1",
      port: tcp.address().port,
      completion: delimiter ? "delimiter" : "end",
      ...(delimiter ? { delimiterHex: "7c" } : {}),
      duration: 5000,
    }),
  ];
  await app.store.save(project);
  const definition = () => ({
    name: "TCP then HTTP, twice",
    environmentId: project.environments[0].id,
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: [
          {
            id: "wire",
            type: "protocol",
            protocol: { definitionId: "saved-tcp", message: "{{token}}" },
            extract: [{ name: "token", path: "$.body" }],
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
    beforeTCP(fn) {
      onTCP = fn;
    },
    beforeHTTP(fn) {
      onHTTP = fn;
    },
    client() {
      const c = new Client({ name: "tcp-repeat-workflow", version: "1" });
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
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.snapshot.steps[0].count, 2);
  assert.equal(run.snapshot.steps[0].steps[0].protocol.definition.type, "tcp");
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
    run.results[0].protocolResult.result.body,
    run.results[2].protocolResult.result.body,
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
                ? "TCP repeat CLI timeout"
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
  "TCP repeat owner, canonical SDK HTTP/stdio and CLI preserve frozen references and backup graph identities",
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
    live.protocols[0].port = 1;
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

test("TCP repeat malformed wrappers, disabled invalid wire options and invalid credential identities fail before network", async (t) => {
  const f = await fixture(t),
    p = f.project;
  p.protocols.push(
    normalizeProtocol({
      id: "saved-ws",
      type: "websocket",
      url: "ws://127.0.0.1:1",
    }),
    normalizeProtocol({
      id: "saved-sse",
      type: "sse",
      url: "http://127.0.0.1:1",
    }),
  );
  await f.app.store.save(p);
  for (const reference of ["saved-ws", "saved-sse"]) {
    const input = f.definition();
    input.steps[0].enabled = false;
    input.steps[0].steps[0].protocol.definitionId = reference;
    // A valid reference is allowed now, but disabled leaves still validate
    // protocol-specific options: WS rejects maxEvents, SSE rejects message.
    if (reference === "saved-ws")
      input.steps[0].steps[0].protocol.maxEvents = 1;
    assert.notEqual(
      (await f.post(`projects/${p.id}/plans`, input)).status,
      200,
    );
  }
  const unknown = f.definition();
  unknown.steps[0].steps[0].protocol.unknown = "reject";
  assert.notEqual(
    (await f.post(`projects/${p.id}/plans`, unknown)).status,
    200,
  );
  assert.equal((await f.app.store.get(p.id)).plans.length, 0);
  const made = await f.post(`projects/${p.id}/plans`, f.definition());
  assert.equal(made.status, 200);
  for (const protocolCredentials of [
    { '["group","wire",0]': {} },
    { wire: { headers: { Authorization: "synthetic-only" } } },
  ]) {
    assert.notEqual(
      (
        await f.post(`projects/${p.id}/run`, {
          planId: made.value.id,
          protocolCredentials,
        })
      ).status,
      200,
    );
  }
  assert.equal(f.connections, 0);
  assert.equal(f.received.length, 0);
  assert.equal(f.consumed.length, 0);
  assert.deepEqual((await f.app.store.get(p.id)).runs, []);
});

test("ordinary repeated TCP extraction is atomic but retains permitted HTTP continuation", async (t) => {
  const f = await fixture(t),
    p = f.project,
    input = f.definition();
  input.steps[0].steps[0].extract = [
    { name: "token", path: "$.body", scope: "environment" },
    { name: "missing", path: "$.absent.value" },
  ];
  const made = await f.post(`projects/${p.id}/plans`, input);
  assert.equal(made.status, 200);
  const response = await f.post(`projects/${p.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(response.status, 200);
  const run = response.value;
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results.map((r) => r.status),
    ["failed", "passed", "failed", "passed"],
  );
  assert.equal(run.variables.token, "initial");
  assert.equal(run.variables.missing, undefined);
  assert.deepEqual(
    f.received.map((r) => r.message),
    ["initial", "initial"],
  );
  assert.deepEqual(
    f.consumed.map((r) => r.token),
    ["initial", "initial"],
  );
  assert.equal(
    (await new Store(f.root).get(p.id)).environments[0].variables.token,
    "initial",
  );
  for (const i of [0, 2]) assert.deepEqual(run.results[i].extracted, {});
});

test(
  "second-iteration hanging TCP cancellation and explicit deadline prevent the next HTTP and release sockets",
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
        f.beforeTCP((socket, count) => {
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
                runId: "tcp-repeat-cancel",
              })
            : runPlan(made.value, { token: "initial" }, executeRequest, {
                executeProtocol: executeWireFlow,
                signal: controller.signal,
              });
        await pending;
        if (mode === "owner-cancel")
          assert.equal(
            (await f.post("cancel", { id: "tcp-repeat-cancel" })).status,
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
  "completed TCP repeat evidence is never replayed after generic append failure or genuine post-journal uncertainty",
  { timeout: 15000 },
  async (t) => {
    for (const mode of ["generic", "unknown", "delimiter-unknown"])
      await t.test(mode, async (t) => {
        const f = await fixture(t, { delimiter: mode === "delimiter-unknown" }),
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
        if (mode === "delimiter-unknown") {
          const retained = recovered.runs.find((r) => r.id === run.id);
          for (const index of [0, 2]) {
            assert.equal(
              retained.results[index].protocol.definition.delimiterHex,
              "7c",
            );
            assert.equal(
              retained.results[index].protocolResult.result.framing.matched,
              true,
            );
            assert.equal(
              retained.results[index].protocolResult.result.body,
              f.received[index / 2].token,
            );
          }
        }
        assert.equal(f.received.length, 2);
        assert.equal(f.consumed.length, 2);
        await until(() => f.sockets.size === 0);
      });
  },
);

test("root delimiter repeat composes frozen framing, per-iteration extraction and HTTP consumers", async (t) => {
  const f = await fixture(t, { delimiter: true }),
    p = f.project;
  const made = await f.post(`projects/${p.id}/plans`, f.definition());
  assert.equal(made.status, 200);
  const live = await f.app.store.get(p.id);
  live.protocols[0].port = 1;
  live.protocols[0].delimiterHex = "00";
  await f.app.store.save(live);
  const response = await f.post(`projects/${p.id}/run`, {
    planId: made.value.id,
  });
  assert.equal(response.status, 200);
  checkRun(response.value);
  checkExchange(f, 0);
  for (const index of [0, 2]) {
    const result = response.value.results[index];
    assert.equal(result.protocol.definition.completion, "delimiter");
    assert.equal(result.protocol.definition.delimiterHex, "7c");
    assert.equal(result.protocolResult.result.framing.matched, true);
    assert.equal(result.protocolResult.result.partial, false);
    assert.equal(result.protocolResult.result.timedOut, false);
    assert.equal(
      result.protocolResult.result.body,
      f.received[index / 2].token,
    );
    assert.equal(result.protocolResult.result.framing.trailingSize, 0);
  }
  assert.equal(f.received.length, 2);
  assert.equal(f.consumed.length, 2);
  await until(() => f.sockets.size === 0);
  const disk = await new Store(f.root).get(p.id);
  assert.deepEqual(
    disk.runs.find((r) => r.id === response.value.id).snapshot.steps,
    made.value.steps,
  );
  assert.throws(() => exportApipostDirectory(disk));
});
