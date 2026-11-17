import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "socket.io";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";

test("until occurrences retain hidden peer auth diagnostics across owner, MCP, CLI and reopened storage", async (t) => {
  const secret = "synthetic-nested-auth-entrypoint-78523";
  const variants = [
    secret,
    Buffer.from(secret).toString("base64"),
    [...secret].reverse().join(""),
  ];
  const clean = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const marker of variants) assert.ok(!text.includes(marker));
  };
  const server = http.createServer(),
    io = new Server(server);
  let seen = 0;
  io.use((socket, next) => {
    assert.equal(socket.handshake.auth.nested.secret, secret);
    seen++;
    const error = Error(variants.join(" | "));
    error.data = { message: secret, description: { message: secret } };
    next(error);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(
    path.join(tmpdir(), "socketio-diagnostic-entrypoints-"),
  );
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => io.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("diagnostics");
  const definition = {
    id: "socket",
    url: `http://127.0.0.1:${server.address().port}`,
  };
  const credentials = { auth: { nested: { secret } } };
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const base = `${app.url}/api/projects/${project.id}/`;
  const request = async (action, body) => {
    const response = await fetch(base + action, {
      headers,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    clean(result);
    return result;
  };
  await request("socketio-definitions", definition);
  const session = await request("socketio-sessions", {
    definitionId: "socket",
    ...credentials,
  });
  let state;
  for (let n = 0; n < 200; n++) {
    state = await request(`socketio-sessions/${session.id}`);
    if (state.state === "error") break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(state.state, "error");
  assert.match(state.error, /对端诊断已隐藏/);
  await request("socketio-sessions");
  await request(`socketio-sessions/${session.id}/stop`, {});
  const history = await request("socketio-runs");
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "failed");
  const mcp = createMCP({
    store: app.store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  const call = async (name, args) => {
    const reply = await mcp({
      id: 1,
      method: "tools/call",
      params: {
        name: "localapi_" + name,
        arguments: { projectId: project.id, ...args },
      },
    });
    clean(reply);
    assert.notEqual(reply.result.isError, true);
    return JSON.parse(reply.result.content[0].text);
  };
  const plan = await call("save_plan", {
    plan: {
      steps: [
        {
          id: "until-group",
          type: "repeat",
          count: 2,
          untilCondition: {
            left: { literal: false },
            op: "eq",
            right: { literal: true },
          },
          steps: [
            {
              id: "socket-step",
              type: "socketio",
              socketio: {
                definitionId: "socket",
                timeoutMs: 2000,
                commands: [],
              },
            },
          ],
        },
      ],
    },
  });
  const socketioCredentials = { "socket-step": credentials };
  const ownerResult = await request("run", {
    planId: plan.id,
    socketioCredentials,
  });
  assert.equal(ownerResult.status, "failed");
  assert.equal(ownerResult.results.length, 2);
  assert.deepEqual(
    ownerResult.conditionResults.map((r) => r.matched),
    [false, false],
  );
  assert.equal(
    new Set(ownerResult.results.map((r) => r.socketioResult.sessionId)).size,
    2,
  );
  assert.ok(
    ownerResult.results.every(
      (r) =>
        r.socketioResult.status === "failed" &&
        r.socketioResult.results.length === 0,
    ),
  );
  assert.match(ownerResult.results[0].socketioResult.error, /对端诊断已隐藏/);
  const result = await call("execute_flow", {
    planId: plan.id,
    socketioCredentials,
  });
  assert.equal(result.status, "failed");
  assert.match(result.results[0].socketioResult.error, /对端诊断已隐藏/);
  const artifact = path.join(root, "cli-result.json");
  const cli = spawn(
    process.execPath,
    [
      "scripts/run-plan.mjs",
      "--project",
      project.id,
      "--plan",
      plan.id,
      "--credentials-stdin",
      "--output",
      artifact,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  cli.stdout.on("data", (chunk) => (stdout += chunk));
  cli.stderr.on("data", (chunk) => (stderr += chunk));
  cli.stdin.end(JSON.stringify({ socketioCredentials }));
  const code = await new Promise((resolve, reject) => {
    cli.on("error", reject);
    cli.on("close", resolve);
  });
  assert.equal(code, 1, stderr);
  clean(stdout);
  clean(stderr);
  clean(await readFile(artifact, "utf8"));
  assert.equal(JSON.parse(stdout).status, "failed");
  const reopened = await new Store(root).get(project.id);
  clean(reopened);
  // Inspect all persisted artifacts, not just deserialized project fields.
  async function checkFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await checkFiles(file);
      else if (entry.isFile()) clean(await readFile(file, "utf8"));
    }
  }
  await checkFiles(root);
  assert.equal(reopened.runs.length, 3);
  assert.equal(seen, 7);
});
