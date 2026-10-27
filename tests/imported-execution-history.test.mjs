import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { importIntoProject } from "../src/core.mjs";
async function source() {
  const files = [];
  for (const [directory, prefix] of [
    ["directory/", ""],
    ["executions/", "executions/"],
  ]) {
    const root = new URL(
      "./fixtures/original-offline2/" + directory,
      import.meta.url,
    );
    for (const file of (await readdir(root, { recursive: true })).filter((p) =>
      p.endsWith(".json"),
    )) {
      const p = file.replaceAll("\\", "/");
      files.push({
        path: prefix + p,
        text: await readFile(new URL(p, root), "utf8"),
      });
    }
  }
  return { format: "apipost-offline-directory-v1", files };
}
const originalProject = "10f7386134404a";
test("HTTP and official SDK read original execution archives with explicit provenance, pagination and project isolation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imported-history-"));
  const app = await createApp({ root, port: 0 });
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("archive allowed"),
    denied = await app.store.create("archive denied");
  const doc = await source();
  importIntoProject(p, doc);
  importIntoProject(denied, doc);
  await app.store.save(p);
  await app.store.save(denied);
  const before = await app.store.get(p.id);
  assert.equal(before.runs.length, 0);
  const base = "/api/projects/" + p.id + "/imported-execution-runs";
  const request = async (url, expected = 200) => {
    const r = await fetch(app.url + url, {
      headers: { "x-local-token": app.token },
    });
    const body = await r.json();
    assert.equal(r.status, expected, JSON.stringify(body));
    return body;
  };
  assert.equal((await fetch(app.url + base)).status, 403);
  const first = await request(base + "?limit=1");
  assert.equal(first.total, 2);
  assert.equal(first.items.length, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.executedByWorkbench, false);
  assert.equal(first.items[0].provenance, "imported-apipost-archive");
  assert.equal(first.items[0].originalStatus, "failed");
  assert.equal(first.items[0].original, undefined);
  assert.equal(JSON.stringify(first).includes("native-roundtrip"), false);
  const second = await request(base + "?offset=1&limit=1");
  assert.equal(second.items[0].originalStatus, "passed");
  assert.equal(second.nextOffset, null);
  const runId = first.items[0].runId;
  const detail = await request(base + "/" + originalProject + "/" + runId);
  assert.equal(detail.executedByWorkbench, false);
  assert.equal(detail.artifactSha256, first.items[0].artifactSha256);
  assert.deepEqual(
    detail.original.steps.map((s) => s.status_code),
    [503, 200],
  );
  await request(base + "/" + originalProject + "/missing", 404);
  await request(base + "?limit=0", 400);
  await request(base + "?offset=-1", 400);
  await request(base + "?secret=ignored", 400);
  const configResponse = await fetch(app.url + "/api/mcp/config", {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      projects: [p.id],
      write: false,
      execute: false,
      remember: false,
    }),
  });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  client = new Client(
    { name: "original-history-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  const tools = await client.listTools();
  assert(
    tools.tools.some((t) => t.name === "localapi_list_imported_execution_runs"),
  );
  assert(!tools.tools.some((t) => t.name === "localapi_execute_flow"));
  const call = async (name, args) =>
    client.callTool({ name: "localapi_" + name, arguments: args });
  const list = await call("list_imported_execution_runs", {
    projectId: p.id,
    sourceProjectId: originalProject,
    limit: 1,
  });
  assert.notEqual(list.isError, true);
  assert.equal(JSON.parse(list.content[0].text).items[0].runId, runId);
  const read = await call("get_imported_execution_run", {
    projectId: p.id,
    sourceProjectId: originalProject,
    runId,
  });
  assert.notEqual(read.isError, true);
  assert.equal(JSON.parse(read.content[0].text).original.status, "failed");
  for (const args of [
    { projectId: denied.id, sourceProjectId: originalProject, runId },
    { projectId: p.id, sourceProjectId: "../invalid", runId },
    { projectId: p.id, sourceProjectId: originalProject, runId: "missing" },
  ])
    assert.equal(
      (await call("get_imported_execution_run", args)).isError,
      true,
    );
  assert.equal(
    (
      await call("list_imported_execution_runs", {
        projectId: p.id,
        limit: "100",
      })
    ).isError,
    true,
  );
  assert.equal(
    (await call("execute_flow", { projectId: p.id, planId: p.plans[0].id }))
      .isError,
    true,
  );
  assert.deepEqual(await app.store.get(p.id), before);
  assert.equal((await app.store.get(denied.id)).runs.length, 0);
});
