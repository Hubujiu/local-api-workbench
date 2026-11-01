// Ordinary CI only. Real QuickJS, wire peers, owner/SDK/CLI and Store boundaries.
// Syntax/format checking must not import this module or execute its tests locally.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import {
  importIntoProject,
  normalizeRequest,
  runPlan,
  snapshotPlan,
} from "../src/core.mjs";
import { executeWireFlow } from "../src/wire-plan.mjs";
import { acquireFileLock } from "../src/file-lock.mjs";
import { collectionExecutionScopes } from "../src/postman-collection-scopes.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import {
  assertNativeHTTPPlan,
  assertNativeHTTPResult,
} from "../src/native-mcp-http-shape.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
import { extendedProtocolFixture } from "./fixtures/apipost-extended-protocols.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const secret = "Bearer wire-root-private";
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const row = (key, value) => ({
  key,
  value,
  is_checked: 1,
  field_type: "string",
  schema: { type: "string" },
});
async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(label + " timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t, { collections = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wire-scripts-root-")),
    seen = [],
    httpSeen = [],
    sockets = new Set(),
    clients = [],
    cleanups = [];
  let app;
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0),
      handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      if (input.at(-1) !== 10) return;
      handled = true;
      const body = input.toString().trimEnd();
      seen.push({ type: "tcp", body });
      // End exactly at the delimiter: transport may split TCP bytes into chunks.
      socket.end("tcp:" + body + "\r\n");
    });
  });
  const peer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"),
      chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === "/events") {
      seen.push({ type: "sse", body, headers: req.headers });
      if (req.headers.authorization !== secret) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("id: native-event\ndata: sse:" + body + "\n\n");
      return;
    }
    const value = {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
    httpSeen.push(value);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  peer.on("upgrade", (req, socket, head) => {
    if (
      req.headers["x-fixture"] !== "runtime-custom" ||
      req.headers.cookie !== "fixtureCookie=runtime-cookie"
    ) {
      seen.push({ type: "denied-websocket", headers: req.headers });
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (socket, req) => {
    socket.on("error", () => {});
    socket.once("message", (bytes, binary) => {
      const body = bytes.toString();
      seen.push({ type: "websocket", body, binary, headers: req.headers });
      socket.send("ws:" + body, () => socket.close(1000, "complete"));
    });
  });
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    for (const socket of sockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    for (const server of [app?.server, peer, tcp]) {
      server?.closeAllConnections?.();
      if (server?.listening)
        await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(
    [tcp, peer].map(
      (server) =>
        new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    ),
  );
  const base = `http://127.0.0.1:${peer.address().port}`;
  app = await createApp({ root, port: 0 });
  const owner = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const created = await app.store.create("Native wire script root composition");
  if (collections)
    for (const tag of ["A", "B"])
      await owner(`/api/projects/${created.id}/import`, "POST", {
        postmanVariableMode: "collection",
        document: {
          info: { name: tag, _postman_id: "same-upstream-id" },
          variable: [
            { key: "collectionOnly", value: tag },
            { key: "counter", value: 0, type: "number" },
          ],
          item: [
            {
              name: tag,
              request: { method: "GET", url: { raw: base + "/" + tag } },
            },
          ],
        },
      });
  const project = await app.store.get(created.id),
    source = nativeProtocolFixture({
      ws: base.replace("http:", "ws:") + "/ws",
      tcp: "127.0.0.1:" + tcp.address().port,
      sse: base + "/events",
    });
  const nativeWS = source.apis.find(
      (node) => node.target_type === "websocket2",
    ),
    nativeSSE = source.apis.find((node) => node.target_type === "sse");
  nativeWS.request.header.parameter = [
    row("X-Fixture", "SOURCE-CUSTOM-SECRET"),
  ];
  nativeWS.request.cookie.parameter = [
    row("fixtureCookie", "SOURCE-COOKIE-SECRET"),
  ];
  nativeSSE.request.header.parameter = [row("Accept", "text/event-stream")];
  nativeSSE.request.auth = {
    type: "bearer",
    bearer: { key: "SOURCE-BEARER-SECRET" },
  };
  importIntoProject(project, source);
  project.plans = [];
  project.environments[0].variables = {
    wireCount: 0,
    fromHttp: "seed",
    postToken: "seed",
  };
  project.globalVariables = { globalToken: "seed" };
  for (const definition of project.protocols) {
    definition.templateMode = "variables";
    if (definition.type === "tcp") {
      definition.completion = "delimiter";
      definition.delimiterHex = "0d0a";
    }
    if (definition.type === "sse") {
      definition.method = "POST";
      definition.body = "{{payload}}";
    }
  }
  await app.store.save(project);
  const definitions = Object.fromEntries(
    project.protocols.map((definition) => [definition.type, definition]),
  );
  assert.deepEqual(definitions.websocket.handshake.requiredHeaders, [
    "cookie",
    "x-fixture",
  ]);
  assert.deepEqual(definitions.sse.handshake, {
    headers: { accept: "text/event-stream" },
    requiredHeaders: ["authorization"],
  });
  assert.doesNotMatch(
    JSON.stringify(project),
    /SOURCE-(CUSTOM|COOKIE|BEARER)-SECRET/,
  );
  const credentials = {
    websocket: {
      headers: {
        "X-Fixture": "runtime-custom",
        Cookie: "fixtureCookie=runtime-cookie",
      },
    },
    sse: { headers: { Authorization: secret } },
  };
  return {
    root,
    project,
    base,
    definitions,
    credentials,
    owner,
    seen,
    httpSeen,
    cleanup(callback) {
      cleanups.push(callback);
    },
    get app() {
      return app;
    },
    async sdk(projectId, mode) {
      const client = new Client({ name: "wire-root-" + mode, version: "1" });
      clients.push(client);
      if (mode === "http") {
        const config = await owner("/api/mcp/config", "POST", {
          enabled: true,
          projects: [projectId],
          write: true,
          execute: true,
          remember: false,
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.token },
            },
          }),
        );
      } else {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              path.join(repository, "src/mcp.mjs"),
              "--project",
              projectId,
              "--write",
              "--execute",
            ],
            env: { ...process.env, LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
      }
      return client;
    },
    async restart() {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      app = await createApp({ root, port: 0 });
    },
  };
}

function wireLeaf(f, type, scripts, extra = {}) {
  return {
    id: type,
    type: "protocol",
    protocol: {
      definitionId: f.definitions[type].id,
      ...(type === "sse"
        ? {}
        : { message: "{{payload}}" + (type === "tcp" ? "\n" : "") }),
      duration: 3000,
    },
    protocolScripts: scripts,
    ...extra,
  };
}
const before = [
  "pm.test('no HTTP collection capability',()=>{pm.expect(apt.getVar('collectionOnly')).to.equal(undefined);pm.expect(pm.variables.get('collectionOnly')).to.equal(undefined);pm.expect(typeof pm.collectionVariables?.set).to.equal('undefined');});",
  "pm.test('fresh occurrence local',()=>pm.expect(pm.variables.get('occurrenceLocal')).to.equal(undefined));",
  "pm.environment.set('wireCount',pm.environment.get('wireCount')+1);apt.setVar('phaseCount',(apt.getVar('phaseCount')||0)+1);",
  "const value=pm.environment.get('fromHttp')+'|'+wire.protocol+'|'+pm.environment.get('wireCount');pm.variables.set('payload',value);pm.variables.set('occurrenceLocal',value);apt.setVar('preRuntime','confirmed-'+pm.environment.get('wireCount'));console.log('wire-pre');",
].join("\n");
const after = [
  "pm.test('native-only context',()=>{pm.expect(pm.response).to.equal(undefined);pm.expect(wire.request.headers).to.equal(undefined);pm.expect(wire.request.handshake).to.equal(undefined);pm.expect(apt.getVar('collectionOnly')).to.equal(undefined);pm.expect(pm.variables.get('collectionOnly')).to.equal(undefined);});",
  "const sent=wire.protocol==='sse'?wire.request.body:wire.request.message.trimEnd();pm.test('same occurrence local',()=>pm.expect(sent).to.equal(pm.variables.get('occurrenceLocal')));",
  "const token=wire.protocol==='tcp'?wire.result.result.body.trimEnd():wire.protocol==='websocket'?wire.result.result.messages[0].data:wire.result.result.events[0].data;pm.test('actual native result',()=>pm.expect(wire.result.status).to.equal('completed'));",
  "apt.setVar('runtimeToken',token);pm.environment.set('postToken',token);pm.globals.set('globalToken',token);console.log('wire-post');",
].join("\n");
function nestedPlan(f) {
  const [a, b] = f.project.requests,
    increment =
      "pm.collectionVariables.set('counter',pm.collectionVariables.get('counter')+1);",
    consumer = (request, suffix) => ({
      ...request,
      url:
        f.base +
        "/" +
        suffix +
        "?scope={{collectionOnly}}&counter={{counter}}&env={{postToken}}&global={{globalToken}}&runtime={{runtimeToken}}&extracted={{extractedToken}}&pre={{preRuntime}}&phases={{phaseCount}}",
      beforeScript: increment,
    });
  return {
    name: "Nested A TCP WS SSE B A",
    environmentId: f.project.environments[0].id,
    statusPolicy: "strict200",
    steps: [
      {
        id: "outer",
        type: "repeat",
        count: 2,
        steps: [
          {
            id: "inner",
            type: "repeat",
            count: 1,
            steps: [
              {
                id: "a-start",
                request: {
                  ...a,
                  url:
                    f.base +
                    "/start?scope={{collectionOnly}}&counter={{counter}}",
                  beforeScript:
                    increment +
                    "pm.environment.set('fromHttp','http-'+pm.collectionVariables.get('counter'));",
                },
              },
              ...["tcp", "websocket", "sse"].map((type) =>
                wireLeaf(
                  f,
                  type,
                  { version: 1, before, after },
                  {
                    extract: [
                      {
                        name: "extractedToken",
                        path:
                          type === "tcp"
                            ? "$.body"
                            : type === "websocket"
                              ? "$.messages[0].data"
                              : "$.events[0].data",
                      },
                    ],
                  },
                ),
              ),
              { id: "b-consume", request: consumer(b, "B") },
              { id: "a-consume", request: consumer(a, "A") },
            ],
          },
        ],
      },
    ],
  };
}
async function cli(f, projectId, planId) {
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
      cwd: repository,
      env: { ...process.env, LOCAL_API_DATA: f.root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ protocolCredentials: f.credentials }));
  try {
    assert.equal(await closed, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
  }
}
function checkRun(f, run, ordinal, plan) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(run.snapshot.steps, plan.steps);
  assert.equal(run.results.length, 12);
  assert.equal(
    new Set(run.results.map((item) => item.repeat.occurrenceId)).size,
    12,
  );
  assert.equal(
    run.variables.phaseCount,
    6,
    "runtime accumulates within each run, never from earlier runs",
  );
  assert.equal(run.variables.payload, undefined);
  assert.equal(run.variables.occurrenceLocal, undefined);
  for (let cycle = 0; cycle < 2; cycle++) {
    const rows = run.results.slice(cycle * 6, cycle * 6 + 6),
      counter = ordinal * 4 + cycle * 2 + 1;
    assert.deepEqual(
      rows.map((item) => item.stepId),
      ["a-start", "tcp", "websocket", "sse", "b-consume", "a-consume"],
    );
    for (const item of rows)
      assert.deepEqual(item.repeat.path, [
        { groupId: "outer", iteration: cycle },
        { groupId: "inner", iteration: 0 },
      ]);
    for (const [i, type] of ["tcp", "websocket", "sse"].entries()) {
      const item = rows[i + 1],
        index = ordinal * 6 + cycle * 3 + i,
        payload = `http-${counter}|${type}|${index + 1}`,
        observed = f.seen[index];
      assert.equal(observed.type, type);
      assert.equal(observed.body, payload);
      assert.equal(item.protocolResult.status, "completed");
      assert.equal(item.response, undefined);
      assert.equal(item.protocol.definition.templateMode, "literal");
      assert(item.assertions.some((entry) => entry.phase === "before"));
      assert(item.assertions.some((entry) => entry.phase === "after"));
      if (type === "tcp") {
        assert.equal(
          item.protocolResult.result.base64,
          Buffer.from("tcp:" + payload + "\r\n").toString("base64"),
        );
        assert.deepEqual(item.protocolResult.result.framing, {
          matched: true,
          trailingBase64: "",
          trailingSize: 0,
        });
      } else if (type === "websocket") {
        assert.equal(observed.headers["x-fixture"], "runtime-custom");
        assert.equal(observed.headers.cookie, "fixtureCookie=runtime-cookie");
        assert.equal(item.protocolResult.result.messages[0].encoding, "utf8");
        assert.equal(item.protocolResult.result.closeCode, 1000);
      } else {
        assert.equal(observed.headers.authorization, secret);
        assert.equal(observed.headers.accept, "text/event-stream");
        assert.equal(item.protocolResult.result.status, 200);
      }
    }
    const count = ordinal * 6 + cycle * 3 + 3,
      token = `sse:http-${counter}|sse|${count}`;
    for (const [item, scope, collectionCounter] of [
      [rows[4], "B", ordinal * 2 + cycle + 1],
      [rows[5], "A", counter + 1],
    ])
      assert.deepEqual(JSON.parse(item.response.body).query, {
        scope,
        counter: String(collectionCounter),
        env: token,
        global: token,
        runtime: token,
        extracted: token,
        pre: "confirmed-" + count,
        phases: String(cycle * 3 + 3),
      });
  }
  assert.doesNotMatch(
    JSON.stringify(run),
    /Bearer wire-root-private|runtime-cookie|runtime-custom/,
  );
}

test(
  "nested imported wire scripts preserve collection isolation through owner, official SDKs, CLI and frozen backup restart",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project,
      plan = await f.owner(
        `/api/projects/${p.id}/plans`,
        "POST",
        nestedPlan(f),
      ),
      baseline = await f.app.store.get(p.id);
    // All active native handshake requirements must be resolved before A's HTTP
    // script or request, not when the relevant WS/SSE leaf is eventually reached.
    for (const protocolCredentials of [
      undefined,
      { websocket: f.credentials.websocket },
    ]) {
      const denied = await f.owner(
        `/api/projects/${p.id}/run`,
        "POST",
        {
          planId: plan.id,
          ...(protocolCredentials ? { protocolCredentials } : {}),
        },
        400,
      );
      assert.match(JSON.stringify(denied), /缺少协议运行时Header/);
      assert.deepEqual(f.seen, []);
      assert.deepEqual(f.httpSeen, []);
      assert.deepEqual(
        (await f.app.store.get(p.id)).environments,
        baseline.environments,
      );
      assert.deepEqual(
        (await f.app.store.get(p.id)).postmanCollections,
        baseline.postmanCollections,
      );
    }
    const first = await f.owner(`/api/projects/${p.id}/run`, "POST", {
      planId: plan.id,
      protocolCredentials: f.credentials,
    });
    checkRun(f, first, 0, plan);
    const edited = await f.app.store.get(p.id);
    for (const definition of edited.protocols) {
      definition.url =
        definition.type === "tcp"
          ? "127.0.0.1"
          : definition.type === "websocket"
            ? "ws://127.0.0.1:1/changed"
            : "http://127.0.0.1:1/changed";
      if (definition.type === "tcp") definition.port = 1;
      else definition.handshake.requiredHeaders = ["x-live-only"];
    }
    edited.requests[0].url = "http://127.0.0.1:1/rebound";
    edited.requests[0].postmanCollectionId =
      edited.requests[1].postmanCollectionId;
    await f.app.store.save(edited);
    const httpClient = await f.sdk(p.id, "http"),
      second = decode(
        await httpClient.callTool({
          name: "localapi_execute_flow",
          arguments: {
            projectId: p.id,
            planId: plan.id,
            protocolCredentials: f.credentials,
          },
        }),
      );
    checkRun(f, second, 1, plan);
    assert.equal(second.planHash, first.planHash);
    const detail = decode(
      await httpClient.callTool({
        name: "localapi_get_execution_result",
        arguments: { projectId: p.id, runId: second.id },
      }),
    );
    assert.deepEqual(detail.results, second.results);
    await httpClient.close();
    const removed = await f.app.store.get(p.id);
    removed.protocols = [];
    await f.app.store.save(removed);
    const backup = await f.owner(`/api/projects/${p.id}/export`),
      restored = await f.owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
    assert.deepEqual(restored.plans, backup.plans);
    assert.deepEqual(restored.runs, backup.runs);
    assert.doesNotMatch(
      JSON.stringify(backup),
      /Bearer wire-root-private|runtime-cookie|runtime-custom/,
    );
    await f.restart();
    const recovered = await f.owner(`/api/projects/${restored.id}`);
    assert.deepEqual(recovered.plans, backup.plans);
    assert.deepEqual(recovered.runs, backup.runs);
    assert.equal(
      f.seen.length,
      12,
      "reads, restore and restart never replay wire scripts",
    );
    assert.equal(f.httpSeen.length, 12);
    const stdio = await f.sdk(restored.id, "stdio"),
      third = decode(
        await stdio.callTool({
          name: "localapi_run_plan",
          arguments: {
            projectId: restored.id,
            planId: plan.id,
            protocolCredentials: f.credentials,
          },
        }),
      );
    checkRun(f, third, 2, plan);
    assert.equal(third.planHash, first.planHash);
    await stdio.close();
    const fourth = await cli(f, restored.id, plan.id);
    checkRun(f, fourth, 3, plan);
    assert.equal(fourth.planHash, first.planHash);
    assert.equal(f.seen.length, 24);
    assert.equal(f.httpSeen.length, 24);
    const disk = await new Store(f.root).get(restored.id);
    assert.equal(disk.environments[0].variables.wireCount, 24);
    assert.deepEqual(
      disk.postmanCollections.items.map((item) => item.variables.counter),
      [16, 8],
    );
    assert.equal(disk.runs.at(-1).planHash, first.planHash);
    assert.deepEqual(await f.owner(`/api/projects/${p.id}/export`), backup);
  },
);

test(
  "scripted native WebSocket preserves explicit empty-frame intent",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { collections: false }),
      definition = {
        ...f.definitions.websocket,
        message: "",
        templateMode: "literal",
        sendEmptyMessage: true,
      },
      plan = await f.owner(`/api/projects/${f.project.id}/plans`, "POST", {
        name: "Explicit empty wire message",
        environmentId: f.project.environments[0].id,
        steps: [
          {
            id: "websocket",
            type: "protocol",
            protocol: { definition, message: "", duration: 3000 },
            protocolScripts: {
              version: 1,
              before:
                "pm.test('configured explicit empty',()=>{pm.expect(wire.request.message).to.equal('');pm.expect(wire.request.sendEmptyMessage).to.equal(true);});pm.variables.set('local','empty');",
              after:
                "pm.test('actual empty frame',()=>{pm.expect(wire.request.message).to.equal('');pm.expect(wire.request.sendEmptyMessage).to.equal(true);pm.expect(wire.result.result.messages[0].data).to.equal('ws:');pm.expect(pm.variables.get('local')).to.equal('empty');});",
            },
          },
        ],
      });
    const run = await f.owner(`/api/projects/${f.project.id}/run`, "POST", {
      planId: plan.id,
      protocolCredentials: { websocket: f.credentials.websocket },
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.results[0].protocol.definition.sendEmptyMessage, true);
    assert.equal(run.results[0].protocol.message, "");
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].type, "websocket");
    assert.equal(f.seen[0].body, "");
    assert.equal(f.httpSeen.length, 0);
  },
);

test(
  "nested wire preflight validates disabled descendants but only active scripts require authority",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      frozen = await f.owner(
        `/api/projects/${f.project.id}/plans`,
        "POST",
        nestedPlan(f),
      );
    for (const kind of ["version", "HTTP-marker", "group-marker"]) {
      const bad = structuredClone(frozen),
        group = bad.steps[0];
      group.enabled = false;
      if (kind === "version")
        group.steps[0].steps[1].protocolScripts.version = 2;
      else if (kind === "HTTP-marker")
        group.steps[0].steps[0].protocolScripts = { version: 1 };
      else group.protocolScripts = { version: 1 };
      bad.steps.unshift({
        id: "prior-http",
        request: { url: f.base + "/must-not-run" },
      });
      await assert.rejects(
        runPlan(bad, {}, executeRequest, {
          executeProtocol: executeWireFlow,
          collectionScopes: collectionExecutionScopes(f.project),
        }),
        /协议|protocolScripts|未知/,
      );
    }
    await assert.rejects(
      runPlan(frozen, {}, executeRequest, {
        protocolCredentials: f.credentials,
        collectionScopes: collectionExecutionScopes(f.project),
      }),
      /未授权protocol/,
    );
    assert.deepEqual(f.seen, []);
    assert.deepEqual(f.httpSeen, []);
    const disabled = structuredClone(frozen);
    disabled.steps[0].enabled = false;
    disabled.steps.unshift({
      id: "positive-http",
      request: normalizeRequest({ url: f.base + "/positive" }),
    });
    const run = await runPlan(disabled, {}, executeRequest, {
      collectionScopes: collectionExecutionScopes(f.project),
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(f.httpSeen.length, 1);
    assert.equal(f.seen.length, 0);
  },
);

// Only the acknowledgement timing is controlled: the original Store.save still
// acquires a real file lock, writes or rejects cancellation, and supplies outcome.
function scopeGate(store, projectId, phase, boundary) {
  const original = store.save,
    ready = Promise.withResolvers(),
    release = Promise.withResolvers();
  let attempts = 0,
    signal,
    actualError;
  ready.promise.catch(() => {});
  store.save = async function (candidate, options) {
    if (
      candidate.id !== projectId ||
      options?.activity ||
      attempts ||
      !candidate.environments.some(
        (environment) => environment.variables.scopeGate === phase,
      )
    )
      return original.call(this, candidate, options);
    attempts++;
    signal = options?.signal;
    try {
      if (boundary === "acknowledgement") {
        const value = await original.call(this, candidate, options);
        ready.resolve({ committed: true });
        await bounded(release.promise, "scope acknowledgement release");
        return value;
      }
      const unlock = await acquireFileLock(this.lockFile(projectId));
      let settled = false;
      const pending = original.call(this, candidate, options).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      try {
        await new Promise((resolve) => setImmediate(resolve));
        ready.resolve({ committed: false, settled });
        await bounded(release.promise, "scope lock release");
      } finally {
        await unlock();
      }
      const outcome = await pending;
      if (outcome.error) throw outcome.error;
      return outcome.value;
    } catch (error) {
      actualError = error;
      ready.reject(error);
      throw error;
    }
  };
  return {
    ready: ready.promise,
    release: () => release.resolve(),
    undo: () => {
      store.save = original;
    },
    get attempts() {
      return attempts;
    },
    get signal() {
      return signal;
    },
    get actualError() {
      return actualError;
    },
  };
}
function cancellationPlan(f) {
  const scripted = wireLeaf(
    f,
    "tcp",
    {
      version: 1,
      before:
        "pm.variables.set('payload','before-confirmed');apt.setVar('preRuntime','before-confirmed');pm.environment.set('preEnv','before-confirmed');pm.globals.set('preGlobal','before-confirmed');pm.environment.set('scopeGate','before');",
      after:
        "pm.test('real wire result',()=>pm.expect(wire.result.result.body).to.equal('tcp:before-confirmed\\r\\n'));apt.setVar('postRuntime','after-confirmed');pm.environment.set('postEnv','after-confirmed');pm.globals.set('postGlobal','after-confirmed');pm.environment.set('scopeGate','after');",
    },
    {
      extract: [
        { name: "token", path: "$.body", scope: "environment" },
        { name: "extractedRuntime", path: "$.size" },
      ],
    },
  );
  return {
    name: "Nested wire cancellation",
    environmentId: f.project.environments[0].id,
    steps: [
      {
        id: "outer",
        type: "repeat",
        count: 2,
        steps: [
          {
            id: "inner",
            type: "repeat",
            count: 2,
            steps: [
              scripted,
              { id: "later", request: { url: f.base + "/must-not-run" } },
            ],
          },
        ],
      },
    ],
  };
}
for (const boundary of ["lock", "acknowledgement"])
  test(
    `nested wire scripts distinguish unwritten and confirmed Store ${boundary} cancellation`,
    { timeout: 45000 },
    async (t) => {
      for (const phase of ["before", "after"])
        await t.test(phase, { timeout: 20000 }, async (t) => {
          const f = await fixture(t, { collections: false }),
            p = await f.app.store.get(f.project.id);
          Object.assign(p.environments[0].variables, {
            preEnv: "old-pre",
            postEnv: "old-post",
            token: "old-token",
          });
          p.globalVariables = {
            preGlobal: "old-pre-global",
            postGlobal: "old-post-global",
          };
          await f.app.store.save(p);
          const plan = await f.owner(
              `/api/projects/${p.id}/plans`,
              "POST",
              cancellationPlan(f),
            ),
            baseline = await f.app.store.get(p.id),
            gate = scopeGate(f.app.store, p.id, phase, boundary);
          let pending;
          f.cleanup(async () => {
            gate.release();
            if (pending)
              await bounded(
                pending.catch(() => {}),
                "cancel cleanup",
              ).catch(() => {});
            gate.undo();
          });
          pending = f.owner(`/api/projects/${p.id}/run`, "POST", {
            planId: plan.id,
            runId: "wire-root-cancel",
          });
          pending.catch(() => {});
          const checkpoint = await bounded(gate.ready, "scope gate readiness");
          assert(gate.signal instanceof AbortSignal);
          assert.equal(gate.signal.aborted, false);
          assert.equal(checkpoint.committed, boundary === "acknowledgement");
          if (boundary === "lock") assert.equal(checkpoint.settled, false);
          else {
            const committed = await new Store(f.root).get(p.id);
            assert.equal(committed.environments[0].variables.scopeGate, phase);
            assert.equal(
              committed.configRevision,
              baseline.configRevision + (phase === "before" ? 1 : 2),
            );
          }
          assert.equal(f.seen.length, phase === "before" ? 0 : 1);
          await f.owner("/api/cancel", "POST", { id: "wire-root-cancel" });
          assert.equal(gate.signal.aborted, true);
          gate.release();
          const run = await bounded(pending, "cancelled wire result"),
            preKept = phase === "after" || boundary === "acknowledgement",
            postKept = phase === "after" && boundary === "acknowledgement",
            record = run.results[0];
          assert.equal(run.status, "cancelled", JSON.stringify(run));
          assert.equal(run.recordSaved, true);
          assert.equal(run.results.length, 1);
          assert.equal(gate.attempts, 1);
          if (boundary === "lock")
            assert.equal(gate.actualError?.code, "STORE_SAVE_ABORTED");
          else assert.equal(gate.actualError, undefined);
          assert.equal(record.stepId, "tcp");
          assert.equal(record.type, "protocol");
          assert.equal(record.response, undefined);
          assert.equal(record.status, postKept ? "passed" : "failed");
          assert.equal(record.scopeCommit, undefined);
          assert.equal(Boolean(record.protocolResult), phase === "after");
          const token = "tcp:before-confirmed\r\n";
          if (phase === "after")
            assert.equal(record.protocolResult.result.body, token);
          assert.deepEqual(
            record.extracted,
            postKept
              ? { token, extractedRuntime: Buffer.byteLength(token) }
              : {},
          );
          assert.equal(
            run.variables.preRuntime,
            preKept ? "before-confirmed" : undefined,
          );
          assert.equal(
            run.variables.postRuntime,
            postKept ? "after-confirmed" : undefined,
          );
          assert.equal(
            run.variables.extractedRuntime,
            postKept ? Buffer.byteLength(token) : undefined,
          );
          const saved = await new Store(f.root).get(p.id);
          assert.equal(
            saved.configRevision,
            baseline.configRevision + Number(preKept) + Number(postKept),
          );
          assert.equal(
            saved.environments[0].variables.preEnv,
            preKept ? "before-confirmed" : "old-pre",
          );
          assert.equal(
            saved.environments[0].variables.postEnv,
            postKept ? "after-confirmed" : "old-post",
          );
          assert.equal(
            saved.environments[0].variables.token,
            postKept ? token : "old-token",
          );
          assert.equal(
            saved.globalVariables.preGlobal,
            preKept ? "before-confirmed" : "old-pre-global",
          );
          assert.equal(
            saved.globalVariables.postGlobal,
            postKept ? "after-confirmed" : "old-post-global",
          );
          assert.deepEqual(saved.plans, baseline.plans);
          const durable = saved.runs.find((item) => item.id === run.id);
          assert.deepEqual(durable.results, run.results);
          assert.equal(durable.planHash, run.planHash);
          gate.undo();
          await f.restart();
          assert.deepEqual(
            (await f.owner(`/api/projects/${p.id}`)).runs,
            saved.runs,
          );
          assert.equal(f.seen.length, phase === "before" ? 0 : 1);
          assert.equal(
            f.httpSeen.length,
            0,
            "no later leaf or repeat after cancellation",
          );
        });
    },
  );

test(
  "nested scripted wire typed-unknown Store acknowledgement halts every later leaf without replay",
  { timeout: 30000 },
  async (t) => {
    for (const phase of ["before", "after"])
      await t.test(phase, async (t) => {
        const f = await fixture(t, { collections: false }),
          p = f.project,
          plan = await f.owner(
            `/api/projects/${p.id}/plans`,
            "POST",
            cancellationPlan(f),
          ),
          original = f.app.store.save;
        let attempts = 0;
        f.app.store.save = async function (candidate, options) {
          const result = await original.call(this, candidate, options);
          if (
            candidate.id === p.id &&
            !options?.activity &&
            !attempts &&
            candidate.environments[0].variables.scopeGate === phase
          ) {
            attempts++;
            throw new ProjectCommitUncertain(
              p.id,
              Error("real write acknowledged with injected uncertain outcome"),
            );
          }
          return result;
        };
        f.cleanup(() => {
          f.app.store.save = original;
        });
        const run = await f.owner(`/api/projects/${p.id}/run`, "POST", {
          planId: plan.id,
        });
        assert.equal(run.status, "failed", JSON.stringify(run));
        assert.equal(run.results.length, 1);
        assert.equal(attempts, 1);
        assert.deepEqual(run.results[0].scopeCommit, {
          outcome: "unknown",
          retrySafe: false,
          phase,
        });
        assert.equal(f.seen.length, phase === "before" ? 0 : 1);
        assert.equal(f.httpSeen.length, 0);
        assert.equal(run.variables.postRuntime, undefined);
        assert.equal(
          run.variables.preRuntime,
          phase === "before" ? undefined : "before-confirmed",
        );
        const saved = await new Store(f.root).get(p.id);
        assert.equal(
          saved.environments[0].variables.scopeGate,
          phase,
          "a real persisted write may exist despite unconfirmed publication",
        );
        assert.deepEqual(
          saved.runs.find((item) => item.id === run.id).results,
          run.results,
        );
        f.app.store.save = original;
        await f.restart();
        const reloaded = await f.owner(`/api/projects/${p.id}`);
        assert.deepEqual(reloaded.runs, saved.runs);
        assert.equal(f.seen.length, phase === "before" ? 0 : 1);
        assert.equal(f.httpSeen.length, 0);
      });
  },
);

test("wire script native projection checks exact markers and source-derived equivalence without scanning business JSON or omitted history", () => {
  const request = normalizeRequest({
    id: "http",
    name: "HTTP",
    url: "http://fixture.invalid/",
    bodyType: "raw",
    body: '{"protocolScripts":{"version":1}}',
  });
  assertNativeHTTPPlan({ steps: [{ request }] });
  assertNativeHTTPResult({
    results: [
      { request, response: { body: '{"protocolScripts":{"version":1}}' } },
    ],
  });
  const project = {
    id: "wire-export",
    name: "Wire export",
    requests: [request],
    folders: [],
    environments: [{ id: "env", name: "Default", variables: {} }],
    servers: [],
    settings: {},
    globalVariables: {},
    plans: [],
    protocols: [],
    runs: [],
  };
  const httpPlan = snapshotPlan({
    id: "http-plan",
    name: "HTTP",
    environmentId: "env",
    statusPolicy: "strict200",
    steps: [{ id: "http-step", name: "HTTP", request }],
  });
  project.plans = [httpPlan];
  assert.doesNotThrow(() => exportApipostDirectory(project));
  for (const marker of [
    undefined,
    null,
    {},
    { version: 1, before: "", after: "" },
  ]) {
    const step = { request, protocolScripts: marker };
    assert.throws(() => assertNativeHTTPPlan({ steps: [step] }), /仅支持HTTP/);
    for (const run of [
      { protocolScripts: marker },
      { results: [step] },
      { snapshot: { steps: [step] } },
      { result: { protocolScripts: marker } },
    ])
      assert.throws(() => assertNativeHTTPResult(run), /原版兼容结果/);
    const modified = structuredClone(project);
    modified.plans[0].steps[0].protocolScripts = marker;
    const original = structuredClone(modified);
    assert.throws(
      () => exportApipostDirectory(modified),
      /HTTP|protocolScripts|协议/,
    );
    assert.deepEqual(modified, original);
  }
  // Native project export is a definition interchange, not a result projection.
  // Historical scripts/session evidence is intentionally omitted, not downgraded.
  project.runs = [
    {
      id: "historical",
      snapshot: {
        steps: [
          {
            type: "protocol",
            protocolScripts: { version: 1, before: "old-script", after: "" },
          },
        ],
      },
      results: [
        { protocolResult: { status: "completed", result: { body: "old" } } },
      ],
    },
  ];
  project.protocolRuns = [
    {
      id: "historical-session",
      mode: "session",
      protocolScripts: { version: 1 },
      lifecycle: "closed",
    },
  ];
  for (const exporter of [exportApipost, exportApipostDirectory]) {
    const input = structuredClone(project);
    if (exporter === exportApipost) input.plans = [];
    const original = structuredClone(input);
    const exported = exporter(input);
    assert.doesNotMatch(
      JSON.stringify(exported),
      /old-script|historical-session/,
    );
    assert.deepEqual(input, original);
  }
  const imported = {
    ...structuredClone(project),
    requests: [],
    plans: [],
    runs: [],
    protocolRuns: [],
  };
  importIntoProject(imported, extendedProtocolFixture());
  assert(
    imported.plans.some((plan) =>
      plan.steps.some((step) => step.type === "grpc"),
    ),
  );
  for (const exporter of [exportApipost, exportApipostDirectory]) {
    assert.doesNotThrow(() => exporter(imported));
    for (const scripts of [
      { version: 1, before: "", after: "" },
      { version: 1, before: "apt.setVar('marker',1);", after: "" },
    ]) {
      const modified = structuredClone(imported),
        step = modified.plans
          .flatMap((plan) => plan.steps)
          .find((step) => step.type === "grpc");
      step.protocolScripts = scripts;
      const original = structuredClone(modified);
      assert.throws(
        () => exporter(modified),
        /已编辑派生消息计划|协议.*计划|HTTP/,
      );
      assert.deepEqual(modified, original);
    }
  }
});
