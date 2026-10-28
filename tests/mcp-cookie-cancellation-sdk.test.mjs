// ROOT cross-feature acceptance. Real official SDK HTTP/stdio, normal owned
// Cookie file locks, actual loopback responses, durable Store readback. No VM.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { ProjectCookieJar } from "../src/cookie-jar.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
const repo = path.resolve(import.meta.dirname, "..");

const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
async function waitFor(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw Error("Missing server-side observation: " + description);
}
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const exists = async (file) => {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

// Observation only: invoke the genuine method immediately with unchanged
// receiver/arguments, then mark its entry and return its original promise.
// No lock/transport/transaction mock, artificial wait, or replaced outcome.
function observeCookieMethods(Jar, file, marker) {
  const restore = [];
  for (const method of ["header", "capture"]) {
    const original = Jar.prototype[method];
    Jar.prototype[method] = function (...args) {
      const pending = Reflect.apply(original, this, args);
      if (this.file === file) writeFileSync(marker + "." + method, "entered");
      return pending;
    };
    restore.push(() => {
      Jar.prototype[method] = original;
    });
  }
  return () => restore.forEach((fn) => fn());
}

async function fixture(t, transportKind, stage, outcome) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-cookie-cancel-"));
  let app,
    client,
    transport,
    restoreObserver = () => {};
  const ownedLocks = [],
    sockets = new Set(),
    errors = [],
    messages = [],
    wire = [];
  let releaseHeld,
    responseWritten = false,
    activeHandler;
  const peer = http.createServer((req, res) => {
    wire.push({ path: req.url, cookie: req.headers.cookie || "" });
    Promise.resolve(activeHandler(req, res)).catch((error) =>
      res.destroy(error),
    );
  });
  peer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const lock of ownedLocks) await lock.release();
    await client?.close().catch(() => {});
    let drainError;
    try {
      if (app)
        await waitFor(async () => {
          const state = await owner("/api/mcp/config");
          return !state.activities.some((row) => row.status === "running");
        }, "HTTP server activity drained before fixture removal");
    } catch (error) {
      drainError = error;
    } finally {
      restoreObserver();
      for (const socket of sockets) socket.destroy();
      if (app) await closeServer(app.server);
      if (peer.listening) await closeServer(peer);
      await rm(root, { recursive: true, force: true });
    }
    if (drainError) throw drainError;
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  app = await createApp({ root, port: 0 });
  const store = app.store,
    project = await store.create("Cookie SDK allowed"),
    denied = await store.create("Cookie SDK denied");
  const base = `http://127.0.0.1:${peer.address().port}`;
  const environmentId = project.environments[0].id,
    otherEnvironmentId = "cookie-other-environment";
  project.currentEnvironmentId = environmentId;
  project.globalVariables = { globalValue: "old-global" };
  project.environments[0].variables = { environmentValue: "old-environment" };
  project.environments.push({
    id: otherEnvironmentId,
    name: "Other",
    variables: { environmentValue: "other-environment" },
    serverUrls: {},
  });
  const request = {
    id: "held-cookie",
    name: "Held Cookie",
    url: base + "/interrupted",
    timeout: outcome === "timeout" ? 1000 : 15000,
    assertions: [{ target: "status", op: "eq", value: 200 }],
    extract: [
      { name: "runtimeValue", path: "$.value", scope: "runtime" },
      { name: "globalValue", path: "$.value", scope: "global" },
      { name: "environmentValue", path: "$.value", scope: "environment" },
    ],
    after: [{ type: "set", name: "afterMarker", value: "must-not-run" }],
  };
  project.requests = [request];
  project.plans = [
    snapshotPlan({
      id: "interrupted",
      name: "Interrupted Cookie flow",
      steps: [
        { id: "first", request },
        // Ordinary pre-response timeouts retain existing continue-plan semantics;
        // this case intentionally tests only one request's complete deadline.
        ...(stage === "header" && outcome === "timeout"
          ? []
          : [
              {
                id: "later",
                request: { name: "Must not run", url: base + "/later" },
              },
            ]),
      ],
    }),
    snapshotPlan({
      id: "healthy",
      name: "Healthy reuse",
      steps: [{ request: { name: "Healthy", url: base + "/healthy" } }],
    }),
    snapshotPlan({
      id: "healthy-switch",
      name: "Captured environment",
      steps: [
        {
          request: {
            name: "Switch while request runs",
            url: base + "/healthy-switch",
          },
        },
      ],
    }),
  ];
  await store.save(project);
  const deniedBefore = await store.get(denied.id);
  const jar = new ProjectCookieJar(root, project.id, environmentId),
    otherJar = new ProjectCookieJar(root, project.id, otherEnvironmentId);
  for (const [j, value] of [
    [jar, "private-jar-A"],
    [otherJar, "private-jar-B"],
  ]) {
    await j.configure({ enabled: true, expectedRevision: 0 });
    await j.setCookie(base, `seed=${value}; Path=/`, { expectedRevision: 1 });
    // Never sent by these endpoints: unlike actual wire evidence, this local
    // credential must stay out of portable project definitions/history.
    await j.setCookie(
      base + "/never-transmitted",
      `local-only=${value}-local-only; Path=/never-transmitted`,
      { expectedRevision: 2 },
    );
  }
  const before = await readFile(jar.file),
    otherBefore = await readFile(otherJar.file);
  async function hold() {
    const originalRelease = await acquireFileLock(jar.file + ".lock");
    const lock = { released: false, watchdogReleased: false };
    lock.release = async () => {
      if (lock.released) return;
      lock.released = true;
      clearTimeout(watchdog);
      await originalRelease();
    };
    const watchdog = setTimeout(() => {
      lock.watchdogReleased = true;
      lock.release().catch(() => {});
    }, 12000);
    ownedLocks.push(lock);
    return lock;
  }
  if (stage === "header") releaseHeld = await hold();
  activeHandler = async (_req, res) => {
    if (stage === "capture") releaseHeld = await hold();
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "late=must-not-publish; Path=/",
      "x-real-response": "yes",
    });
    res.end('{"value":42,"proof":"actual-loopback-response"}');
    responseWritten = true;
  };
  const marker = path.join(root, "cookie-observed");
  const preload = path.join(root, "cookie-observer.mjs");
  await writeFile(
    preload,
    `import {writeFileSync} from 'node:fs';\nimport {ProjectCookieJar} from ${JSON.stringify(pathToFileURL(path.join(repo, "src/cookie-jar.mjs")).href)};\n(${observeCookieMethods.toString()})(ProjectCookieJar,${JSON.stringify(jar.file)},${JSON.stringify(marker)});\n`,
  );
  async function owner(route, body) {
    const response = await fetch(app.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, await response.clone().text());
    return response.json();
  }
  async function connect(projectId = project.id, observe = true) {
    await client?.close();
    client = new Client({ name: "cookie-sdk-acceptance", version: "1.0.0" });
    client.onerror = (error) => errors.push(error.message);
    if (transportKind === "http") {
      const config = await owner("/api/mcp/config", {
        enabled: true,
        projects: [projectId],
        write: true,
        execute: true,
        remember: false,
      });
      transport = new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      });
    } else {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          ...(observe ? ["--import", preload] : []),
          path.join(repo, "src/mcp.mjs"),
          "--project",
          projectId,
          "--write",
          "--execute",
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      });
    }
    const originalSend = transport.send;
    transport.send = function (...args) {
      const pending = Reflect.apply(originalSend, this, args);
      messages.push(structuredClone(args[0]));
      return pending;
    };
    await client.connect(transport);
  }
  if (transportKind === "http")
    restoreObserver = observeCookieMethods(ProjectCookieJar, jar.file, marker);
  await connect();
  const call = (name, args, options) =>
    client.callTool(
      { name: "localapi_" + name, arguments: args },
      undefined,
      options,
    );
  return {
    root,
    store,
    project,
    denied,
    deniedBefore,
    jar,
    otherJar,
    before,
    otherBefore,
    base,
    wire,
    messages,
    errors,
    marker,
    environmentId,
    otherEnvironmentId,
    call,
    owner,
    connect,
    get client() {
      return client;
    },
    get transport() {
      return transport;
    },
    get lock() {
      return releaseHeld;
    },
    get responseWritten() {
      return responseWritten;
    },
    setHandler(fn) {
      activeHandler = fn;
    },
    async switchEnvironment(id) {
      const p = await store.get(project.id);
      p.currentEnvironmentId = id;
      await store.save(p);
    },
    async restart() {
      await client.close();
      client = undefined;
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
      await connect(project.id, false);
    },
  };
}

function assertInterrupted(run, stage, outcome, environmentId) {
  assert.equal(run.status, outcome === "cancel" ? "cancelled" : "failed");
  assert.equal(run.environmentId, environmentId);
  assert.equal(run.source, "mcp");
  assert.equal(run.results.length, 1, "must stop before the following request");
  const result = run.results[0];
  assert.equal(result.status, "failed");
  assert.match(
    result.error,
    outcome === "cancel" ? /abort|cancel|取消/i : /timeout|超时/i,
  );
  assert.deepEqual(
    result.assertions,
    [],
    "no post-response assertions after interrupted capture",
  );
  assert.deepEqual(
    result.extracted,
    {},
    "no extraction after interrupted capture",
  );
  assert.equal(run.variables.runtimeValue, undefined);
  assert.equal(run.variables.afterMarker, undefined);
  assert.equal(run.variables.globalValue, "old-global");
  assert.equal(run.variables.environmentValue, "old-environment");
  if (stage === "capture") {
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers["x-real-response"], "yes");
    assert.equal(
      JSON.parse(result.response.body).proof,
      "actual-loopback-response",
    );
    const failure = {
      phase: "cookie-capture",
      code: outcome === "cancel" ? "REQUEST_CANCELLED" : "REQUEST_TIMEOUT",
      retry_safe: false,
    };
    assert.deepEqual(result.failure, failure);
    assert.deepEqual(result.response.failure, failure);
  } else
    assert.equal(
      result.response,
      undefined,
      "header interruption has no completed network response",
    );
}
async function readback(f, run, projectId = f.project.id) {
  const seen = f.wire.length;
  const result = decode(
    await f.call("get_execution_result", { projectId, runId: run.id }),
  );
  assert.deepEqual(result, run);
  const chunk = decode(
    await f.call("get_execution_result_chunk", {
      projectId,
      runId: run.id,
      offsetBytes: 0,
      maxBytes: 256 * 1024,
    }),
  );
  assert.equal(chunk.eof, true);
  assert.equal(chunk.runId, run.id);
  assert.equal(chunk.projectId, projectId);
  const bytes = Buffer.from(chunk.data, "base64");
  assert.equal(chunk.totalBytes, bytes.length);
  assert.equal(chunk.chunkBytes, bytes.length);
  assert.equal(chunk.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(JSON.parse(bytes.toString()), run);
  assert.equal(
    f.wire.length,
    seen,
    "reading evidence must not replay execution",
  );
}

for (const kind of ["http", "stdio"])
  for (const stage of ["header", "capture"])
    for (const outcome of ["cancel", "timeout"])
      test(
        `${kind}: SDK ${outcome} during Cookie ${stage} lock saves terminal evidence before release and reuses session`,
        { timeout: 25000 },
        async (t) => {
          const f = await fixture(t, kind, stage, outcome);
          const controller = new AbortController();
          const invocation = f.call(
            "execute_flow",
            { projectId: f.project.id, planId: "interrupted" },
            { signal: controller.signal },
          );
          // Observe rejection immediately to avoid an unhandled SDK abort promise.
          const settled = invocation.then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await waitFor(
            () => exists(f.marker + "." + stage),
            `real ${stage} entered`,
          );
          assert(f.lock && !f.lock.released);
          if (stage === "capture") {
            assert(f.responseWritten);
            assert.equal(f.wire.length, 1);
            assert.equal(f.wire[0].cookie, "seed=private-jar-A");
          } else assert.equal(f.wire.length, 0);
          await f.switchEnvironment(f.otherEnvironmentId);
          if (outcome === "cancel") controller.abort();
          let run;
          try {
            run = await waitFor(
              async () =>
                (await new Store(f.root).get(f.project.id)).runs.find(
                  (row) => row.planId === "interrupted",
                ),
              "durable interrupted run while own cookie lock remains held",
            );
            assert.equal(
              f.lock.released,
              false,
              "terminal save must precede parent lock release",
            );
            assert.equal(f.lock.watchdogReleased, false);
            assertInterrupted(run, stage, outcome, f.environmentId);
            assert.deepEqual(await readFile(f.jar.file), f.before);
            assert.deepEqual(await readFile(f.otherJar.file), f.otherBefore);
          } finally {
            await f.lock.release();
          }
          const rpc = await settled;
          if (outcome === "cancel") {
            assert.match(rpc.error?.message || "", /abort|cancel/i);
            const request = f.messages.find(
              (message) =>
                message.method === "tools/call" &&
                message.params?.name === "localapi_execute_flow",
            );
            assert(request);
            assert(
              f.messages.some(
                (message) =>
                  message.method === "notifications/cancelled" &&
                  message.params.requestId === request.id,
              ),
              "official SDK AbortSignal must send the matching cancellation notification",
            );
          } else {
            assert.equal(rpc.error, undefined);
            const output = decode(rpc.value);
            assert.equal(output.status, "failed");
            assert.equal(output.recordSaved, true);
            assert.equal(output.recordId, run.id);
            assert.equal(output.attemptedRecordId, run.id);
            assert.deepEqual(output.results, run.results);
          }
          // Wait for the server-side lifecycle, not merely SDK AbortSignal rejection.
          await waitFor(async () => {
            const rows =
              kind === "stdio"
                ? await readMCPActivities(f.root)
                : (await f.owner("/api/mcp/config")).activities;
            return rows.some(
              (row) =>
                row.projectId === f.project.id &&
                (row.executionStatus ?? row.status) === run.status &&
                row.recordSaved === true,
            );
          }, "server-side confirmed saved activity");
          const saved = await new Store(f.root).get(f.project.id);
          assert.equal(saved.currentEnvironmentId, f.otherEnvironmentId);
          assert.deepEqual(saved.globalVariables, {
            globalValue: "old-global",
          });
          assert.equal(
            saved.environments.find((e) => e.id === f.environmentId).variables
              .environmentValue,
            "old-environment",
          );
          assert.deepEqual(await f.store.get(f.denied.id), f.deniedBefore);
          await readback(f, run);
          const denied = await f.call("get_execution_result", {
            projectId: f.denied.id,
            runId: run.id,
          });
          assert.equal(denied.isError, true);
          assert.match(denied.content[0].text, /未授权/);
          const sameSession =
            kind === "http" ? f.transport.sessionId : f.transport.pid;
          f.setHandler((_req, res) => {
            res.setHeader("content-type", "application/json");
            res.end('{"healthy":true}');
          });
          for (const [environmentId, expectedCookie] of [
            [undefined, "seed=private-jar-B"],
            [f.environmentId, "seed=private-jar-A"],
          ]) {
            const healthy = decode(
              await f.call("execute_flow", {
                projectId: f.project.id,
                planId: "healthy",
                ...(environmentId ? { environmentId } : {}),
              }),
            );
            assert.equal(healthy.status, "passed");
            assert.equal(healthy.recordSaved, true);
            assert.equal(healthy.recordId, healthy.id);
            assert.equal(healthy.attemptedRecordId, healthy.id);
            assert.equal(f.wire.at(-1).cookie, expectedCookie);
            const durable = (
              await new Store(f.root).get(f.project.id)
            ).runs.find((r) => r.id === healthy.recordId);
            assert(durable);
            await readback(f, durable);
          }
          assert.equal(
            kind === "http" ? f.transport.sessionId : f.transport.pid,
            sameSession,
            "healthy flow must reuse the same SDK session/process",
          );
          await f.client.ping();
          assert.equal(
            f.wire.filter((r) => r.path === "/interrupted").length,
            stage === "capture" ? 1 : 0,
          );
          assert.equal(f.wire.filter((r) => r.path === "/later").length, 0);
          await delay(50);
          assert.deepEqual(
            await readFile(f.jar.file),
            f.before,
            "cancelled cookie transaction must never publish later",
          );
          assert.deepEqual(await readFile(f.otherJar.file), f.otherBefore);
          assert.deepEqual(
            (await readdir(f.jar.directory)).filter(
              (n) => n.endsWith(".tmp") || n.endsWith(".lock"),
            ),
            [],
          );
          assert(
            !f.errors.some((error) => /unknown.*id/i.test(error)),
            f.errors.join("\n"),
          );
          if (stage === "capture" && outcome === "timeout") {
            // Positive race: selection changes after network arrival, but capture
            // still belongs to the environment selected at execution start.
            await f.switchEnvironment(f.environmentId);
            let resume,
              arrived = false;
            const gate = new Promise((resolve) => {
              resume = resolve;
            });
            f.setHandler(async (_req, res) => {
              arrived = true;
              await gate;
              res.setHeader(
                "set-cookie",
                "captured=initial-environment; Path=/",
              );
              res.end("healthy switch");
            });
            const healthySwitch = f.call("execute_flow", {
              projectId: f.project.id,
              planId: "healthy-switch",
            });
            try {
              await waitFor(() => arrived, "healthy request reached origin");
              await f.switchEnvironment(f.otherEnvironmentId);
            } finally {
              resume();
            }
            const switched = decode(await healthySwitch);
            assert.equal(switched.status, "passed");
            assert.equal(switched.environmentId, f.environmentId);
            assert.match(
              await f.jar.header(f.base),
              /captured=initial-environment/,
            );
            assert.deepEqual(await readFile(f.otherJar.file), f.otherBefore);
            const backup = await f.owner(
              `/api/projects/${f.project.id}/export`,
            );
            assert.equal(
              JSON.stringify(backup).includes("private-jar-A-local-only"),
              false,
            );
            assert.equal(
              JSON.stringify(backup).includes("private-jar-B-local-only"),
              false,
            );
            // Backups intentionally retain already-sent request evidence;
            // retaining that evidence must not authorize or restore a live jar.
            assert(
              backup.runs.some((row) =>
                row.results.some((step) =>
                  step.response?.request?.headers?.cookie?.includes(
                    "seed=private-jar-A",
                  ),
                ),
              ),
            );
            const restored = await f.owner("/api/restore", {
              document: backup,
            });
            assert.notEqual(restored.id, f.project.id);
            const restoredJar = new ProjectCookieJar(
              f.root,
              restored.id,
              f.environmentId,
            );
            assert.deepEqual(await restoredJar.inspect(), {
              enabled: false,
              revision: 0,
              cookies: [],
            });
            const count = f.wire.length;
            await f.restart();
            await readback(f, run);
            assert.match(
              await new ProjectCookieJar(
                f.root,
                f.project.id,
                f.environmentId,
              ).header(f.base),
              /seed=private-jar-A/,
            );
            await f.connect(restored.id, false);
            await readback(f, run, restored.id);
            assert.equal(
              f.wire.length,
              count,
              "restore, restart and evidence readback must not replay",
            );
            assert.deepEqual(await restoredJar.inspect(), {
              enabled: false,
              revision: 0,
              cookies: [],
            });
            t.diagnostic(
              "Restore/restart retained execution identity and evidence; local Cookie jar credentials remained project-isolated.",
            );
          }
          t.diagnostic(
            `${kind} ${stage} ${outcome}: persisted ${run.id}, ${run.status}, origin=${stage === "capture" ? 1 : 0} before release; original jar unchanged through healthy same-session reuse.`,
          );
        },
      );
