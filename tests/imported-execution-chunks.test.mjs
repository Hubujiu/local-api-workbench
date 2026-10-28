import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { getImportedExecutionRun } from "../src/imported-execution-history.mjs";

// All data here is synthetic. These tests never execute an API, plan, script,
// XML parser or database operation; SDK subprocesses have read-only grants.
const toolName = "localapi_get_imported_execution_run";
const runId = "shared-run-id";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
function archive(sourceProjectId, payload = '"界🙂\\\\quoted"') {
  const metadata = {
    project_id: sourceProjectId,
    run_id: runId,
    status: "passed",
    steps: [],
    detail_file: `executions/runs/${runId}.json`,
  };
  const text =
    `{\n "project_id": ${JSON.stringify(sourceProjectId)},` +
    `\n "run_id": ${JSON.stringify(runId)}, "status": "passed",` +
    `\n "steps": [], "payload": ${payload}, "negativeZero": -0\n}\n`;
  return {
    text,
    document: {
      format: "apipost-offline-directory-v1",
      files: [
        {
          path: "project.json",
          text: JSON.stringify({
            project_id: sourceProjectId,
            name: "Synthetic source history",
          }),
        },
        {
          path: "executions/runs/index.json",
          text: JSON.stringify({ version: 2, records: [metadata] }),
        },
        { path: metadata.detail_file, text },
      ],
    },
  };
}
async function closeApp(app) {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imported-chunks-"));
  const context = {
    root,
    app: await createApp({ root, port: 0 }),
    clients: [],
  };
  t.after(async () => {
    await Promise.all(context.clients.map((c) => c.close().catch(() => {})));
    await closeApp(context.app);
    await rm(root, { recursive: true, force: true });
  });
  return context;
}
async function owner(context, url, body, status = 200) {
  const response = await fetch(context.app.url + url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-local-token": context.app.token,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, result.error);
  return result;
}
const makeClient = () =>
  new Client(
    { name: "synthetic-imported-chunks", version: "1.0.0" },
    { capabilities: {} },
  );
async function httpClient(context, projects) {
  const config = await owner(context, "/api/mcp/config", {
    enabled: true,
    projects,
    write: false,
    execute: false,
    remember: false,
  });
  const client = makeClient();
  context.clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(context.app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  return client;
}
async function stdioClient(context, projectId) {
  const client = makeClient();
  context.clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        projectId,
      ],
      env: { LOCAL_API_DATA: context.root },
      stderr: "pipe",
    }),
  );
  return client;
}
const call = (client, args) =>
  client.callTool({ name: toolName, arguments: args });
async function reconstruct(client, args, text, firstMaxBytes) {
  const expected = Buffer.from(text, "utf8");
  const digest = sha256(expected);
  const chunks = [];
  let offsetBytes = 0;
  do {
    const maxBytes = offsetBytes === 0 ? firstMaxBytes : 256 * 1024;
    const response = await call(client, {
      ...args,
      chunk: {
        offsetBytes,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(offsetBytes === 0 ? {} : { expectedArtifactSha256: digest }),
      },
    });
    assert(Buffer.byteLength(JSON.stringify(response)) < 360 * 1024);
    const output = decode(response);
    assert.equal(output.provenance, "imported-apipost-archive");
    assert.equal(output.executedByWorkbench, false);
    assert.equal(output.projectId, args.projectId);
    assert.equal(output.sourceProjectId, args.sourceProjectId);
    assert.equal(output.runId, args.runId);
    assert.equal(output.artifactSha256, digest);
    assert.equal(Object.hasOwn(output, "original"), false);
    const chunk = output.chunk;
    assert.equal(chunk.version, 1);
    assert.equal(chunk.encoding, "base64");
    assert.equal(chunk.mediaType, "application/json");
    assert.equal(chunk.offsetBytes, offsetBytes);
    assert.equal(chunk.totalBytes, expected.length);
    const bytes = Buffer.from(chunk.data, "base64");
    assert.equal(chunk.data, bytes.toString("base64"));
    assert.equal(chunk.chunkBytes, bytes.length);
    assert.equal(
      bytes.length,
      Math.min(maxBytes ?? 64 * 1024, expected.length - offsetBytes),
    );
    assert.deepEqual(
      bytes,
      expected.subarray(offsetBytes, offsetBytes + bytes.length),
    );
    chunks.push(bytes);
    offsetBytes += bytes.length;
    assert.equal(chunk.eof, offsetBytes === expected.length);
    assert.equal(chunk.nextOffsetBytes, offsetBytes);
  } while (offsetBytes < expected.length);
  const reconstructed = Buffer.concat(chunks);
  assert.deepEqual(reconstructed, expected);
  assert.equal(sha256(reconstructed), digest);
  const eof = decode(
    await call(client, {
      ...args,
      chunk: { offsetBytes, expectedArtifactSha256: digest },
    }),
  );
  assert.deepEqual(eof.chunk, {
    version: 1,
    encoding: "base64",
    mediaType: "application/json",
    offsetBytes,
    chunkBytes: 0,
    totalBytes: expected.length,
    nextOffsetBytes: expected.length,
    eof: true,
    data: "",
  });
  return digest;
}
async function rejected(client, args) {
  const response = await call(client, args);
  assert.equal(response.isError, true);
  assert.equal(typeof response.content[0].text, "string");
  assert(Buffer.byteLength(response.content[0].text) < 1024);
  await client.ping();
  return response;
}

test(
  "accepted 400k-value native archive survives owner import, restart, backup restore and SDK HTTP/stdio byte readback",
  { timeout: 60000 },
  async (t) => {
    const context = await setup(t);
    const sourceProjectId = "synthetic-large-source";
    // 400,000 numeric lexemes occupy about 2 MiB, yet their canonical JSON expands
    // beyond an 8 MiB MCP frame. This is bounded data, not a stress/OOM workload.
    const native = archive(sourceProjectId, `[${"1e20,".repeat(399999)}1e20]`);
    assert.equal(JSON.parse(native.text).payload.length, 400000);
    assert(
      Buffer.byteLength(JSON.stringify(native.document)) < 4 * 1024 * 1024,
    );
    const p = await owner(
      context,
      "/api/projects",
      { name: "Allowed history" },
      201,
    );
    const denied = await owner(
      context,
      "/api/projects",
      { name: "Denied history" },
      201,
    );
    for (const projectId of [p.id, denied.id]) {
      const imported = await owner(
        context,
        `/api/projects/${projectId}/import`,
        { document: native.document },
      );
      assert.equal(imported.runs.length, 0);
      assert.equal(imported.history.length, 0);
      assert.equal(imported.requests.length, 0);
      assert.equal(imported.plans.length, 0);
    }
    const stored = await context.app.store.get(p.id);
    const full = getImportedExecutionRun(stored, sourceProjectId, runId);
    const fullFrame =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(full) }] },
      }) + "\n";
    assert(Buffer.byteLength(fullFrame) > 8 * 1024 * 1024);
    assert.notEqual(sha256(JSON.stringify(full.original)), full.artifactSha256);
    assert.equal(full.artifactSha256, sha256(native.text));
    t.diagnostic(
      `synthetic source bytes=${Buffer.byteLength(native.text)}; legacy full RPC bytes=${Buffer.byteLength(fullFrame)}; values=400000`,
    );

    await closeApp(context.app);
    context.app = await createApp({ root: context.root, port: 0 });
    const restartedStore = new Store(context.root);
    await restartedStore.init();
    assert.deepEqual(await restartedStore.get(p.id), stored);
    const backup = await owner(context, `/api/projects/${p.id}/export`);
    const restored = await owner(
      context,
      "/api/restore",
      { document: backup },
      201,
    );
    assert.notEqual(restored.id, p.id);
    const snapshots = await Promise.all(
      [p.id, restored.id, denied.id].map((id) => context.app.store.get(id)),
    );
    const http = await httpClient(context, [p.id, restored.id]);
    const discovery = await http.listTools();
    const tool = discovery.tools.find((item) => item.name === toolName);
    assert(tool);
    assert.equal(
      discovery.tools.filter((item) =>
        item.name.includes("imported_execution_run"),
      ).length,
      2,
    );
    assert.deepEqual(tool.inputSchema.required, [
      "projectId",
      "sourceProjectId",
      "runId",
    ]);
    assert.equal(tool.inputSchema.properties.chunk.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.chunk.required, [
      "offsetBytes",
    ]);
    assert(
      !discovery.tools.some((item) => /execute|create_project/.test(item.name)),
    );
    const list = decode(
      await http.callTool({
        name: "localapi_list_imported_execution_runs",
        arguments: { projectId: p.id, sourceProjectId },
      }),
    );
    assert.equal(list.items[0].artifactSha256, sha256(native.text));
    assert.equal(list.items[0].originalStatus, "passed");
    await reconstruct(
      http,
      { projectId: p.id, sourceProjectId, runId },
      native.text,
    );
    await rejected(http, {
      projectId: denied.id,
      sourceProjectId,
      runId,
      chunk: { offsetBytes: 1, expectedArtifactSha256: sha256(native.text) },
    });
    const stdio = await stdioClient(context, restored.id);
    await reconstruct(
      stdio,
      { projectId: restored.id, sourceProjectId, runId },
      native.text,
      256 * 1024,
    );
    await rejected(stdio, {
      projectId: p.id,
      sourceProjectId,
      runId,
      chunk: { offsetBytes: 0 },
    });
    assert.deepEqual(
      await Promise.all(
        [p.id, restored.id, denied.id].map((id) => context.app.store.get(id)),
      ),
      snapshots,
    );
  },
);

test(
  "SDK chunks preserve lexical bytes, isolate source/runtime IDs, and recheck digest, archive and permissions on every call",
  { timeout: 30000 },
  async (t) => {
    const context = await setup(t);
    const a = archive("source-A"),
      b = archive("source-B", '"different source"');
    const p = await owner(
      context,
      "/api/projects",
      { name: "Isolated history" },
      201,
    );
    for (const native of [a, b])
      await owner(context, `/api/projects/${p.id}/import`, {
        document: native.document,
      });
    const stored = await context.app.store.get(p.id);
    // Deliberate ID collisions are inert saved records, never newly executed runs.
    stored.runs = [
      { id: runId, status: "failed", results: [], marker: "local flow" },
    ];
    stored.history = [{ id: runId, marker: "local API" }];
    await context.app.store.save(stored);
    const http = await httpClient(context, [p.id]);
    const stdio = await stdioClient(context, p.id);
    const args = { projectId: p.id, sourceProjectId: "source-A", runId };
    const before = await context.app.store.get(p.id);
    for (const client of [http, stdio]) {
      const legacy = decode(await call(client, args));
      assert.deepEqual(
        Object.keys(legacy).sort(),
        [
          "provenance",
          "executedByWorkbench",
          "projectId",
          "sourceProjectId",
          "runId",
          "artifactSha256",
          "original",
        ].sort(),
      );
      // The legacy JSON-RPC full object canonicalizes numeric lexemes; chunk
      // mode must retain the source -0 and 1e20 instead.
      assert.deepEqual(
        legacy.original,
        JSON.parse(JSON.stringify(JSON.parse(a.text))),
      );
      assert.equal(Object.is(JSON.parse(a.text).negativeZero, -0), true);
      assert.equal(Object.is(legacy.original.negativeZero, -0), false);
      assert.equal(legacy.artifactSha256, sha256(a.text));
      await reconstruct(client, args, a.text, 1);
      await reconstruct(
        client,
        { ...args, sourceProjectId: "source-B" },
        b.text,
        7,
      );
      const bytes = Buffer.from(a.text);
      const offsetBytes = bytes.indexOf(Buffer.from("界")) + 1;
      const split = decode(
        await call(client, {
          ...args,
          chunk: {
            offsetBytes,
            maxBytes: 1,
            expectedArtifactSha256: sha256(a.text),
          },
        }),
      );
      assert.deepEqual(
        Buffer.from(split.chunk.data, "base64"),
        bytes.subarray(offsetBytes, offsetBytes + 1),
      );
      for (const chunk of [
        null,
        [],
        "0",
        {},
        { offsetBytes: -1 },
        { offsetBytes: 0.5 },
        { offsetBytes: "0" },
        { offsetBytes: Number.MAX_SAFE_INTEGER + 1 },
        { offsetBytes: 0, maxBytes: 0 },
        { offsetBytes: 0, maxBytes: -1 },
        { offsetBytes: 0, maxBytes: 1.5 },
        { offsetBytes: 0, maxBytes: "1" },
        { offsetBytes: 0, maxBytes: 256 * 1024 + 1 },
        { offsetBytes: 1 },
        { offsetBytes: 0, expectedArtifactSha256: "0".repeat(64) },
        {
          offsetBytes: 0,
          expectedArtifactSha256: sha256(a.text).toUpperCase(),
        },
        { offsetBytes: 0, expectedArtifactSha256: 42 },
        {
          offsetBytes: bytes.length + 1,
          expectedArtifactSha256: sha256(a.text),
        },
        { offsetBytes: 0, path: "/arbitrary/file" },
      ])
        await rejected(client, { ...args, chunk });
      for (const override of [
        { sourceProjectId: "missing" },
        { sourceProjectId: "../source-A" },
        { runId: "missing" },
        { runId: "../shared-run-id" },
        { projectId: p.id + "x" },
        { projectId: 7 },
        { url: "https://example.invalid/archive" },
      ])
        await rejected(client, {
          ...args,
          ...override,
          chunk: { offsetBytes: 0 },
        });
    }
    assert.deepEqual(await context.app.store.get(p.id), before);

    const first = decode(
      await call(http, { ...args, chunk: { offsetBytes: 0, maxBytes: 10 } }),
    );
    const continuation = {
      ...args,
      chunk: { offsetBytes: 10, expectedArtifactSha256: first.artifactSha256 },
    };
    const changed = archive("source-A", '"changed after first chunk"');
    await owner(context, `/api/projects/${p.id}/import`, {
      document: changed.document,
    });
    for (const client of [http, stdio]) {
      await rejected(client, continuation);
      await reconstruct(client, args, changed.text, 10);
    }
    let current = await context.app.store.get(p.id);
    current.settings.apipostDirectoryArtifacts =
      current.settings.apipostDirectoryArtifacts.filter(
        (entry) => entry.sourceProjectId !== "source-A",
      );
    await context.app.store.save(current);
    for (const client of [http, stdio]) {
      await rejected(client, continuation);
      await rejected(client, { ...args, chunk: { offsetBytes: 0 } });
      await reconstruct(
        client,
        { ...args, sourceProjectId: "source-B" },
        b.text,
      );
    }
    await owner(context, `/api/projects/${p.id}/import`, {
      document: a.document,
    });
    current = await context.app.store.get(p.id);
    current.archived = true;
    await context.app.store.save(current);
    for (const client of [http, stdio]) await rejected(client, continuation);
    current = await context.app.store.get(p.id);
    current.archived = false;
    await context.app.store.save(current);
    for (const client of [http, stdio]) await reconstruct(client, args, a.text);
    const after = await context.app.store.get(p.id);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.protocolRuns, before.protocolRuns);
    assert.deepEqual(after.environments, before.environments);
    assert.deepEqual(after.plans, before.plans);
  },
);
