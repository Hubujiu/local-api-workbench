// Cross-feature acceptance for native PostgreSQL/MySQL grants + MCP cancellation.
// The installed pg/mysql2 drivers contact controlled stalled TCP peers, NOT real
// databases. PG starts its startup exchange; MySQL awaits a server greeting.
// Socket closure proves client cleanup, never server-side SQL execution/rollback.
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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";

const main = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
async function waitFor(predicate, message, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  throw Error(message);
}
function decode(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}
async function diskText(folder) {
  let result = "";
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name);
    result += item.isDirectory()
      ? await diskText(file)
      : await readFile(file, "utf8");
  }
  return result;
}
function call(project, name) {
  const flow = /flow$/.test(name),
    native = name.startsWith("apipost_");
  return {
    name,
    arguments: native
      ? {
          project_id: project.id,
          ...(flow
            ? { flow_id: project.plans[0].id }
            : { target_id: project.requests[0].id }),
        }
      : {
          projectId: project.id,
          ...(flow
            ? { planId: project.plans[0].id }
            : { apiId: project.requests[0].id }),
        },
  };
}
const collectionFor = (name) => (/flow$/.test(name) ? "runs" : "history");

async function fixture(t, type) {
  const root = await mkdtemp(path.join(tmpdir(), `mcp-${type}-cancel-`)),
    data = path.join(root, "data"),
    grantsFile = path.join(root, "owner-private.json"),
    clients = [],
    children = [],
    peers = [],
    projects = [];
  const secret = `FICTIONAL_${type.toUpperCase()}_CANCEL_PASSWORD`;
  const httpPaths = [];
  let httpCalls = 0,
    app = await createApp({ root: data, port: 0 });
  const echo = http.createServer((request, response) => {
    httpPaths.push(request.url);
    httpCalls++;
    response.end("{}");
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const { client } of clients) await client.close().catch(() => {});
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await Promise.race([exited.catch(() => {}), delay(1000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await exited.catch(() => {});
    }
    // Only cleanup destroys fixture peers. Assertions observe untouched peers.
    for (const peer of peers)
      for (const socket of peer.sockets) socket.destroy();
    echo.closeAllConnections();
    app.server.closeAllConnections();
    await Promise.all(
      [echo, app.server, ...peers.map((p) => p.server)].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await delay(100); // Allow already-cancelled host promises to settle on RED runs.
    await rm(root, { recursive: true, force: true });
  });
  for (const label of ["a", "b"]) {
    const peer = {
      sockets: new Set(),
      connections: 0,
      closes: 0,
      bytes: 0,
      connectedAt: 0,
      closedAt: 0,
    };
    peer.server = net.createServer((socket) => {
      peer.connections++;
      peer.connectedAt = Date.now();
      peer.sockets.add(socket);
      socket.on("data", (chunk) => {
        peer.bytes += chunk.length;
      });
      socket.on("error", () => {});
      socket.once("close", () => {
        peer.closes++;
        peer.closedAt = Date.now();
        peer.sockets.delete(socket);
      });
    });
    peers.push(peer);
    await new Promise((resolve) => peer.server.listen(0, "127.0.0.1", resolve));
    const project = await app.store.create(`${type} cancellation ${label}`);
    const source = nativeDatabaseFixture(
      `http://127.0.0.1:${echo.address().port}/${label}`,
      type === "postgres" ? "pg" : "mysql",
    );
    source.apis
      .find((node) => node.target_type === "api")
      .request.pre_tasks.at(-1).data +=
      'apt.environment.set("after_database","must-not-persist");';
    importIntoProject(project, source);
    project.environments[0].variables.native_value = "untouched";
    project.plans = [
      snapshotPlan({
        id: "sql-flow",
        name: "SQL then HTTP",
        steps: [
          { request: project.requests[0] },
          {
            request: {
              id: "later",
              name: "must not run",
              method: "GET",
              url: `http://127.0.0.1:${echo.address().port}/later-${label}`,
            },
          },
        ],
      }),
    ];
    await app.store.save(project);
    projects.push(project);
    peer.config = {
      type,
      host: "127.0.0.1",
      port: peer.server.address().port,
      database: "fixture",
      user: "fixture-user",
      password: secret,
    };
  }
  await writeFile(
    grantsFile,
    JSON.stringify({
      version: 1,
      projects: projects.map((project, i) => ({
        projectId: project.id,
        databaseConnections: {
          [project.settings.apipostDatabases[0].id]: peers[i].config,
        },
      })),
    }),
    { mode: 0o600 },
  );
  const track = (client, transport) => {
    let stderr = "";
    const errors = [],
      messages = [];
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    client.onerror = (error) => errors.push(error.message);
    const entry = { client, transport, errors, messages, stderr: () => stderr };
    clients.push(entry);
    return entry;
  };
  const connect = async (transport) => {
    const client = new Client({
        name: `${type}-native-cancellation`,
        version: "1",
      }),
      entry = track(client, transport);
    await client.connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message) => {
      entry.messages.push(message);
      onmessage(message);
    };
    return entry;
  };
  const post = async (route, input) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const httpConnect = async (withGrants = true) => {
    const config = await post("/api/mcp/config", {
      enabled: true,
      projects: projects.map((p) => p.id),
      write: true,
      execute: true,
      remember: false,
    });
    if (withGrants)
      for (const [index, project] of projects.entries())
        await post(`/api/projects/${project.id}/mcp-database-connections`, {
          ...peers[index].config,
          name: "explicit native SQL cancellation",
          bindingId: project.settings.apipostDatabases[0].id,
        });
    return Promise.all(
      projects.map(() =>
        connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          }),
        ),
      ),
    );
  };
  const args = (withGrants) => [
    main,
    ...projects.flatMap((p) => ["--project", p.id]),
    "--write",
    "--execute",
    ...(withGrants ? ["--database-grants-file", grantsFile] : []),
  ];
  const stdio = (withGrants = true) =>
    connect(
      new StdioClientTransport({
        command: process.execPath,
        args: args(withGrants),
        env: { LOCAL_API_DATA: data },
        stderr: "pipe",
      }),
    );
  const raw = () => {
    const child = spawn(process.execPath, args(true), {
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
    projects,
    peers,
    secret,
    grantsFile,
    stdio,
    raw,
    httpConnect,
    calls: () => httpCalls,
    paths: () => [...httpPaths],
    async restartHTTP() {
      for (const { client } of clients) await client.close().catch(() => {});
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root: data, port: 0 });
      return httpConnect(false);
    },
    async cleanEvidence(extra = "") {
      const text = (await diskText(data)) + extra;
      for (const sensitive of [
        secret,
        grantsFile,
        "discard-this-fictional-password",
      ])
        assert(
          !text.includes(sensitive),
          "credential/source path leaked into evidence",
        );
    },
  };
}
async function freshIds(f, project, collection) {
  return new Set(
    (await new Store(f.data).get(project.id))[collection].map(
      (record) => record.id,
    ),
  );
}
async function savedCancellation(f, index, tool, oldIds, stdio = false) {
  const project = f.projects[index],
    collection = collectionFor(tool);
  let saved, record;
  await waitFor(async () => {
    saved = await new Store(f.data).get(project.id);
    record = saved[collection].find(
      (row) => row.status === "cancelled" && !oldIds.has(row.id),
    );
    return !!record;
  }, "fresh cancelled native SQL evidence was not saved");
  const result = collection === "runs" ? record.results[0] : record;
  assert.equal(result.databaseQueries.length, 1);
  assert.equal(result.databaseQueries[0].status, "interrupted");
  if (collection === "runs") assert.equal(record.results.length, 1);
  assert.equal(saved.environments[0].variables.native_value, "untouched");
  assert.equal(saved.environments[0].variables.after_database, undefined);
  assert.equal(f.calls(), 0);
  if (stdio)
    await waitFor(
      async () =>
        (await readMCPActivities(f.data)).some(
          (row) =>
            row.projectId === project.id &&
            row.tool === tool &&
            row.status === "cancelled" &&
            row.recordSaved === true,
        ),
      "stdio activity lacks saved cancellation",
    );
  return record;
}
function begin(client, project, name) {
  const controller = new AbortController();
  const rejected = assert.rejects(
    client.callTool(call(project, name), undefined, {
      signal: controller.signal,
    }),
    /abort|cancel/i,
  );
  // Attach immediately: a failing transport observation must not leave a rejection unhandled.
  rejected.catch(() => {});
  return { controller, rejected };
}
async function connected(peer, previous, type) {
  await waitFor(
    () =>
      peer.connections > previous &&
      peer.sockets.size > 0 &&
      (type !== "postgres" || peer.bytes > 0),
    `${type} driver did not contact its stalled TCP peer`,
  );
}
async function closedPromptly(peer, previousCloses, type) {
  await waitFor(
    () => peer.sockets.size === 0 && peer.closes > previousCloses,
    `${type} cancellation retained the real driver socket beyond 1.5s`,
    1500,
  );
  assert(
    peer.closedAt - peer.connectedAt < 2500,
    "closure must precede the original 3s driver timeout",
  );
}
async function noGrantRestart(f, entry, collection) {
  const p = f.projects[0],
    before = f.peers.map((peer) => peer.connections),
    oldIds = await freshIds(f, p, collection);
  const response = decode(
    await entry.client.callTool(
      call(
        p,
        collection === "runs"
          ? "localapi_execute_flow"
          : "localapi_execute_api",
      ),
    ),
  );
  assert.equal(response.status, "failed");
  assert.equal(response.recordSaved, true);
  const saved = await new Store(f.data).get(p.id);
  assert(
    saved[collection].some(
      (row) => row.status === "failed" && !oldIds.has(row.id),
    ),
  );
  assert.equal(saved.environments[0].variables.native_value, "untouched");
  assert.equal(saved.environments[0].variables.after_database, undefined);
  assert.deepEqual(
    f.peers.map((peer) => peer.connections),
    before,
  );
  // Missing database grants reject the DB-dependent step, not an unrelated
  // later HTTP step. Existing plans deliberately continue after ordinary errors;
  // the cancelled invocation above must still make zero subsequent requests.
  if (collection === "runs") {
    assert.equal(response.results.length, 2);
    assert.equal(response.results[0].status, "failed");
    assert.equal(response.results[0].response, undefined);
    assert.match(response.results[0].error, /数据库|授权/);
    assert.equal(response.results[1].status, "passed");
    assert.deepEqual(f.paths(), ["/later-a"]);
  } else {
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.paths(), []);
  }
  await f.cleanEvidence(entry.stderr() + JSON.stringify(entry.messages));
}

for (const type of ["postgres", "mysql"]) {
  test(
    `${type}: SDK HTTP cancellation closes native driver sockets, isolates projects and survives restart without grants`,
    { timeout: 25000 },
    async (t) => {
      const f = await fixture(t, type),
        [a, b] = await f.httpConnect(),
        p = f.projects[0];
      const firstTool = "localapi_execute_api",
        oldA = await freshIds(f, p, "history"),
        oldB = await freshIds(f, f.projects[1], "history");
      const first = begin(a.client, p, firstTool),
        second = begin(b.client, f.projects[1], firstTool);
      await Promise.all(f.peers.map((peer) => connected(peer, 0, type)));
      const closedA = f.peers[0].closes;
      first.controller.abort();
      await first.rejected;
      await closedPromptly(f.peers[0], closedA, type);
      assert.equal(
        f.peers[1].sockets.size,
        1,
        "other project's pending driver must stay alive",
      );
      assert.deepEqual(await freshIds(f, f.projects[1], "history"), oldB);
      await savedCancellation(f, 0, firstTool, oldA);
      const closedB = f.peers[1].closes;
      second.controller.abort();
      await second.rejected;
      await closedPromptly(f.peers[1], closedB, type);
      await savedCancellation(f, 1, firstTool, oldB);
      for (const tool of [
        "localapi_execute_flow",
        "apipost_execute_api",
        "apipost_execute_flow",
      ]) {
        const peer = f.peers[0],
          before = peer.connections,
          previousCloses = peer.closes,
          old = await freshIds(f, p, collectionFor(tool));
        const pending = begin(a.client, p, tool);
        await connected(peer, before, type);
        pending.controller.abort();
        await pending.rejected;
        await closedPromptly(peer, previousCloses, type);
        await savedCancellation(f, 0, tool, old);
        await a.client.ping();
      }
      await delay(150);
      assert.equal(f.calls(), 0);
      assert(
        ![...a.errors, ...b.errors].some((message) =>
          /unknown.*id/i.test(message),
        ),
      );
      await f.cleanEvidence(JSON.stringify([...a.messages, ...b.messages]));
      const [restarted] = await f.restartHTTP();
      await noGrantRestart(f, restarted, "history");
    },
  );

  test(
    `${type}: actual SDK stdio child cancels a native API and does not inherit grants on restart`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, type),
        entry = await f.stdio(),
        p = f.projects[0],
        peer = f.peers[0],
        old = await freshIds(f, p, "history");
      const pending = begin(entry.client, p, "localapi_execute_api");
      await connected(peer, 0, type);
      const previousCloses = peer.closes,
        connections = peer.connections;
      pending.controller.abort();
      await pending.rejected;
      await closedPromptly(peer, previousCloses, type);
      await savedCancellation(f, 0, "localapi_execute_api", old, true);
      await entry.client.ping();
      await delay(150);
      assert.equal(peer.connections, connections);
      assert.equal(f.peers[1].connections, 0);
      assert(!entry.errors.some((message) => /unknown.*id/i.test(message)));
      await f.cleanEvidence(entry.stderr() + JSON.stringify(entry.messages));
      await entry.client.close();
      const restarted = await f.stdio(false);
      await noGrantRestart(f, restarted, "history");
    },
  );

  test(
    `${type}: stdio EOF closes native driver socket and saves cancelled flow before process exit`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, type),
        process = f.raw(),
        p = f.projects[0],
        peer = f.peers[0],
        old = await freshIds(f, p, "runs");
      process.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {},
        }) + "\n",
      );
      await waitFor(
        () => process.stdout().includes("\n"),
        "stdio initialization missing",
      );
      process.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: call(p, "localapi_execute_flow"),
        }) + "\n",
      );
      await connected(peer, 0, type);
      const previousCloses = peer.closes;
      process.child.stdin.end();
      await closedPromptly(peer, previousCloses, type);
      const exit = await process.exited;
      assert.deepEqual(exit, { code: 0, signal: null }, process.stderr());
      const responses = process
        .stdout()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((message) => message.id === 1);
      assert.equal(responses.length, 1);
      const output = decode(responses[0].result);
      assert.equal(output.status, "cancelled");
      assert.equal(output.recordSaved, true);
      const record = await savedCancellation(
        f,
        0,
        "localapi_execute_flow",
        old,
        true,
      );
      assert.equal(record.id, output.id);
      assert.equal(f.peers[1].connections, 0);
      await f.cleanEvidence(process.stdout() + process.stderr());
      const restarted = await f.stdio(false);
      await noGrantRestart(f, restarted, "runs");
    },
  );
}
