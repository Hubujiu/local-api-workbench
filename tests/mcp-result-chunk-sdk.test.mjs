import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

const toolName = "localapi_get_execution_result_chunk";
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const client = () =>
  new Client(
    { name: "workbench-result-chunk-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
const call = (c, name, args) => c.callTool({ name, arguments: args });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const chunk = async (c, projectId, runId, args = {}) =>
  decode(
    await call(c, toolName, { projectId, runId, offsetBytes: 0, ...args }),
  );
async function rejectChunk(c, projectId, runId, args = {}) {
  const result = await call(c, toolName, {
    projectId,
    runId,
    offsetBytes: 0,
    ...args,
  });
  assert.equal(result.isError, true);
  assert.equal(typeof result.content[0].text, "string");
  assert(result.content[0].text.length < 160);
  assert.doesNotMatch(
    result.content[0].text,
    /PRIVATE-ARGUMENT|fixture-secret/,
  );
  await c.ping();
  return result.content[0].text;
}
async function persistedBytes(root, projectId, kind, runId) {
  // Independent of the new serializer and the MCP execution receipt/wrapper.
  const records = JSON.parse(
    await readFile(
      path.join(
        root,
        projectId,
        "history",
        kind === "api" ? "requests.json" : "runs.json",
      ),
      "utf8",
    ),
  );
  const matches = records.filter((record) => record.id === runId);
  assert.equal(matches.length, 1);
  return Buffer.from(JSON.stringify(matches[0]), "utf8");
}
async function reconstruct(c, projectId, runId, expected, maxBytes) {
  const chunks = [];
  let offsetBytes = 0;
  const expectedSha256 = hash(expected);
  do {
    const result = await chunk(c, projectId, runId, {
      offsetBytes,
      ...(offsetBytes ? { expectedSha256 } : {}),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "version",
        "projectId",
        "runId",
        "encoding",
        "mediaType",
        "sha256",
        "offsetBytes",
        "chunkBytes",
        "totalBytes",
        "nextOffsetBytes",
        "eof",
        "data",
      ].sort(),
    );
    assert.equal(result.version, 1);
    assert.equal(result.projectId, projectId);
    assert.equal(result.runId, runId);
    assert.equal(result.encoding, "base64");
    assert.equal(result.mediaType, "application/json");
    assert.equal(result.sha256, expectedSha256);
    assert.equal(result.totalBytes, expected.length);
    assert.equal(result.offsetBytes, offsetBytes);
    const bytes = Buffer.from(result.data, "base64");
    assert.equal(bytes.toString("base64"), result.data);
    assert.equal(result.chunkBytes, bytes.length);
    assert.equal(
      bytes.length,
      Math.min(maxBytes ?? 65536, expected.length - offsetBytes),
    );
    assert.deepEqual(
      bytes,
      expected.subarray(offsetBytes, offsetBytes + bytes.length),
    );
    assert.equal(result.nextOffsetBytes, offsetBytes + bytes.length);
    assert.equal(result.eof, result.nextOffsetBytes === expected.length);
    // Includes the outer MCP text wrapper and JSON-RPC envelope, not just data.
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
      },
    });
    assert(Buffer.byteLength(frame) < 400000);
    chunks.push(bytes);
    offsetBytes = result.nextOffsetBytes;
    if (result.eof) break;
    assert(bytes.length > 0);
  } while (offsetBytes < expected.length);
  assert.deepEqual(Buffer.concat(chunks), expected);
  const eof = await chunk(c, projectId, runId, { offsetBytes, expectedSha256 });
  assert.equal(eof.eof, true);
  assert.equal(eof.data, "");
  assert.equal(eof.chunkBytes, 0);
  assert.equal(eof.nextOffsetBytes, expected.length);
}
async function projectFiles(root, id) {
  const files = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, id, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else files[name] = await readFile(path.join(root, id, name), "utf8");
    }
  }
  await visit("");
  return files;
}
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
async function stdio(root, projectId) {
  const c = client();
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        projectId,
      ],
      env: { LOCAL_API_DATA: root },
      stderr: "pipe",
    }),
  );
  return c;
}

test(
  "official SDK reconstructs real API and flow records over HTTP and stdio without replay, then after restart and backup restore",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-result-chunk-sdk-"));
    const payload = '开始🧪é\u0000\\"\n'.repeat(20000);
    let requests = 0;
    const fixture = http.createServer((_req, res) => {
      requests++;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(payload);
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    let app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await closeServer(app.server);
      await closeServer(fixture);
      await rm(root, { recursive: true, force: true });
    });
    const allowed = await app.store.create("Chunk allowed");
    const denied = await app.store.create("Chunk denied");
    allowed.requests = [
      {
        id: "real-api",
        name: "No scripts, real loopback",
        method: "GET",
        url: `http://127.0.0.1:${fixture.address().port}/evidence`,
      },
    ];
    await app.store.save(allowed);
    const owner = async (url, data) => {
      const response = await fetch(app.url + url, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      assert(response.ok, await response.clone().text());
      return response.json();
    };
    const configure = (options = {}) =>
      owner("/api/mcp/config", {
        enabled: true,
        remember: true,
        projects: [allowed.id],
        write: false,
        execute: false,
        ...options,
      });
    const connect = async (token) => {
      const c = client();
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      return c;
    };
    const configured = await configure({ write: true, execute: true });
    let c = await connect(configured.token);
    const api = decode(
      await call(c, "localapi_execute_api", {
        projectId: allowed.id,
        apiId: "real-api",
      }),
    );
    assert.equal(api.status, "passed");
    const plan = decode(
      await call(c, "localapi_create_execution_flow", {
        projectId: allowed.id,
        plan: {
          name: "Saved real flow",
          steps: [{ request: allowed.requests[0] }],
        },
      }),
    );
    const flow = decode(
      await call(c, "localapi_execute_flow", {
        projectId: allowed.id,
        planId: plan.id,
      }),
    );
    assert.equal(flow.status, "passed");
    assert.equal(requests, 2);
    const apiBytes = await persistedBytes(root, allowed.id, "api", api.id);
    const flowBytes = await persistedBytes(root, allowed.id, "flow", flow.id);
    assert.equal(JSON.parse(apiBytes).response.body, payload);
    assert.equal(JSON.parse(flowBytes).results[0].response.body, payload);
    await configure();
    const advertised = (await c.listTools()).tools;
    const schema = advertised.find(
      (item) => item.name === toolName,
    ).inputSchema;
    assert.deepEqual(schema.required.sort(), [
      "offsetBytes",
      "projectId",
      "runId",
    ]);
    assert.equal(schema.properties.maxBytes.default, 65536);
    assert.equal(schema.properties.maxBytes.maximum, 262144);
    assert(
      !advertised.some(
        (item) => item.name === "apipost_get_execution_result_chunk",
      ),
    );
    assert(!advertised.some((item) => item.name === "localapi_execute_api"));
    const beforeReads = await projectFiles(root, allowed.id);
    await reconstruct(c, allowed.id, api.id, apiBytes);
    await reconstruct(c, allowed.id, flow.id, flowBytes, 262144);
    assert.deepEqual(
      decode(
        await call(c, "localapi_get_execution_result", {
          projectId: allowed.id,
          runId: api.id,
        }),
      ),
      JSON.parse(apiBytes),
    );
    assert.deepEqual(
      decode(
        await call(c, "localapi_get_run", {
          projectId: allowed.id,
          runId: flow.id,
        }),
      ),
      JSON.parse(flowBytes),
    );
    const native = decode(
      await call(c, "apipost_get_execution_result", {
        project_id: allowed.id,
        run_id: api.id,
      }),
    );
    assert.equal(native.run.workbench_evidence_format, 1);
    assert.equal(native.run.response.body, payload);
    assert.equal(JSON.parse(apiBytes).workbench_evidence_format, undefined);
    const split = apiBytes.indexOf(Buffer.from("🧪")) + 1;
    assert(split > 0);
    const splitChunk = await chunk(c, allowed.id, api.id, {
      offsetBytes: split,
      maxBytes: 1,
      expectedSha256: hash(apiBytes),
    });
    assert.deepEqual(
      Buffer.from(splitChunk.data, "base64"),
      apiBytes.subarray(split, split + 1),
    );
    await rejectChunk(c, denied.id, api.id);
    await rejectChunk(c, allowed.id, "PRIVATE-ARGUMENT-missing");
    for (const args of [
      { offsetBytes: -1 },
      { offsetBytes: 0.5 },
      { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
      { offsetBytes: "PRIVATE-ARGUMENT" },
      { offsetBytes: 1 },
      { offsetBytes: apiBytes.length + 1, expectedSha256: hash(apiBytes) },
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: 262145 },
      { maxBytes: 1.5 },
      { maxBytes: "PRIVATE-ARGUMENT" },
      { expectedSha256: "0".repeat(64) },
      { expectedSha256: "PRIVATE-ARGUMENT" },
    ])
      await rejectChunk(c, allowed.id, api.id, args);
    const child = await stdio(root, allowed.id);
    clients.push(child);
    await reconstruct(child, allowed.id, api.id, apiBytes, 262144);
    await reconstruct(child, allowed.id, flow.id, flowBytes);
    await rejectChunk(child, denied.id, api.id);
    assert.deepEqual(await projectFiles(root, allowed.id), beforeReads);
    assert.equal(
      requests,
      2,
      "result reads must never replay the network request",
    );

    const backup = await owner(`/api/projects/${allowed.id}/export`);
    const restored = await owner("/api/restore", { document: backup });
    assert.notEqual(restored.id, allowed.id);
    await rejectChunk(c, restored.id, api.id);
    await configure({ projects: [allowed.id, restored.id] });
    assert.deepEqual(
      await persistedBytes(root, restored.id, "api", api.id),
      apiBytes,
    );
    assert.deepEqual(
      await persistedBytes(root, restored.id, "flow", flow.id),
      flowBytes,
    );
    await reconstruct(c, restored.id, api.id, apiBytes, 262144);
    await reconstruct(c, restored.id, flow.id, flowBytes, 262144);
    const beforeRestart = await chunk(c, allowed.id, api.id);
    await c.close();
    await child.close();
    await closeServer(app.server);
    app = await createApp({ root, port: 0 });
    c = await connect(configured.token);
    const continuation = await chunk(c, allowed.id, api.id, {
      offsetBytes: beforeRestart.nextOffsetBytes,
      expectedSha256: beforeRestart.sha256,
    });
    assert.deepEqual(
      Buffer.from(continuation.data, "base64"),
      apiBytes.subarray(65536, 131072),
    );
    await reconstruct(c, allowed.id, flow.id, flowBytes, 262144);
    const restartedChild = await stdio(root, allowed.id);
    clients.push(restartedChild);
    await reconstruct(restartedChild, allowed.id, api.id, apiBytes, 262144);
    assert.equal(requests, 2);
  },
);

test(
  "SDK chunk continuation rechecks persisted identity, authorization, archive, edits, duplicate IDs and retention on every call",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "mcp-result-chunk-state-"),
    );
    const app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await closeServer(app.server);
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("State isolation");
    const other = await app.store.create("Other same ID");
    const record = {
      id: "same-id",
      response: { body: "fixture-secret " + "🧪".repeat(20000) },
    };
    await app.store.append(p.id, "history", record);
    await app.store.append(p.id, "runs", { id: "healthy-flow", results: [] });
    await app.store.append(other.id, "history", {
      ...record,
      response: { body: "Different project" },
    });
    const configure = async (projects) => {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects,
          write: false,
          execute: false,
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const config = await configure([p.id]);
    const c = client();
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const initial = await chunk(c, p.id, record.id);
    const continuation = {
      offsetBytes: initial.nextOffsetBytes,
      expectedSha256: initial.sha256,
    };
    await configure([]);
    await rejectChunk(c, p.id, record.id, continuation);
    await configure([p.id, other.id]);
    const isolated = await chunk(c, other.id, record.id);
    assert.notEqual(isolated.sha256, initial.sha256);
    assert.equal(
      JSON.parse(Buffer.from(isolated.data, "base64")).response.body,
      "Different project",
    );
    await rejectChunk(c, other.id, record.id, continuation);
    const edit = async (change) => {
      const latest = await app.store.get(p.id);
      change(latest);
      await app.store.save(latest, { activity: true });
    };
    await edit((project) => {
      project.archived = true;
    });
    await rejectChunk(c, p.id, record.id, continuation);
    await edit((project) => {
      project.archived = false;
    });
    await edit((project) => {
      project.history[0].response.body += "changed";
    });
    await rejectChunk(c, p.id, record.id, continuation);
    await rejectChunk(c, p.id, record.id, { expectedSha256: initial.sha256 });
    const changed = await chunk(c, p.id, record.id);
    assert.notEqual(changed.sha256, initial.sha256);
    await edit((project) => {
      project.runs.push({ id: record.id, results: [] });
    });
    await rejectChunk(c, p.id, record.id);
    await edit((project) => {
      project.runs = project.runs.filter((run) => run.id !== record.id);
    });
    const beforeEviction = await chunk(c, p.id, record.id);
    // Exercise Store's real bounded-retention mechanism, not a cached fake store.
    await app.store.append(
      p.id,
      "history",
      { id: "replacement", response: { body: "retained" } },
      1,
    );
    await rejectChunk(c, p.id, record.id, {
      offsetBytes: beforeEviction.nextOffsetBytes,
      expectedSha256: beforeEviction.sha256,
    });
    assert.equal((await chunk(c, p.id, "healthy-flow")).eof, true);
    assert.equal((await chunk(c, p.id, "replacement")).eof, true);
    const s = await stdio(root, p.id);
    clients.push(s);
    await rejectChunk(s, p.id, record.id, continuation);
    assert.equal((await chunk(s, p.id, "healthy-flow")).eof, true);
    // Reload using a separate Store instance to prove persisted eviction.
    const reloaded = await new Store(root).get(p.id);
    assert.deepEqual(
      reloaded.history.map((entry) => entry.id),
      ["replacement"],
    );
    const historyPath = path.join(root, p.id, "history", "requests.json");
    const savedHistory = await readFile(historyPath);
    await writeFile(historyPath, '{"PRIVATE-ARGUMENT":');
    assert.equal(
      await rejectChunk(c, p.id, "replacement"),
      "执行结果分块读取失败",
    );
    assert.equal(
      await rejectChunk(s, p.id, "replacement"),
      "执行结果分块读取失败",
    );
    await writeFile(historyPath, savedHistory);
    assert.equal((await chunk(c, p.id, "replacement")).eof, true);
    await rm(path.join(root, p.id), { recursive: true });
    assert.equal(
      await rejectChunk(c, p.id, "replacement"),
      "执行结果分块读取失败",
    );
    assert.equal(
      await rejectChunk(s, p.id, "replacement"),
      "执行结果分块读取失败",
    );
    assert.equal((await chunk(c, other.id, record.id)).eof, true);
  },
);
