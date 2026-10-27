import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
test("official MCP SDK cannot inherit manual HTTP database grants for saved native plans", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "native-mcp-"));
  const app = await createApp({ root, port: 0 });
  const client = new Client(
    { name: "native-task-test", version: "1.0.0" },
    { capabilities: {} },
  );
  let count = 0;
  const echo = http.createServer((req, res) => {
    count++;
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("allowed"),
    foreign = await app.store.create("foreign");
  const filename = path.join(root, "fixture.db");
  new DatabaseSync(filename).close();
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const grant = await fetch(
    app.url + "/api/projects/" + p.id + "/database-connections",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "manual only", filename }),
    },
  ).then((r) => r.json());
  assert.ok(grant.id);
  const request = {
    url: `http://127.0.0.1:${echo.address().port}/`,
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [
        {
          type: "database",
          enabled: 1,
          data: {
            connectionId: grant.id,
            query: "SELECT 1 AS value",
            isConsoleOutput: -1,
            variables: [
              { name: "value", type: "environment", pattern: "$[0].value" },
            ],
          },
        },
      ],
      after: [],
    },
  };
  p.plans = [snapshotPlan({ id: "native", steps: [{ request }] })];
  await app.store.save(p);
  const config = await fetch(app.url + "/api/mcp/config", {
    method: "POST",
    headers,
    body: JSON.stringify({
      enabled: true,
      projects: [p.id],
      write: true,
      execute: true,
      remember: false,
    }),
  }).then((r) => r.json());
  assert.ok(config.token);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  assert.ok(
    (await client.listTools()).tools.some(
      (tool) => tool.name === "localapi_run_plan",
    ),
  );
  const result = await client.callTool({
    name: "localapi_run_plan",
    arguments: { projectId: p.id, planId: "native" },
  });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const run = JSON.parse(result.content[0].text);
  assert.equal(run.status, "failed");
  assert.match(run.results[0].error, /未授权/);
  assert.equal(count, 0);
  const other = await client.callTool({
    name: "localapi_run_plan",
    arguments: { projectId: foreign.id, planId: "native" },
  });
  assert.equal(other.isError, true);
  assert.equal(count, 0);
  const manual = await fetch(app.url + "/api/projects/" + p.id + "/execute", {
    method: "POST",
    headers,
    body: JSON.stringify({ request }),
  }).then((r) => r.json());
  assert.equal(manual.outcome, "passed", JSON.stringify(manual));
  assert.equal(manual.databaseQueries[0].status, "completed");
  assert.equal(count, 1);
  const again = await client.callTool({
    name: "localapi_run_plan",
    arguments: { projectId: p.id, planId: "native" },
  });
  assert.equal(JSON.parse(again.content[0].text).status, "failed");
  assert.equal(count, 1);
  const persisted = await app.store.get(p.id);
  assert.equal(
    persisted.runs.at(-1)?.status === "failed" ||
      persisted.runs[0]?.status === "failed",
    true,
  );
  assert.equal(JSON.stringify(persisted).includes(filename), false);
});
