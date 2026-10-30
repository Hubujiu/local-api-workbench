// Integrated-root acceptance: invocation/read grants are not native write authority.
// Actual subprocesses and TCP peers execute only in ordinary CI, never locally.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { parseRESP } from "../src/redis.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const binding = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-root-read-grants-"));
  const calls = [],
    commands = [],
    sockets = new Set(),
    closes = [],
    cleanup = [];
  let connections = 0;
  const echo = http.createServer((req, res) => {
    calls.push({ url: req.url, value: req.headers["x-read-value"] });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  const redis = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    closes.push(
      new Promise((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      let frame;
      try {
        while ((frame = parseRESP(input))) {
          input = input.subarray(frame.bytes);
          const command = frame.value.map((v) => v.toString());
          commands.push(command);
          socket.write(
            command[0] === "GET"
              ? "$14\r\nreadonly-value\r\n"
              : "-ERR no mutations in readonly fixture\r\n",
          );
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await Promise.all([
    new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => redis.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    echo.closeAllConnections();
    const stopped = new Promise((resolve) => redis.close(resolve));
    for (const socket of sockets) socket.destroy();
    await Promise.all(closes);
    await stopped;
    await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(path.join(root, "data")),
    p = await store.create("Root native write denial");
  const url = `http://127.0.0.1:${echo.address().port}`;
  const task = (write) => ({
    id: write ? "write-task" : "read-task",
    type: "database",
    enabled: 1,
    data: {
      connectionId: binding,
      query: JSON.stringify(
        write ? ["SET", "fixture:key", "value"] : ["GET", "fixture:key"],
      ),
      resultShape: "redis-value",
      ...(write ? { writeIntent: "redis-set" } : {}),
      isConsoleOutput: -1,
      variables: write
        ? []
        : [{ name: "read_value", type: "environment", pattern: "$" }],
    },
  });
  const first = {
    id: "first",
    url: url + "/first-must-not-run",
    beforeScript: `pm.environment.set("rootSentinel","ran");pm.sendRequest("${url}/script-must-not-run",()=>{});`,
  };
  const write = {
    id: "write",
    name: "Write request",
    url: url + "/write-must-not-run",
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [
        {
          id: "script",
          type: "customScript",
          enabled: 1,
          data: `pm.environment.set("nativeSentinel","ran");pm.sendRequest("${url}/native-script-must-not-run",()=>{});`,
        },
        task(true),
      ],
      after: [],
    },
  };
  const read = {
    id: "read",
    name: "Read request",
    url: url + "/read-allowed",
    headers: [{ key: "x-read-value", value: "{{read_value}}", enabled: true }],
    inheritSharedScripts: false,
    nativeTasks: { version: 1, before: [task(false)], after: [] },
  };
  p.settings.apipostDatabases = [
    { id: binding, name: "Read-only grant source", type: "redis" },
  ];
  p.requests = [first, write, read];
  p.plans = [
    snapshotPlan({
      id: "nested-write",
      steps: [
        {
          type: "repeat",
          id: "outer",
          count: 2,
          steps: [
            { id: "first-leaf", request: first },
            {
              type: "repeat",
              id: "inner",
              count: 2,
              steps: [{ id: "write-leaf", request: write }],
            },
          ],
        },
      ],
    }),
    snapshotPlan({
      id: "flat-write",
      steps: [{ request: first }, { request: write }],
    }),
    snapshotPlan({ id: "readonly", steps: [{ request: read }] }),
  ];
  await store.save(p);
  const config = {
    type: "redis",
    host: "127.0.0.1",
    port: redis.address().port,
    database: "0",
    ssl: false,
  };
  const grants = { [binding]: config };
  const before = await store.get(p.id);
  const noEffects = async () => {
    assert.deepEqual(calls, []);
    assert.deepEqual(commands, []);
    assert.equal(connections, 0);
    const current = await store.get(p.id);
    assert.deepEqual(current.history, before.history);
    assert.deepEqual(current.runs, before.runs);
    assert.deepEqual(current.environments, before.environments);
    assert.deepEqual(current.globalVariables, before.globalVariables);
  };
  return {
    root,
    data: store.root,
    store,
    p,
    grants,
    calls,
    commands,
    noEffects,
    cleanup,
  };
}
function invokeCLI(f, plan) {
  const child = spawn(
    process.execPath,
    [
      "scripts/run-plan.mjs",
      "--project",
      f.p.id,
      "--plan",
      plan,
      "--database-stdin",
    ],
    {
      cwd,
      env: { ...process.env, LOCAL_API_DATA: f.data },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  f.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ databaseConnections: f.grants }));
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      expired = false;
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    const timer = setTimeout(() => {
      expired = true;
      child.kill();
    }, 15000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (expired) reject(Error("Root CLI acceptance child timeout"));
      else resolve({ code, stdout, stderr });
    });
  });
}
const decoded = (reply) => {
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return JSON.parse(reply.content[0].text);
};
function denied(reply) {
  assert.equal(reply.isError, true, JSON.stringify(reply));
  assert.match(
    reply.content.map((c) => c.text || "").join("\n"),
    /原生 Redis 写入|单次授权/,
  );
}

test(
  "root CLI explicit database stdin read grant rejects nested later SET before all effects and still permits readonly",
  { timeout: 35000 },
  async (t) => {
    const f = await fixture(t);
    const rejected = await invokeCLI(f, "nested-write");
    assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /原生 Redis 写入|单次授权/);
    await f.noEffects();
    const accepted = await invokeCLI(f, "readonly");
    assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
    assert.equal(JSON.parse(accepted.stdout).status, "passed");
    assert.deepEqual(f.commands, [["GET", "fixture:key"]]);
    assert.deepEqual(f.calls, [
      { url: "/read-allowed", value: "readonly-value" },
    ]);
    const saved = await f.store.get(f.p.id);
    assert.equal(saved.environments[0].variables.read_value, "readonly-value");
    assert.equal(saved.runs.length, 1);
    assert.equal(
      JSON.stringify(saved).includes('"databaseConnections"'),
      false,
    );
  },
);

test(
  "root official stdio startup read grant cannot authorize canonical nested SET or native aliases; readonly alias remains valid",
  { timeout: 35000 },
  async (t) => {
    const f = await fixture(t);
    const filename = path.join(f.root, "private-grants.json");
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        projects: [{ projectId: f.p.id, databaseConnections: f.grants }],
      }),
      { mode: 0o600 },
    );
    const client = new Client({
      name: "root-native-write-denial",
      version: "1",
    });
    f.cleanup.push(() => client.close().catch(() => {}));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(cwd, "src/mcp.mjs"),
          "--project",
          f.p.id,
          "--write",
          "--execute",
          "--database-grants-file",
          filename,
        ],
        env: { LOCAL_API_DATA: f.data },
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "localapi_run_plan",
      "apipost_execute_api",
      "apipost_execute_flow",
    ])
      assert.ok(tools.includes(name), name);
    for (const call of [
      {
        name: "localapi_run_plan",
        arguments: { projectId: f.p.id, planId: "nested-write" },
      },
      {
        name: "apipost_execute_api",
        arguments: { project_id: f.p.id, target_id: "write" },
      },
      {
        name: "apipost_execute_flow",
        arguments: { project_id: f.p.id, flow_id: "flat-write" },
      },
    ]) {
      denied(await client.callTool(call));
      await f.noEffects();
    }
    const accepted = decoded(
      await client.callTool({
        name: "apipost_execute_api",
        arguments: { project_id: f.p.id, target_id: "read" },
      }),
    );
    assert.equal(accepted.status, "passed");
    assert.deepEqual(f.commands, [["GET", "fixture:key"]]);
    assert.deepEqual(f.calls, [
      { url: "/read-allowed", value: "readonly-value" },
    ]);
    const saved = await f.store.get(f.p.id);
    assert.equal(saved.environments[0].variables.read_value, "readonly-value");
    assert.equal(saved.history.length, 1);
    assert.equal(saved.runs.length, 0);
    assert.equal(
      JSON.stringify(saved).includes('"databaseConnections"'),
      false,
    );
    await client.close();
  },
);
