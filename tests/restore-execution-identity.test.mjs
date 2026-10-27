import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function disk(root) {
  const result = {};
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path.join(directory, entry.name), relative + "/");
      else
        result[relative] = (
          await readFile(path.join(directory, entry.name))
        ).toString("base64");
    }
  }
  await visit(root);
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "restore-identity-"));
  let app = await createApp({ root, port: 0 }),
    calls = 0;
  const clients = [];
  const peer = http.createServer((req, res) => {
    calls++;
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: restored-evidence\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ observed: calls }));
    }
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const closeApp = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function owner(route, body) {
    const response = await fetch(app.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  }
  async function sdk(projectId, transport = "http") {
    const client = new Client(
      { name: "restore-identity", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);
    if (transport === "stdio") {
      await client.connect(
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
    } else {
      const configured = await owner("/api/mcp/config", {
        enabled: true,
        projects: [projectId],
        write: false,
        execute: false,
        remember: false,
      });
      assert.equal(configured.status, 200);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + configured.value.token },
          },
        }),
      );
    }
    return client;
  }
  const project = await app.store.create("Actual execution source");
  const request = {
    id: "actual-api",
    name: "Actual API",
    method: "GET",
    url: `http://127.0.0.1:${peer.address().port}/proof`,
  };
  project.requests = [request];
  project.plans = [
    snapshotPlan({
      name: "Actual plan",
      environmentId: project.environments[0].id,
      steps: [{ request }],
    }),
  ];
  await app.store.save(project);
  const single = await owner(`/api/projects/${project.id}/execute`, {
    request,
  });
  assert.equal(single.status, 200);
  assert.equal(single.value.outcome, "passed");
  const run = await owner(`/api/projects/${project.id}/run`, {
    planId: project.plans[0].id,
  });
  assert.equal(run.status, 200);
  assert.equal(run.value.status, "passed");
  assert.equal(calls, 2);
  const exported = await owner(`/api/projects/${project.id}/export`);
  assert.equal(exported.status, 200);
  return {
    root,
    project,
    backup: exported.value,
    owner,
    sdk,
    calls: () => calls,
    store: () => app.store,
    async restart() {
      await closeApp();
      app = await createApp({ root, port: 0 });
    },
    async protocol() {
      const result = await owner(`/api/projects/${project.id}/protocol`, {
        type: "sse",
        url: `http://127.0.0.1:${peer.address().port}/events`,
        duration: 1000,
        maxEvents: 1,
      });
      assert.equal(result.status, 200);
      return (await app.store.get(project.id)).protocolRuns[0];
    },
  };
}
async function result(client, projectId, runId) {
  return client.callTool({
    name: "localapi_get_execution_result",
    arguments: { projectId, runId },
  });
}
async function assertReadable(f, projectId, expected) {
  for (const transport of ["http", "stdio"]) {
    const client = await f.sdk(projectId, transport);
    const rows = decode(
      await client.callTool({
        name: "localapi_list_execution_runs",
        arguments: { projectId, limit: 50 },
      }),
    );
    assert.equal(rows.length, expected.history.length + expected.runs.length);
    for (const record of [...expected.history, ...expected.runs])
      assert.deepEqual(
        decode(await result(client, projectId, record.id)),
        record,
      );
    assert.equal(
      (await result(client, f.project.id, expected.history[0].id)).isError,
      true,
    );
    await client.close();
  }
}

test(
  "restore rejects ambiguous execution IDs before any project mutation",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const variants = [
      [
        "history duplicate",
        (p) => p.history.push(structuredClone(p.history[0])),
      ],
      ["run duplicate", (p) => p.runs.push(structuredClone(p.runs[0]))],
      [
        "cross collection",
        (p) => {
          p.runs[0].id = p.history[0].id;
        },
      ],
      [
        "empty history",
        (p) => {
          p.history[0].id = "";
        },
      ],
      [
        "empty run",
        (p) => {
          p.runs[0].id = "";
        },
      ],
      [
        "duplicate beyond retention",
        (p) => {
          p.history = Array.from({ length: 51 }, (_, i) => ({
            ...p.history[0],
            id: `history-${i}`,
          }));
          p.history[50].id = p.history[0].id;
        },
      ],
      [
        "cross collection beyond retention",
        (p) => {
          p.history = Array.from({ length: 51 }, (_, i) => ({
            ...p.history[0],
            id: `history-${i}`,
          }));
          p.runs[0].id = p.history[50].id;
        },
      ],
    ];
    for (const [label, change] of variants) {
      const candidate = structuredClone(f.backup);
      change(candidate);
      const before = await disk(f.root),
        beforeList = await f.store().list();
      const restored = await f.owner("/api/restore", { document: candidate });
      if (restored.status === 201 && label === "history duplicate") {
        // Keep the old-code failure observable through disk restart and the real SDK,
        // not merely an assertion against a pure validation helper.
        await f.restart();
        const persisted = await f.store().get(restored.value.id);
        assert.equal(persisted.history.length, 2);
        const client = await f.sdk(restored.value.id);
        const rows = decode(
          await client.callTool({
            name: "localapi_list_execution_runs",
            arguments: { projectId: restored.value.id },
          }),
        );
        assert.equal(
          rows.filter((row) => row.id === persisted.history[0].id).length,
          2,
        );
        const detail = await result(
          client,
          restored.value.id,
          persisted.history[0].id,
        );
        assert.equal(detail.isError, true);
        assert.match(detail.content[0].text, /不唯一/);
        t.diagnostic(
          "RED: owner restore returned 201; duplicate persisted after restart and SDK listed both but rejected detail as ambiguous",
        );
      }
      assert.equal(restored.status, 400, label);
      assert.match(restored.value.error, /记录.*ID/);
      assert.deepEqual(await disk(f.root), before, label + " disk");
      assert.deepEqual(await f.store().list(), beforeList, label + " projects");
      assert.equal(f.calls(), 2, label + " wire count");
    }
  },
);

test(
  "actual API and plan evidence survives restore, restart and both SDK transports without replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const restored = await f.owner("/api/restore", { document: f.backup });
    assert.equal(restored.status, 201);
    await f.restart();
    await assertReadable(f, restored.value.id, f.backup);
    const reexport = await f.owner(`/api/projects/${restored.value.id}/export`);
    assert.deepEqual(reexport.value.history, f.backup.history);
    assert.deepEqual(reexport.value.runs, f.backup.runs);
    assert.equal(f.calls(), 2);
  },
);

test(
  "restore keeps legacy optional fields, shared correlation IDs, project and protocol namespaces",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      backup = structuredClone(f.backup);
    for (const record of [...backup.history, ...backup.runs]) {
      delete record.source;
      delete record.durationMs;
      record.runId = "shared-correlation-not-record-identity";
    }
    // Historical IDs are opaque nonempty strings, not normalized identifiers.
    backup.history[0].id = " \t ";
    backup.runs[0].id = "原有记录";
    const protocol = await f.protocol();
    protocol.id = backup.history[0].id;
    backup.protocolRuns = [protocol];
    const first = await f.owner("/api/restore", { document: backup });
    const second = await f.owner("/api/restore", { document: backup });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.value.id, second.value.id);
    await f.restart();
    await assertReadable(f, first.value.id, backup);
    await assertReadable(f, second.value.id, backup);
    for (const projectId of [first.value.id, second.value.id])
      assert.deepEqual((await f.store().get(projectId)).protocolRuns, [
        protocol,
      ]);
    assert.equal(f.calls(), 3);
  },
);

test(
  "restore preserves first-50 retention while old ambiguous disk remains readable and fails detail safely",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      backup = structuredClone(f.backup);
    for (const field of ["history", "runs"])
      backup[field] = Array.from({ length: 51 }, (_, i) => ({
        ...backup[field][0],
        id: `${field}-${i}`,
      }));
    const restored = await f.owner("/api/restore", { document: backup });
    assert.equal(restored.status, 201);
    const retained = await new Store(f.root).get(restored.value.id);
    for (const field of ["history", "runs"])
      assert.deepEqual(retained[field], backup[field].slice(0, 50));
    // Existing on-disk data remains inspectable; never rewrite IDs or poison a
    // project's unrelated config access just because old evidence is ambiguous.
    const old = await f.store().get(f.project.id);
    old.history.push(structuredClone(old.history[0]));
    await f.store().save(old, { activity: true });
    await f.restart();
    assert.equal((await f.store().get(old.id)).history.length, 2);
    const client = await f.sdk(old.id);
    const response = await result(client, old.id, old.history[0].id);
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /不唯一/);
    assert.equal(f.calls(), 2);
  },
);
