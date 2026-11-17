// Ordinary CI only: fictional credentials/provider, never an OS/domain login.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import {
  av,
  bytes,
  header,
  credentials,
  challengeMessage,
  verifyMic,
} from "./helpers/ntlm-mic-fixture.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const callTool = (client, name, args) =>
  client.callTool({ name: "localapi_" + name, arguments: args });
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function files(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory())
      for (const [name, content] of Object.entries(await files(value)))
        result[entry.name + "/" + name] = content;
    else result[entry.name] = (await readFile(value)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ntlm-mic-workflow-"));
  const seen = [],
    errors = [],
    clients = [],
    waiters = [];
  const pending = new Map(),
    children = new Map(),
    sockets = new WeakMap();
  let connection = 0,
    app;
  const peer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = bytes(req.headers.authorization || ""),
        type = message.readUInt32LE(8);
      const entry = {
        path: req.url,
        type,
        body: Buffer.concat(chunks).toString(),
        connection: sockets.get(req.socket)?.id,
      };
      seen.push(entry);
      for (const waiter of waiters.splice(0)) {
        if (waiter.path === entry.path && waiter.type === type)
          waiter.resolve();
        else waiters.push(waiter);
      }
      if (type === 1) {
        if (req.url === "/challenge-hold") return;
        if (req.url === "/not-found") {
          res.writeHead(404);
          res.end("not-found");
          return;
        }
        const type2 = challengeMessage({
          version: req.url.includes("version"),
          flags: 0,
          padding: 5,
          ...(req.url === "/unsupported"
            ? { extra: [av(10, Buffer.alloc(16))] }
            : {}),
        });
        sockets.set(req.socket, {
          ...sockets.get(req.socket),
          type1: message,
          type2,
        });
        res.writeHead(401, {
          "www-authenticate": header(type2),
          connection: req.url === "/close" ? "close" : "keep-alive",
        });
        res.end();
        return;
      }
      assert.equal(type, 3);
      const state = sockets.get(req.socket);
      assert(
        state?.type1 && state?.type2,
        "Type3 must stay on its Type1 connection",
      );
      const verified = verifyMic(state.type1, state.type2, message);
      assert(verified.proofValid, "independent NT proof");
      assert(verified.micValid, "independent full transcript MIC");
      assert.deepEqual(verified.lm, Buffer.alloc(24));
      assert.equal(verified.pairs.filter((pair) => pair.id === 6).length, 1);
      assert.equal(
        verified.pairs.find((pair) => pair.id === 6).value.readUInt32LE(),
        2,
      );
      assert.equal(message.readUInt32LE(16), 88);
      if (req.url === "/hold" || req.url === "/timeout") return;
      if (req.url === "/reject") {
        res.writeHead(401);
        res.end("fixture policy rejection");
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: origin + "/credential-sink" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ verified: true, path: req.url }));
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500);
      res.end("fixture error");
    }
  });
  peer.on("connection", (socket) => sockets.set(socket, { id: ++connection }));
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + peer.address().port;
  const owner = async (route, body, method = "POST", status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const stop = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = undefined;
    }
  };
  t.after(async () => {
    for (const child of children.keys()) child.kill();
    await Promise.allSettled(children.values());
    for (const id of pending.keys())
      await owner("/api/cancel", { id }).catch(() => {});
    await Promise.allSettled(pending.values());
    await stop();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  app = await createApp({ root, port: 0 });
  return {
    root,
    children,
    origin,
    seen,
    owner,
    get app() {
      return app;
    },
    request(route = "/verified", options = {}) {
      return {
        id: "request",
        name: "Fictional NTLM MIC",
        method: "POST",
        url: origin + route,
        bodyType: "raw",
        body: "fixture-body 雪",
        auth: { type: "ntlm", ...credentials },
        ...options,
      };
    },
    reached(route, type) {
      return seen.some((entry) => entry.path === route && entry.type === type)
        ? Promise.resolve()
        : new Promise((resolve) =>
            waiters.push({ path: route, type, resolve }),
          );
    },
    async project(name = "MIC fixture") {
      return owner("/api/projects", { name }, "POST", 201);
    },
    async plan(projectId, request, extra = {}) {
      return owner(`/api/projects/${projectId}/plans`, {
        name: request.name,
        statusPolicy: "strict200",
        steps: [{ id: "first", request }],
        ...extra,
      });
    },
    async get(projectId) {
      return owner(`/api/projects/${projectId}`, undefined, "GET");
    },
    async run(projectId, planId, runId) {
      const result = owner(`/api/projects/${projectId}/run`, { planId, runId });
      pending.set(runId, result);
      try {
        return await result;
      } finally {
        pending.delete(runId);
      }
    },
    async connect(projectId, transport, execute = true) {
      const client = new Client(
        { name: "ntlm-mic-fixture", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      if (transport === "http") {
        const config = await owner("/api/mcp/config", {
          enabled: true,
          projects: [projectId],
          write: execute,
          execute,
          remember: false,
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { authorization: "Bearer " + config.token },
            },
          }),
        );
      } else {
        const pipe = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            ...(execute ? ["--write", "--execute"] : []),
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        pipe.stderr.resume();
        await client.connect(pipe);
      }
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      assert.equal(tools.includes("localapi_execute_flow"), execute);
      assert(tools.includes("localapi_get_run"));
      return client;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}
async function cli(f, projectId, planId) {
  let child;
  const terminal = new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        env: { ...process.env, LOCAL_API_DATA: f.root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    const collect = (field, value) => {
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + value.length >
        1024 * 1024
      ) {
        failure ||= Error("CLI evidence exceeded fixture cap");
        child.kill();
        return;
      }
      if (field === "stdout") stdout += value;
      else stderr += value;
    };
    child.stdout.on("data", (value) => collect("stdout", value));
    child.stderr.on("data", (value) => collect("stderr", value));
    const timer = setTimeout(() => {
      failure ||= Error("CLI deadline exceeded");
      child.kill();
    }, 10000);
    child.once("error", (error) => {
      failure ||= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
  if (child) f.children.set(child, terminal);
  try {
    return await terminal;
  } finally {
    f.children.delete(child);
  }
}

function successful(run, frozen) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.attemptedRecordId, run.id);
  assert.deepEqual(run.snapshot, frozen);
  assert.equal(run.planHash, hash(frozen));
  assert.equal(run.results[0].response.status, 200);
  assert.equal(run.results[0].response.authHandshake.roundTrips, 2);
  assert.deepEqual(JSON.parse(run.results[0].response.body), {
    verified: true,
    path: new URL(frozen.steps[0].request.url).pathname,
  });
  assert(
    !JSON.stringify(
      run.results.map((result) => ({ logs: result.logs, error: result.error })),
    ).includes(credentials.password),
  );
}

for (const transport of ["http", "stdio"])
  test(
    `NTLM MIC owner and official MCP ${transport} preserve frozen credentials through CLI, backup and restart`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t),
        project = await f.project(),
        denied = await f.project("not granted");
      project.requests = [
        f.request(transport === "http" ? "/verified" : "/verified-version"),
      ];
      await f.owner(`/api/projects/${project.id}`, project, "PUT");
      const saved = await f.get(project.id),
        request = saved.requests[0];
      const result = await f.owner(`/api/projects/${project.id}/execute`, {
        request,
      });
      assert.equal(result.status, 200);
      assert.equal(result.outcome, "passed");
      assert.equal(result.authHandshake.roundTrips, 2);
      const plan = await f.plan(project.id, request),
        frozen = (await f.get(project.id)).plans.find(
          (item) => item.id === plan.id,
        );
      const rejected = await f.plan(project.id, f.request("/unsupported"));
      const client = await f.connect(project.id, transport);
      const deniedBefore = await files(f.app.store.directory(denied.id)),
        beforeCount = f.seen.length;
      assert.equal(
        (
          await callTool(client, "execute_flow", {
            projectId: denied.id,
            planId: plan.id,
          })
        ).isError,
        true,
      );
      assert.deepEqual(
        await files(f.app.store.directory(denied.id)),
        deniedBefore,
      );
      assert.equal(f.seen.length, beforeCount);
      const refused = decode(
        await callTool(client, "execute_flow", {
          projectId: project.id,
          planId: rejected.id,
        }),
      );
      assert.equal(refused.status, "failed");
      assert.equal(refused.recordSaved, true);
      assert.match(refused.results[0].error, /EPA|通道绑定/);
      assert.deepEqual(
        f.seen
          .filter((entry) => entry.path === "/unsupported")
          .map((entry) => entry.type),
        [1],
      );
      const fresh = await f.get(project.id);
      fresh.requests[0].url = "http://127.0.0.1:1/not-the-frozen-request";
      fresh.requests[0].auth.password = "changed-live-only";
      await f.owner(`/api/projects/${project.id}`, fresh, "PUT");
      assert.deepEqual(
        (await f.get(project.id)).plans.find((item) => item.id === plan.id),
        frozen,
      );
      const run = decode(
        await callTool(client, "execute_flow", {
          projectId: project.id,
          planId: plan.id,
        }),
      );
      successful(run, frozen);
      const durable = (await f.get(project.id)).runs.find(
        (item) => item.id === run.id,
      );
      assert.deepEqual(
        decode(
          await callTool(client, "get_run", {
            projectId: project.id,
            runId: run.id,
          }),
        ),
        durable,
      );
      assert.equal(durable.planHash, hash(frozen));
      assert.deepEqual(durable.snapshot, frozen);
      const invoked = await cli(f, project.id, plan.id);
      assert.equal(invoked.code, 0, invoked.stderr + invoked.stdout);
      successful(JSON.parse(invoked.stdout), frozen);
      const beforeCurl = await files(f.app.store.directory(project.id));
      const curl = await f.owner(
        `/api/projects/${project.id}/curl`,
        { request: frozen.steps[0].request },
        "POST",
        400,
      );
      assert.match(curl.error, /NTLM导出/);
      assert.deepEqual(
        await files(f.app.store.directory(project.id)),
        beforeCurl,
      );
      const backup = await f.owner(
        `/api/projects/${project.id}/export`,
        undefined,
        "GET",
      );
      const restored = await f.owner(
        "/api/restore",
        { document: backup },
        "POST",
        201,
      );
      assert.notEqual(restored.id, project.id);
      assert.deepEqual(restored.runs, backup.runs);
      assert.deepEqual(
        restored.plans.find((item) => item.id === plan.id),
        frozen,
      );
      const countBeforeRestart = f.seen.length;
      await f.restart();
      const restarted = await f.get(restored.id);
      assert.deepEqual(restarted.runs, backup.runs);
      assert.deepEqual(restarted.requests[0].auth, backup.requests[0].auth);
      const reader = await f.connect(restored.id, transport, false);
      assert.deepEqual(
        decode(
          await callTool(reader, "get_run", {
            projectId: restored.id,
            runId: run.id,
          }),
        ),
        durable,
      );
      assert.equal(
        (
          await callTool(reader, "get_run", {
            projectId: project.id,
            runId: run.id,
          })
        ).isError,
        true,
      );
      assert.equal(
        f.seen.length,
        countBeforeRestart,
        "reading restored evidence must not replay NTLM",
      );
      successful(await f.run(restored.id, plan.id, "after-restart"), frozen);
      const accepted = f.seen.filter(
        (entry) => entry.path === new URL(request.url).pathname,
      );
      assert.equal(accepted.length, 8); // owner, SDK, CLI, explicit restored run: 2 rounds each
      for (let index = 0; index < accepted.length; index += 2) {
        assert.deepEqual(
          accepted.slice(index, index + 2).map((entry) => entry.type),
          [1, 3],
        );
        assert.equal(
          accepted[index].connection,
          accepted[index + 1].connection,
        );
        assert.equal(accepted[index].body, request.body);
        assert.equal(accepted[index + 1].body, request.body);
      }
      assert.equal(
        new Set(
          accepted
            .filter((entry) => entry.type === 1)
            .map((entry) => entry.connection),
        ).size,
        4,
      );
    },
  );

test(
  "NTLM MIC final errors, deadline, cancellation and failed result saves never retry authenticated dispatch",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.project();
    for (const [route, expectedTypes, responseStatus, error] of [
      ["/not-found", [1], 404],
      ["/close", [1], undefined, /连接|socket|NTLM/],
      ["/reject", [1, 3], 401],
      ["/redirect", [1, 3], 302],
      ["/timeout", [1, 3], undefined, /超时/],
    ]) {
      const plan = await f.plan(
        project.id,
        f.request(route, { timeout: route === "/timeout" ? 1000 : 5000 }),
      );
      const run = await f.run(project.id, plan.id, "run-" + route.slice(1));
      assert.equal(run.status, "failed");
      assert.equal(run.recordSaved, true);
      if (responseStatus)
        assert.equal(run.results[0].response.status, responseStatus);
      if (error) assert.match(run.results[0].error, error);
      assert.deepEqual(
        f.seen
          .filter((entry) => entry.path === route)
          .map((entry) => entry.type),
        expectedTypes,
      );
    }
    assert(!f.seen.some((entry) => entry.path === "/credential-sink"));
    for (const [route, type] of [
      ["/challenge-hold", 1],
      ["/hold", 3],
    ]) {
      const request = f.request(route),
        next = f.request("/must-not-run");
      const plan = await f.plan(project.id, request, {
        steps: [
          { id: "held", request },
          { id: "next", request: next },
        ],
      });
      const pending = f.run(project.id, plan.id, "cancel-" + type);
      await f.reached(route, type);
      await f.owner("/api/cancel", { id: "cancel-" + type });
      const run = await pending;
      assert.equal(run.status, "cancelled");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 1);
      assert.deepEqual(
        f.seen
          .filter((entry) => entry.path === route)
          .map((entry) => entry.type),
        type === 1 ? [1] : [1, 3],
      );
      assert(!f.seen.some((entry) => entry.path === "/must-not-run"));
    }
    const plan = await f.plan(project.id, f.request("/unsaved")),
      before = await f.get(project.id);
    const append = f.app.store.append.bind(f.app.store);
    let attempted = 0;
    f.app.store.append = async (id, kind, record) => {
      if (id === project.id && kind === "runs") {
        attempted++;
        throw Error("fixture result storage failure");
      }
      return append(id, kind, record);
    };
    let unsaved;
    try {
      unsaved = await f.run(project.id, plan.id, "unsaved");
    } finally {
      f.app.store.append = append;
    }
    assert.equal(unsaved.status, "passed");
    assert.equal(unsaved.recordSaved, false);
    assert.equal(unsaved.recordId, null);
    assert.equal(unsaved.attemptedRecordId, unsaved.id);
    assert.deepEqual(unsaved.persistenceOutcome, {
      code: "RECORD_SAVE_FAILED",
      retry_safe: false,
    });
    assert.match(unsaved.persistenceError, /保存未确认/);
    assert(!JSON.stringify(unsaved).includes("fixture result storage failure"));
    assert.equal(attempted, 1);
    assert.deepEqual((await f.get(project.id)).runs, before.runs);
    assert.deepEqual(
      f.seen
        .filter((entry) => entry.path === "/unsaved")
        .map((entry) => entry.type),
      [1, 3],
    );
    const count = f.seen.length;
    await f.restart();
    assert.deepEqual((await f.get(project.id)).runs, before.runs);
    assert.equal(f.seen.length, count);
  },
);

test(
  "root NTLM MIC real journal uncertainty recovers the same evidence without repeating authentication",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.project("MIC journal uncertainty"),
      other = await f.project("isolated from MIC journal");
    const otherBytes = await files(f.app.store.directory(other.id));
    const plan = await f.plan(project.id, f.request("/journal-version"));
    const before = await f.get(project.id),
      frozen = before.plans.find((item) => item.id === plan.id);
    const store = f.app.store,
      originalSave = store.save,
      originalRead = store.readUnlocked;
    const directory = store.directory(project.id),
      plans = path.join(directory, "plans"),
      kept = path.join(directory, "plans-owned-backup"),
      journalPath = path.join(directory, ".transaction.json");
    let actualError,
      journal,
      run,
      obstructed = false,
      attempts = 0;
    // The real Store writes its journal and determines uncertainty. Only the
    // owned filesystem obstacle is injected, never a fabricated typed error.
    store.save = async function (candidate, options) {
      if (candidate.id !== project.id || !options?.activity)
        return originalSave.call(this, candidate, options);
      attempts++;
      this.readUnlocked = async function (key, ...args) {
        const current = await originalRead.call(this, key, ...args);
        this.readUnlocked = originalRead;
        await rename(plans, kept);
        obstructed = true;
        await writeFile(plans, "mic-private-obstacle");
        return current;
      };
      try {
        return await originalSave.call(this, candidate, options);
      } catch (error) {
        actualError = error;
        throw error;
      } finally {
        this.readUnlocked = originalRead;
      }
    };
    try {
      run = await f.run(project.id, plan.id, "mic-journal-unknown");
      assert.equal(run.status, "passed", JSON.stringify(run.results));
      assert.equal(run.results[0].response.status, 200);
      assert.equal(run.results[0].response.authHandshake.roundTrips, 2);
      assert.equal(attempts, 1);
      assert(actualError instanceof ProjectCommitUncertain);
      assert.equal(actualError.projectId, project.id);
      assert.equal(run.recordSaved, false);
      assert.equal(run.recordId, null);
      assert.equal(run.attemptedRecordId, run.id);
      assert.deepEqual(run.persistenceOutcome, {
        code: "PROJECT_COMMIT_UNCERTAIN",
        project_id: project.id,
        commit_outcome: "unknown",
        retry_safe: false,
      });
      assert.deepEqual(run.snapshot, frozen);
      assert.equal(run.planHash, hash(frozen));
      for (const secret of [
        f.root,
        "mic-private-obstacle",
        "ENOTDIR",
        "EISDIR",
      ])
        assert(!JSON.stringify(run).includes(secret));
      journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(journal.runs.length, 1);
      assert.equal(journal.runs[0].id, run.attemptedRecordId);
      assert.equal(journal.runs[0].source, "manual");
      assert.deepEqual(journal.runs[0].snapshot, frozen);
      assert.equal(journal.runs[0].planHash, hash(frozen));
      assert.deepEqual(journal.plans, before.plans);
      assert.equal(journal.configRevision, before.configRevision);
      assert.deepEqual(
        f.seen.map((entry) => entry.type),
        [1, 3],
      );
      assert.equal(f.seen[0].connection, f.seen[1].connection);
    } finally {
      store.save = originalSave;
      store.readUnlocked = originalRead;
      if (obstructed) {
        await rm(plans, { force: true });
        await rename(kept, plans);
      }
    }
    const recovered = await new Store(f.root).get(project.id);
    assert.deepEqual(recovered.runs, journal.runs);
    assert.equal(recovered.configRevision, before.configRevision);
    await assert.rejects(readFile(journalPath), { code: "ENOENT" });
    assert.deepEqual(await files(store.directory(other.id)), otherBytes);
    const backup = await f.owner(
      `/api/projects/${project.id}/export`,
      undefined,
      "GET",
    );
    const restored = await f.owner(
      "/api/restore",
      { document: backup },
      "POST",
      201,
    );
    await f.restart();
    assert.deepEqual((await f.get(restored.id)).runs, journal.runs);
    for (const transport of ["http", "stdio"]) {
      const reader = await f.connect(restored.id, transport, false);
      assert.deepEqual(
        decode(
          await callTool(reader, "get_run", {
            projectId: restored.id,
            runId: run.attemptedRecordId,
          }),
        ),
        journal.runs[0],
      );
      assert.equal(
        (
          await callTool(reader, "get_run", {
            projectId: project.id,
            runId: run.id,
          })
        ).isError,
        true,
      );
    }
    assert.deepEqual(
      f.seen.map((entry) => entry.type),
      [1, 3],
      "reconcile, restore and read never repeat a completed authentication",
    );
    const invoked = await cli(f, restored.id, plan.id);
    assert.equal(invoked.code, 0, invoked.stderr + invoked.stdout);
    const next = JSON.parse(invoked.stdout);
    successful(next, frozen);
    assert.notEqual(next.id, run.id);
    assert.deepEqual(
      f.seen.map((entry) => entry.type),
      [1, 3, 1, 3],
    );
    assert.equal(f.seen[2].connection, f.seen[3].connection);
    assert.notEqual(f.seen[0].connection, f.seen[2].connection);
    const after = await f.get(restored.id);
    assert.equal(after.runs.length, 2);
    assert.deepEqual(
      after.runs.find((item) => item.id === run.id),
      journal.runs[0],
    );
    assert.equal(after.runs.find((item) => item.id === next.id).source, "cli");
    await f.restart();
    assert.deepEqual((await f.get(restored.id)).runs, after.runs);
    assert.equal(f.seen.length, 4);
    assert.deepEqual(await files(f.app.store.directory(other.id)), otherBytes);
  },
);
