import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { versionPlan } from "../src/plan-version.mjs";
const secret = "PRIVATE_MCP_RECEIPT_SENTINEL_19804";
const mcpPath = fileURLToPath(new URL("../src/mcp.mjs", import.meta.url));
const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const failed = (result) => {
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "MCP_LOAD_REPORT_READ_FAILED");
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "load-receipts-mcp-"));
  let hits = 0;
  const peer = http.createServer((req, res) => {
    hits++;
    res.setHeader("x-secret", secret);
    res.end(secret);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const p = await app.store.create(secret);
  const other = await app.store.create("other " + secret);
  const clients = [];
  async function closeClients() {
    for (const client of clients.splice(0)) await client.close();
  }
  t.after(async () => {
    await closeClients();
    await close(app.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  });
  async function owner(route, method = "GET", body) {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return response;
  }
  async function populate(projectId) {
    const request = {
      method: "GET",
      url: `http://127.0.0.1:${peer.address().port}/?secret=${secret}`,
      headers: [{ key: "x-secret", value: secret }],
    };
    const route = `/api/projects/${projectId}`;
    const single = await (
      await owner(route + "/load", "POST", {
        request,
        count: 1,
        concurrency: 1,
        persistReport: true,
      })
    ).json();
    const project = await app.store.get(projectId);
    project.plans = [
      versionPlan(
        undefined,
        { id: "p", name: secret, steps: [{ id: "s", name: secret, request }] },
        "manual",
        project,
      ),
    ];
    await app.store.save(project);
    const stream = await (
      await owner(route + "/staged-load", "POST", {
        planId: "p",
        schedule: {
          initialVUs: 1,
          stages: [{ durationSeconds: 10, targetVUs: 1 }],
          maxIterations: 1,
        },
        persistReport: true,
      })
    ).text();
    const terminal = stream
      .split("\n\n")
      .find((row) => row.startsWith("event: reportEnd\n"));
    const staged = JSON.parse(terminal.split("\n")[1].slice(6));
    assert.equal(single.recordSaved, true);
    assert.equal(staged.recordSaved, true);
    return (await (await owner(route + "/load-reports")).json()).records;
  }
  async function connect(kind) {
    const client = new Client(
      { name: "load-receipts-read-only", version: "1" },
      { capabilities: {} },
    );
    clients.push(client);
    let transport;
    if (kind === "http") {
      const config = await (
        await owner("/api/mcp/config", "POST", {
          enabled: true,
          projects: [p.id],
          write: false,
          execute: false,
          remember: false,
        })
      ).json();
      transport = new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      });
    } else
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpPath, "--project", p.id],
        env: { ...process.env, LOCAL_API_DATA: root },
        stderr: "pipe",
      });
    await client.connect(transport);
    return client;
  }
  return {
    get app() {
      return app;
    },
    p,
    other,
    populate,
    connect,
    get hits() {
      return hits;
    },
    restart: async () => {
      await closeClients();
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
const args = (projectId, recordId) => ({
  projectId,
  ...(recordId === undefined ? {} : { recordId }),
});
const call = (client, name, arguments_) =>
  client.callTool({ name: "localapi_" + name, arguments: arguments_ });
function publicRecord(record) {
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(JSON.stringify(record).includes("127.0.0.1"), false);
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "version",
      "id",
      "kind",
      "state",
      "startedAt",
      "finishedAt",
      "summary",
    ].sort(),
  );
  assert.equal(record.version, 1);
  assert.equal(record.state, "completed");
  for (const key of [
    "results",
    "steps",
    "request",
    "error",
    "responsePreview",
    "headers",
    "variables",
  ])
    assert.equal(Object.hasOwn(record.summary, key), false);
}
for (const kind of ["http", "stdio"]) {
  test(`official SDK ${kind} reads only owner opt-in load evidence across restart without executing or mutating`, async (t) => {
    const f = await fixture(t);
    const records = await f.populate(f.p.id);
    const foreign = await f.populate(f.other.id);
    const baseline = await f.app.store.get(f.p.id);
    assert.equal(f.hits, 4);
    for (const restart of [false, true]) {
      if (restart) await f.restart();
      const client = await f.connect(kind);
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      for (const name of [
        "localapi_list_load_reports",
        "localapi_get_load_report",
      ])
        assert.ok(names.includes(name));
      assert.deepEqual(names.filter((name) => /load/.test(name)).sort(), [
        "localapi_get_load_report",
        "localapi_list_load_reports",
      ]);
      for (const name of [
        "localapi_run_request",
        "localapi_run_plan",
        "localapi_create_request",
        "localapi_update_request",
      ])
        assert.equal(names.includes(name), false);
      const listing = decode(
        await call(client, "list_load_reports", args(f.p.id)),
      );
      assert.deepEqual(listing, {
        records: records.map(({ id, kind, state, startedAt, finishedAt }) => ({
          id,
          kind,
          state,
          startedAt,
          finishedAt,
        })),
      });
      for (const record of records) {
        const result = decode(
          await call(client, "get_load_report", args(f.p.id, record.id)),
        );
        assert.deepEqual(result, record);
        publicRecord(result);
      }
      failed(await call(client, "list_load_reports", args(f.other.id)));
      failed(
        await call(client, "get_load_report", args(f.other.id, foreign[0].id)),
      );
      failed(
        await call(client, "get_load_report", args(f.p.id, foreign[0].id)),
      );
      failed(
        await call(
          client,
          "get_load_report",
          args(f.p.id, "00000000-0000-0000-0000-000000000000"),
        ),
      );
      assert.equal(f.hits, 4);
      const after = await f.app.store.get(f.p.id);
      for (const key of ["loadRuns", "requests", "plans", "history", "runs"])
        assert.deepEqual(after[key], baseline[key]);
    }
  });
}

test("dispatch cancellation after a real receipt read suppresses result with fixed failure and no mutation", async (t) => {
  const f = await fixture(t);
  const records = await f.populate(f.p.id);
  const baseline = await f.app.store.get(f.p.id);
  const dispatch = createMCP({
    store: f.app.store,
    projects: [f.p.id],
    write: false,
    execute: false,
  });
  const original = f.app.store.get.bind(f.app.store);
  for (const name of ["list_load_reports", "get_load_report"]) {
    const controller = new AbortController();
    let reads = 0;
    f.app.store.get = async (...values) => {
      const result = await original(...values);
      reads++;
      controller.abort();
      return result;
    };
    const response = await dispatch(
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "localapi_" + name,
          arguments: args(
            f.p.id,
            name === "get_load_report" ? records[0].id : undefined,
          ),
        },
      },
      { signal: controller.signal },
    );
    assert.ok(reads > 0);
    failed(response.result);
  }
  f.app.store.get = original;
  assert.deepEqual((await original(f.p.id)).loadRuns, baseline.loadRuns);
  assert.equal(f.hits, 2);
});
