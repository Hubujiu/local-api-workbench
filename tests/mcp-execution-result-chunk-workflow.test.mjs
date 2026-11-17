// ROOT integration acceptance: real bounded loopback executions, real persisted
// records, official SDK transports, and unchanged production stdio framing.
// Chunk output is bounded; Store still reads whole history files, not streams.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";

const MiB = 1024 * 1024;
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const call = (client, name, args) =>
  client.callTool({ name: "localapi_" + name, arguments: args });
const readChunk = async (client, projectId, runId, args = {}) =>
  decode(
    await call(client, "get_execution_result_chunk", {
      projectId,
      runId,
      offsetBytes: 0,
      ...args,
    }),
  );
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function reconstruct(
  client,
  projectId,
  expected,
  { defaultFirst = false } = {},
) {
  // Independent Store evidence, not the execution response/native wrapper or a
  // transient save receipt, defines the exact persisted-record byte contract.
  const expectedBytes = Buffer.from(JSON.stringify(expected), "utf8");
  const expectedSha = sha256(expectedBytes);
  const pieces = [];
  let offsetBytes = 0,
    chunks = 0;
  do {
    const chunk = await readChunk(client, projectId, expected.id, {
      offsetBytes,
      ...(defaultFirst && offsetBytes === 0 ? {} : { maxBytes: 256 * 1024 }),
      ...(offsetBytes > 0 ? { expectedSha256: expectedSha } : {}),
    });
    assert.equal(chunk.version, 1);
    assert.equal(chunk.projectId, projectId);
    assert.equal(chunk.runId, expected.id);
    assert.equal(chunk.encoding, "base64");
    assert.equal(chunk.mediaType, "application/json");
    assert.equal(chunk.sha256, expectedSha);
    assert.equal(chunk.offsetBytes, offsetBytes);
    assert.equal(chunk.totalBytes, expectedBytes.length);
    const bytes = Buffer.from(chunk.data, "base64");
    assert.equal(bytes.toString("base64"), chunk.data);
    assert.equal(chunk.chunkBytes, bytes.length);
    assert(bytes.length > 0);
    assert(
      bytes.length <= (defaultFirst && offsetBytes === 0 ? 64 : 256) * 1024,
    );
    assert.deepEqual(
      bytes,
      expectedBytes.subarray(offsetBytes, offsetBytes + bytes.length),
    );
    pieces.push(bytes);
    chunks++;
    offsetBytes += bytes.length;
    assert.equal(chunk.eof, offsetBytes === expectedBytes.length);
    assert.equal(chunk.nextOffsetBytes, offsetBytes);
    if (chunk.eof) break;
  } while (offsetBytes < expectedBytes.length);
  const actual = Buffer.concat(pieces);
  assert.deepEqual(actual, expectedBytes);
  assert.equal(sha256(actual), expectedSha);
  assert.deepEqual(JSON.parse(actual.toString("utf8")), expected);
  return { bytes: actual.length, chunks, sha256: expectedSha };
}

async function rejectedChunk(client, projectId, runId, args, message) {
  const result = await call(client, "get_execution_result_chunk", {
    projectId,
    runId,
    offsetBytes: 0,
    ...args,
  });
  assert.equal(result.isError, true);
  const text = result.content?.[0]?.text || "";
  assert(
    text.length < 1024,
    "failures remain small rather than reflecting evidence",
  );
  assert.doesNotMatch(text, /chunkBytes|nextOffsetBytes|"data"/);
  if (message) assert.match(text, message);
  await client.ping();
}

test(
  "large saved evidence crosses the real stdio frame boundary, reconstructs via both SDKs without replay, and survives isolated backup/restart reads",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-chunk-workflow-"));
    // A single ~2 MiB response stays well inside the existing 8 MiB network
    // response budget. JSON escaping gives a ~4 MiB saved record and a >8 MiB
    // double-encoded MCP frame, without lowering the production writer limit.
    const largeBody = '"'.repeat(2 * MiB + 1024) + "\n中文🙂\\end";
    assert(Buffer.byteLength(largeBody) < 8 * MiB);
    const wire = [],
      clients = [];
    let pendingResponse;
    let observePending;
    const observedPending = new Promise((resolve) => {
      observePending = resolve;
    });
    const peer = http.createServer((req, res) => {
      wire.push({ url: req.url, identity: req.headers["x-identity"] });
      if (req.url === "/pending-cancel") {
        pendingResponse = res;
        observePending();
        return;
      }
      res.setHeader("x-evidence", "loopback-once");
      res.setHeader(
        "content-type",
        req.url === "/large" ? "text/plain; charset=utf-8" : "application/json",
      );
      res.end(
        req.url === "/large"
          ? largeBody
          : JSON.stringify({ value: "小记录🙂", observed: wire.length }),
      );
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    let app = await createApp({ root, port: 0 });
    const closeClients = async () => {
      await Promise.all(
        clients.splice(0).map((c) => c.close().catch(() => {})),
      );
    };
    t.after(async () => {
      await closeClients();
      await closeServer(app.server);
      await closeServer(peer);
      await rm(root, { recursive: true, force: true });
    });
    const owner = async (route, body) => {
      const response = await fetch(app.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    };
    const connect = async (kind, projectId, execute = false) => {
      const client = new Client({
        name: "chunk-workflow-" + kind,
        version: "1",
      });
      clients.push(client);
      if (kind === "stdio") {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              projectId,
              ...(execute ? ["--execute", "--write"] : []),
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          }),
        );
      } else {
        const config = await owner("/api/mcp/config", {
          enabled: true,
          projects: [projectId],
          execute,
          write: execute,
          remember: false,
        });
        assert.equal(config.status, 200);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + config.value.token },
            },
          }),
        );
      }
      return client;
    };

    const project = await app.store.create("Chunk evidence source");
    project.environments[0].variables.identity = "source-project";
    const base = `http://127.0.0.1:${peer.address().port}`;
    const request = (id, route) =>
      normalizeRequest({
        id,
        name: id,
        method: "GET",
        url: base + route,
        headers: [{ key: "X-Identity", value: "{{identity}}" }],
      });
    const small = request("small-api", "/small");
    const large = request("large-api", "/large");
    project.requests = [small, large];
    const plan = snapshotPlan({
      name: "Frozen repeated evidence",
      environmentId: project.environments[0].id,
      steps: [
        {
          type: "repeat",
          id: "group",
          count: 2,
          steps: [{ id: "leaf", request: small }],
        },
      ],
    });
    const cancelPlan = snapshotPlan({
      name: "Real SDK cancellation",
      environmentId: project.environments[0].id,
      steps: [
        {
          id: "pending-leaf",
          request: { ...request("pending", "/pending-cancel"), timeout: 10000 },
        },
        { id: "must-not-run", request: request("later", "/after-cancel") },
      ],
    });
    project.plans = [plan, cancelPlan];
    await app.store.save(project);

    // Owner/API failure and a real repeated flow provide different persisted
    // shapes and source metadata, without any VM or custom-script execution.
    const failed = await owner(`/api/projects/${project.id}/execute`, {
      request: {
        ...small,
        assertions: [{ target: "status", op: "eq", value: 418 }],
      },
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.value.outcome, "failed");
    assert.equal(failed.value.recordSaved, true);
    const repeated = await owner(`/api/projects/${project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.value.status, "passed");
    assert.equal(repeated.value.recordSaved, true);
    assert.equal(repeated.value.results.length, 2);
    assert.deepEqual(
      repeated.value.results.map((r) => r.repeat.iteration),
      [0, 1],
    );
    assert.equal(
      new Set(repeated.value.results.map((r) => r.repeat.occurrenceId)).size,
      2,
    );

    const sdk = await connect("stdio", project.id, true);
    const native = decode(
      await sdk.callTool({
        name: "apipost_execute_api",
        arguments: { project_id: project.id, target_id: small.id },
      }),
    );
    assert.equal(native.status, "passed");
    assert.equal(native.record_saved, true);
    // Cancel an actually pending loopback request through the official SDK.
    // Observe the durable terminal record before continuing on the same session.
    const cancellation = new AbortController();
    const cancellationRejected = assert.rejects(
      sdk.callTool(
        {
          name: "localapi_execute_flow",
          arguments: { projectId: project.id, planId: cancelPlan.id },
        },
        undefined,
        { signal: cancellation.signal },
      ),
      /abort|cancel/i,
    );
    await observedPending;
    assert(pendingResponse);
    cancellation.abort();
    await cancellationRejected;
    let cancelled;
    const cancellationDeadline = Date.now() + 5000;
    while (Date.now() < cancellationDeadline) {
      cancelled = (await new Store(root).get(project.id)).runs.find(
        (r) => r.planId === cancelPlan.id,
      );
      if (cancelled) break;
      await delay(20);
    }
    assert(cancelled, "SDK cancellation must reach durable terminal evidence");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.source, "mcp");
    assert.equal(cancelled.results.length, 1);
    // Existing runner records the interrupted leaf as failed while the run
    // is cancelled; the chunk tool must preserve that distinction exactly.
    assert.equal(cancelled.results[0].status, "failed");
    assert.match(cancelled.results[0].error, /abort|cancel|取消/i);
    assert(!wire.some((row) => row.url === "/after-cancel"));
    await sdk.ping();
    const beforeLarge = wire.length;
    // Production stdio deliberately sanitizes writer failures to this fixed
    // RPC error; the actual saved-record frame size is checked below.
    await assert.rejects(
      call(sdk, "execute_api", { projectId: project.id, apiId: large.id }),
      /Execution\/progress\/output failed; inspect history, do not replay/,
    );
    assert.equal(wire.length, beforeLarge + 1);
    assert.equal(wire.filter((row) => row.url === "/large").length, 1);
    assert(wire.every((row) => row.identity === "source-project"));

    // The same session recovers only a small run ID summary. A second attempt
    // at the legacy full-result tool demonstrably hits the same real limit.
    const summaries = decode(
      await call(sdk, "list_execution_runs", {
        projectId: project.id,
        scope: "api",
        source: "mcp",
        limit: 1,
      }),
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].status, "passed");
    assert.equal(summaries[0].scope, "api");
    assert.equal(Object.hasOwn(summaries[0], "response"), false);
    const largeId = summaries[0].id;
    await assert.rejects(
      call(sdk, "get_execution_result", {
        projectId: project.id,
        runId: largeId,
      }),
      /Execution\/progress\/output failed; inspect history, do not replay/,
    );
    const independent = new Store(root);
    let persisted = await independent.get(project.id);
    const largeRecord = persisted.history.find((r) => r.id === largeId);
    assert(largeRecord);
    assert.equal(largeRecord.response.body, largeBody);
    assert.equal(largeRecord.source, "mcp");
    assert.equal(largeRecord.status, "passed");
    const recordBytes = Buffer.byteLength(JSON.stringify(largeRecord));
    assert(recordBytes > 4 * MiB && recordBytes < 32 * MiB);
    assert(
      Buffer.byteLength(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify(largeRecord) }],
          },
        }),
      ) >
        8 * MiB,
    );
    const networkAfterExecutions = wire.length;
    const stdioProof = await reconstruct(sdk, project.id, largeRecord, {
      defaultFirst: true,
    });
    assert.equal(
      wire.length,
      networkAfterExecutions,
      "all reads must not replay HTTP",
    );

    const smallRecords = [
      persisted.history.find((r) => r.id === failed.value.recordId),
      persisted.history.find((r) => r.id === native.run_id),
      persisted.runs.find((r) => r.id === repeated.value.id),
      persisted.runs.find((r) => r.id === cancelled.id),
    ];
    assert(smallRecords.every(Boolean));
    assert.equal(smallRecords[0].source, "manual");
    assert.equal(smallRecords[0].status, "failed");
    assert.equal(smallRecords[1].source, "mcp");
    assert.notDeepEqual(
      smallRecords[1],
      native,
      "native response is not the raw persisted record",
    );
    assert.equal(smallRecords[2].snapshot.steps[0].type, "repeat");
    assert.equal(smallRecords[2].planHash, repeated.value.planHash);
    assert.equal(smallRecords[3].status, "cancelled");

    const exported = await owner(`/api/projects/${project.id}/export`);
    assert.equal(exported.status, 200);
    const restoreInput = { document: exported.value };
    assert(
      Buffer.byteLength(JSON.stringify(restoreInput)) < 12 * MiB,
      "native backup restore must stay within the unchanged owner body limit",
    );
    const restored = await owner("/api/restore", restoreInput);
    assert.equal(restored.status, 201);
    const copyId = restored.value.id;
    assert.notEqual(copyId, project.id);
    assert.deepEqual(
      (await new Store(root).get(copyId)).history,
      persisted.history,
    );
    // This is an existing record in an existing project, not a not-found test.
    await rejectedChunk(
      sdk,
      copyId,
      largeId,
      { expectedSha256: stdioProof.sha256 },
      /项目未授权/,
    );

    await closeClients();
    await closeServer(app.server);
    app = await createApp({ root, port: 0 });
    const sourceHTTP = await connect("http", project.id);
    const copyStdio = await connect("stdio", copyId);
    for (const client of [sourceHTTP, copyStdio]) {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      assert(tools.includes("localapi_get_execution_result_chunk"));
      assert(!tools.includes("localapi_execute_api"));
      assert(!tools.includes("localapi_run_plan"));
    }
    const httpProof = await reconstruct(sourceHTTP, project.id, largeRecord);
    const restoredProof = await reconstruct(
      copyStdio,
      copyId,
      (await new Store(root).get(copyId)).history.find((r) => r.id === largeId),
    );
    assert.equal(httpProof.sha256, stdioProof.sha256);
    assert.equal(restoredProof.sha256, stdioProof.sha256);
    await rejectedChunk(
      sourceHTTP,
      copyId,
      largeId,
      { expectedSha256: httpProof.sha256 },
      /项目未授权/,
    );
    await rejectedChunk(
      copyStdio,
      project.id,
      largeId,
      { expectedSha256: restoredProof.sha256 },
      /项目未授权/,
    );

    for (const [client, projectId] of [
      [sourceHTTP, project.id],
      [copyStdio, copyId],
    ]) {
      for (const record of smallRecords)
        await reconstruct(client, projectId, record);
      const full = decode(
        await call(client, "get_execution_result", {
          projectId,
          runId: smallRecords[0].id,
        }),
      );
      assert.deepEqual(full, smallRecords[0]);
      const unsupported = await client.callTool({
        name: "apipost_get_execution_result",
        arguments: {
          project_id: projectId,
          run_id: repeated.value.id,
        },
      });
      assert.equal(
        unsupported.isError,
        true,
        "native repeat rejection is unchanged",
      );
      await rejectedChunk(client, projectId, largeId, {
        expectedSha256: "0".repeat(64),
      });
      await rejectedChunk(client, projectId, largeId, { offsetBytes: 1 });
    }

    // A continued read re-fetches the same project and record: digests are not
    // snapshots, capabilities, or permission to mix bytes from different data.
    const first = await readChunk(sourceHTTP, project.id, cancelled.id, {
      maxBytes: 16,
    });
    assert.equal(first.eof, false);
    const sourceChanged = await independent.get(project.id);
    sourceChanged.runs.find((r) => r.id === cancelled.id).planName +=
      " changed-between-chunks";
    // Activity writes deliberately edit terminal evidence for this owned
    // interruption fixture; ordinary configuration saves retain old history.
    await independent.save(sourceChanged, { activity: true });
    await rejectedChunk(sourceHTTP, project.id, cancelled.id, {
      offsetBytes: first.nextOffsetBytes,
      expectedSha256: first.sha256,
      maxBytes: 16,
    });
    await reconstruct(sourceHTTP, project.id, smallRecords[0]);
    assert.deepEqual(
      (await new Store(root).get(copyId)).runs.find(
        (r) => r.id === cancelled.id,
      ),
      cancelled,
      "source mutation does not change the independently restored project",
    );
    const sourceRestored = await independent.get(project.id);
    sourceRestored.runs = sourceRestored.runs.map((r) =>
      r.id === cancelled.id ? cancelled : r,
    );
    await independent.save(sourceRestored, { activity: true });

    const copyFirst = await readChunk(copyStdio, copyId, cancelled.id, {
      maxBytes: 16,
    });
    const evicted = await independent.get(copyId);
    evicted.runs = evicted.runs.filter((r) => r.id !== cancelled.id);
    await independent.save(evicted, { activity: true });
    await rejectedChunk(
      copyStdio,
      copyId,
      cancelled.id,
      {
        offsetBytes: copyFirst.nextOffsetBytes,
        expectedSha256: copyFirst.sha256,
      },
      /记录不存在/,
    );
    await reconstruct(copyStdio, copyId, smallRecords[0]);
    const recovered = await independent.get(copyId);
    recovered.runs = structuredClone(persisted.runs);
    recovered.history.push({ ...smallRecords[0], id: cancelled.id });
    await independent.save(recovered, { activity: true });
    await rejectedChunk(copyStdio, copyId, cancelled.id, {}, /记录 ID 不唯一/);
    const unique = await independent.get(copyId);
    unique.history = unique.history.filter((r) => r.id !== cancelled.id);
    unique.archived = true;
    await independent.save(unique, { activity: true });
    await rejectedChunk(
      copyStdio,
      copyId,
      largeId,
      { expectedSha256: restoredProof.sha256 },
      /项目已归档/,
    );
    const active = await independent.get(copyId);
    active.archived = false;
    await independent.save(active);
    await reconstruct(copyStdio, copyId, cancelled);
    await reconstruct(sourceHTTP, project.id, cancelled);

    const finalSource = await new Store(root).get(project.id);
    const finalCopy = await new Store(root).get(copyId);
    assert.deepEqual(finalSource.history, persisted.history);
    assert.deepEqual(finalSource.runs, persisted.runs);
    assert.deepEqual(finalCopy.history, persisted.history);
    assert.deepEqual(finalCopy.runs, persisted.runs);
    assert.equal(
      wire.length,
      networkAfterExecutions,
      "discovery, failures, restart, backup and chunks never replay requests",
    );
    assert.equal(wire.filter((row) => row.url === "/large").length, 1);
    t.diagnostic(
      `response ${Buffer.byteLength(largeBody)} bytes; persisted record ${stdioProof.bytes} bytes; stdio/http/restored chunks ${stdioProof.chunks}/${httpProof.chunks}/${restoredProof.chunks}; ${wire.length} total loopback requests, one large`,
    );
  },
);
