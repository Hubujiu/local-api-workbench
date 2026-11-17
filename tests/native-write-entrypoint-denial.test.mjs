// Actual process/SDK entrypoints: these tests run only in ordinary CI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";

const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-write-entrypoints-"));
  const requests = [],
    cleanups = [];
  let connections = 0;
  const httpServer = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  const dbServer = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await Promise.all([
    new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => dbServer.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    httpServer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => httpServer.close(resolve)),
      new Promise((resolve) => dbServer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const store = new Store(root);
  const project = await store.create("Native write denied entrypoints");
  const first = {
    id: "first",
    name: "First must not execute",
    url: url + "/first-http",
    method: "GET",
    beforeScript: `pm.environment.set("entrypointSentinel","ran");pm.sendRequest("${url}/script-probe",()=>{});`,
  };
  const write = {
    id: "write",
    name: "Later SET",
    url: url + "/after-write",
    method: "GET",
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [
        {
          id: "native-script",
          type: "customScript",
          enabled: 1,
          data: `pm.environment.set("nativeSentinel","ran");pm.sendRequest("${url}/native-script-probe",()=>{});`,
        },
        {
          id: "set",
          type: "database",
          enabled: 1,
          data: {
            connectionId:
              "apipost-aaaaaaaaaaaaaaaaaaaa-db-bbbbbbbbbbbbbbbbbbbb",
            query: '["SET","entrypoint:key","value"]',
            resultShape: "redis-value",
            writeIntent: "redis-set",
            isConsoleOutput: -1,
            variables: [],
          },
        },
      ],
      after: [],
    },
  };
  project.settings.apipostDatabases = [
    {
      id: "apipost-aaaaaaaaaaaaaaaaaaaa-db-bbbbbbbbbbbbbbbbbbbb",
      name: "Explicit fixture identity",
      type: "redis",
      sourceProjectId: "original",
      sourceId: "db",
    },
  ];
  project.requests = [first, write];
  project.plans = [
    snapshotPlan({
      id: "later-set",
      name: "Whole-plan preflight",
      steps: [{ request: first }, { request: write }],
    }),
  ];
  await store.save(project);
  const before = await store.get(project.id);
  const unchanged = async () => {
    assert.deepEqual(
      requests,
      [],
      "neither earlier HTTP nor script callback may run",
    );
    assert.equal(connections, 0, "no database socket may be opened");
    const after = await store.get(project.id);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.globalVariables, before.globalVariables);
    assert.deepEqual(after.environments, before.environments);
  };
  return {
    root,
    store,
    project,
    unchanged,
    onCleanup: (cleanup) => cleanups.push(cleanup),
  };
}
function runCLI(fixture, args) {
  const { root } = fixture;
  const child = spawn(process.execPath, ["scripts/run-plan.mjs", ...args], {
    cwd: rootDirectory,
    env: { ...process.env, LOCAL_API_DATA: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  fixture.onCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      expired = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      expired = true;
      child.kill();
    }, 15000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (expired)
        reject(Error("CLI child failed to stop within fixture deadline"));
      else resolve({ code, stdout, stderr });
    });
  });
}
function denied(reply) {
  assert.equal(reply.isError, true, JSON.stringify(reply));
  assert.match(
    reply.content?.map((item) => item.text || "").join("\n") || "",
    /原生 Redis 写入|单次授权/,
  );
}

test(
  "actual CLI rejects later SET before first script/HTTP and before history",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const result = await runCLI(f, [
      "--project",
      f.project.id,
      "--plan",
      "later-set",
    ]);
    assert.equal(result.code, 2, result.stderr + result.stdout);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /原生 Redis 写入|单次授权/);
    await f.unchanged();
  },
);

test(
  "official SDK stdio write+execute grants never authorize native SET in localapi_run_plan or localapi_execute_api",
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    const client = new Client({ name: "native-set-denial", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(rootDirectory, "src/mcp.mjs"),
        "--project",
        f.project.id,
        "--write",
        "--execute",
      ],
      env: { LOCAL_API_DATA: f.root },
      stderr: "pipe",
    });
    f.onCleanup(() => client.close().catch(() => {}));
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "localapi_run_plan"));
    assert.ok(tools.tools.some((tool) => tool.name === "localapi_execute_api"));
    denied(
      await client.callTool({
        name: "localapi_run_plan",
        arguments: { projectId: f.project.id, planId: "later-set" },
      }),
    );
    await f.unchanged();
    denied(
      await client.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: f.project.id, apiId: "write" },
      }),
    );
    await f.unchanged();
    await client.close();
  },
);
