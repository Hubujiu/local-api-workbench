// Cross-feature acceptance: owner-file grants + native Mongo + bounded stdio
// cancellation. The real Mongo driver contacts a local stalled TCP peer, NOT a
// functioning mongod; these checks prove worker/socket cleanup, not DB rollback.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
import { nativeMongoFixture } from "./fixtures/apipost-mongodb.mjs";

const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
  secret = "FICTIONAL_STDIO_MONGO_CANCEL_PASSWORD";
async function waitFor(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error(message);
}
const decode = (response) => {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
async function diskText(folder) {
  let text = "";
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    text += entry.isDirectory()
      ? await diskText(file)
      : await readFile(file, "utf8");
  }
  return text;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "stdio-native-mongo-cancel-")),
    data = path.join(root, "data"),
    grantsFile = path.join(root, "owner-private.json"),
    sockets = new Set(),
    clients = [],
    children = [];
  let handshakes = 0,
    connections = 0,
    closedSockets = 0,
    httpCalls = 0;
  const stall = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => handshakes++);
    socket.once("close", () => {
      sockets.delete(socket);
      closedSockets++;
    });
  });
  const echo = http.createServer((_request, response) => {
    httpCalls++;
    response.end("{}");
  });
  await new Promise((resolve) => stall.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await Promise.race([exited.catch(() => {}), delay(1500)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await exited.catch(() => {});
    }
    for (const socket of sockets) socket.destroy();
    echo.closeAllConnections();
    await Promise.all(
      [stall, echo].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(data),
    project = await store.create("native Mongo stdio cancellation"),
    source = nativeMongoFixture(
      "http://127.0.0.1:" + echo.address().port + "/request",
    ),
    sourceAPI = source.apis.find((node) => node.target_type === "api");
  sourceAPI.request.pre_tasks.at(-1).data +=
    'apt.environment.set("after_database","must-not-persist");';
  importIntoProject(project, source);
  project.environments[0].variables.native_value = "untouched";
  project.plans = [
    snapshotPlan({
      id: "mongo-flow",
      name: "Mongo then HTTP",
      steps: [
        { request: project.requests[0] },
        {
          request: {
            ...structuredClone(project.requests[0]),
            name: "must not run after cancellation",
            url: "http://127.0.0.1:" + echo.address().port + "/later",
          },
        },
      ],
    }),
  ];
  await store.save(project);
  await writeFile(
    grantsFile,
    JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: project.id,
          databaseConnections: {
            [project.settings.apipostDatabases[0].id]: {
              type: "mongodb",
              host: "127.0.0.1",
              port: stall.address().port,
              database: "fixture",
              user: "fictional-user",
              password: secret,
              authSource: "fixture-auth",
            },
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const args = (withGrants = true) => [
    main,
    "--project",
    project.id,
    "--write",
    "--execute",
    ...(withGrants ? ["--database-grants-file", grantsFile] : []),
  ];
  const connect = async (withGrants = true) => {
    const client = new Client({
        name: "native-mongo-stdio-cancel",
        version: "1",
      }),
      errors = [],
      wire = [],
      transport = new StdioClientTransport({
        command: process.execPath,
        args: args(withGrants),
        env: { LOCAL_API_DATA: data },
        stderr: "pipe",
      });
    let stderr = "";
    transport.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    client.onerror = (error) => errors.push(error.message);
    clients.push(client);
    await client.connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message) => {
      wire.push(message);
      onmessage(message);
    };
    return { client, errors, wire, stderr: () => stderr };
  };
  const raw = () => {
    const child = spawn(process.execPath, args(), {
      env: {
        LOCAL_API_DATA: data,
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    children.push({ child, exited });
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  return {
    data,
    grantsFile,
    project,
    connect,
    raw,
    observed: () => ({
      handshakes,
      connections,
      closedSockets,
      sockets: sockets.size,
      httpCalls,
    }),
  };
}
async function assertSavedCancellation(f, collection, previousIds, tool) {
  let saved, record;
  await waitFor(async () => {
    saved = await new Store(f.data).get(f.project.id);
    record = saved[collection].find(
      (item) => !previousIds.has(item.id) && item.status === "cancelled",
    );
    return !!record;
  }, "new cancelled native Mongo execution was not saved");
  const result = collection === "runs" ? record.results[0] : record;
  assert.equal(result.databaseQueries.length, 1);
  assert.equal(result.databaseQueries[0].status, "interrupted");
  if (collection === "runs") assert.equal(record.results.length, 1);
  assert.equal(saved.environments[0].variables.native_value, "untouched");
  assert.equal(saved.environments[0].variables.after_database, undefined);
  assert.equal(f.observed().httpCalls, 0);
  await waitFor(
    async () =>
      (await readMCPActivities(f.data)).some(
        (row) =>
          row.projectId === f.project.id &&
          row.tool === tool &&
          row.status === "cancelled" &&
          row.recordSaved === true,
      ),
    "stdio activity did not confirm saved cancelled execution",
  );
  return record;
}
async function assertNoFileRestart(f, collection) {
  const before = f.observed(),
    saved = await new Store(f.data).get(f.project.id),
    oldIDs = new Set(saved[collection].map((record) => record.id)),
    restarted = await f.connect(false),
    response = decode(
      await restarted.client.callTool({
        name:
          collection === "history"
            ? "localapi_execute_api"
            : "localapi_execute_flow",
        arguments:
          collection === "history"
            ? { projectId: f.project.id, apiId: f.project.requests[0].id }
            : { projectId: f.project.id, planId: f.project.plans[0].id },
      }),
    );
  assert.equal(response.status, "failed");
  assert.equal(response.recordSaved, true);
  const after = await new Store(f.data).get(f.project.id);
  assert(
    after[collection].some(
      (record) => record.status === "failed" && !oldIDs.has(record.id),
    ),
  );
  assert.equal(after.environments[0].variables.native_value, "untouched");
  assert.equal(after.environments[0].variables.after_database, undefined);
  assert.equal(f.observed().handshakes, before.handshakes);
  assert.equal(f.observed().connections, before.connections);
  assert.equal(f.observed().sockets, 0);
  assert.equal(f.observed().httpCalls, 0);
  assert.equal(restarted.stderr().includes(secret), false);
  await restarted.client.close();
}

test(
  "official SDK stdio owner grant cancels a native Mongo API, closes its real driver socket and saves fresh history",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      connection = await f.connect(),
      oldIDs = new Set(
        (await new Store(f.data).get(f.project.id)).history.map(
          (record) => record.id,
        ),
      ),
      controller = new AbortController();
    const rejected = assert.rejects(
      connection.client.callTool(
        {
          name: "localapi_execute_api",
          arguments: {
            projectId: f.project.id,
            apiId: f.project.requests[0].id,
          },
        },
        undefined,
        { signal: controller.signal },
      ),
      /abort|cancel/i,
    );
    await waitFor(
      () => f.observed().handshakes > 0,
      "real Mongo driver did not send a TCP handshake",
    );
    assert(f.observed().sockets > 0);
    const before = f.observed();
    controller.abort();
    // Earlier than the driver's 2s socket/connection timeout: local SDK rejection
    // alone is not evidence that the actual worker connection was cancelled.
    await waitFor(
      () =>
        f.observed().sockets === 0 &&
        f.observed().closedSockets > before.closedSockets,
      "cancelled Mongo worker retained its real socket",
      1800,
    );
    await rejected;
    await assertSavedCancellation(f, "history", oldIDs, "localapi_execute_api");
    await connection.client.ping();
    await delay(200);
    assert.equal(f.observed().connections, before.connections);
    assert.equal(f.observed().httpCalls, 0);
    assert(
      !connection.errors.some((message) => /unknown.*id/i.test(message)),
      connection.errors.join("\n"),
    );
    assert.equal(JSON.stringify(connection.wire).includes(secret), false);
    assert.equal(connection.stderr().includes(secret), false);
    assert.equal((await diskText(f.data)).includes(secret), false);
    await connection.client.close();
    await assertNoFileRestart(f, "history");
  },
);

test(
  "raw stdio EOF with owner grant terminates the native Mongo worker and persists a cancelled plan before exit",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { child, exited, stdout, stderr } = f.raw(),
      oldIDs = new Set(
        (await new Store(f.data).get(f.project.id)).runs.map(
          (record) => record.id,
        ),
      );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {},
      }) + "\n",
    );
    await waitFor(
      () => stdout().includes("\n"),
      "raw stdio initialization did not complete",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "localapi_execute_flow",
          arguments: { projectId: f.project.id, planId: f.project.plans[0].id },
        },
      }) + "\n",
    );
    await waitFor(
      () => f.observed().handshakes > 0,
      "real Mongo driver did not send a TCP handshake",
    );
    assert(f.observed().sockets > 0);
    const before = f.observed();
    child.stdin.end();
    await waitFor(
      () =>
        f.observed().sockets === 0 &&
        f.observed().closedSockets > before.closedSockets,
      "EOF did not close the real Mongo worker socket",
      1800,
    );
    const exit = await exited;
    assert.equal(exit.code, 0, stderr());
    assert.equal(exit.signal, null);
    const messages = stdout()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      replies = messages.filter((message) => message.id === 1);
    assert.equal(replies.length, 1);
    const output = decode(replies[0].result);
    assert.equal(output.status, "cancelled");
    assert.equal(output.recordSaved, true);
    const record = await assertSavedCancellation(
      f,
      "runs",
      oldIDs,
      "localapi_execute_flow",
    );
    assert.equal(output.id, record.id);
    assert.equal(f.observed().connections, before.connections);
    assert.equal(stdout().includes(secret), false);
    assert.equal(stderr().includes(secret), false);
    assert.equal((await diskText(f.data)).includes(secret), false);
    await assertNoFileRestart(f, "runs");
  },
);
