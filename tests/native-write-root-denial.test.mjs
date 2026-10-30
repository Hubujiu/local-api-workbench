// Integrated-root boundaries via owner HTTP and official SDK, not fake executors.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";

const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
async function fixture(t) {
  const requests = [],
    sockets = [];
  let connections = 0;
  const upstream = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const redis = net.createServer((socket) => {
    connections++;
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", () => socket.write("+OK\r\n"));
  });
  await new Promise((resolve) => redis.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "native-root-denial-"));
  const app = await createApp({ root, port: 0 });
  const client = new Client(
    { name: "native-root-denial", version: "1" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close().catch(() => {});
    app.server.closeAllConnections();
    await app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => redis.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Nested native write boundary");
  const url = "http://127.0.0.1:" + upstream.address().port;
  const write = normalizeRequest({
    id: "write-api",
    name: "Inert SET",
    url: url + "/write-http",
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [
        {
          id: "write-script",
          type: "customScript",
          enabled: 1,
          data:
            "pm.sendRequest(" +
            JSON.stringify(url + "/write-script") +
            ',()=>{});pm.environment.set("forbidden_script","ran");',
        },
        {
          id: "set",
          type: "database",
          enabled: 1,
          data: {
            connectionId: bindingId,
            query: '["SET","fixture","value"]',
            writeIntent: "redis-set",
            resultShape: "redis-value",
            variables: [],
            isConsoleOutput: -1,
          },
        },
      ],
      after: [],
    },
  });
  const first = normalizeRequest({
    id: "earlier-api",
    name: "Earlier unrelated request",
    url: url + "/earlier-http",
    inheritSharedScripts: false,
    beforeScript:
      "pm.sendRequest(" + JSON.stringify(url + "/earlier-script") + ",()=>{});",
  });
  const readonly = normalizeRequest({
    id: "readonly-api",
    name: "Unrelated read-only HTTP",
    url: url + "/readonly-http",
    inheritSharedScripts: false,
  });
  project.requests = [write, first, readonly];
  project.settings.apipostDatabases = [
    {
      id: bindingId,
      name: "Source",
      type: "redis",
      sourceProjectId: "fictional-source",
      sourceId: "database",
    },
  ];
  await app.store.save(project);
  const base = "/api/projects/" + project.id;
  async function owner(path, body) {
    const response = await fetch(app.url + path, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const config = await owner("/api/mcp/config", {
    enabled: true,
    projects: [project.id],
    write: true,
    execute: true,
    remember: false,
  });
  assert.equal(config.status, 200, JSON.stringify(config));
  const readTarget = {
    name: "Read-only runtime configuration",
    type: "redis",
    host: "127.0.0.1",
    port: redis.address().port,
    database: "0",
    bindingId,
  };
  for (const route of ["database-connections", "mcp-database-connections"]) {
    const granted = await owner(base + "/" + route, readTarget);
    assert.equal(granted.status, 200, JSON.stringify(granted));
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + config.data.token },
      },
    }),
  );
  const names = new Set(
    (await client.listTools()).tools.map((tool) => tool.name),
  );
  for (const name of [
    "localapi_run_plan",
    "localapi_execute_api",
    "apipost_execute_flow",
    "apipost_execute_api",
  ])
    assert(names.has(name), "test must invoke a real enabled tool: " + name);
  async function savePlan(steps) {
    const current = await app.store.get(project.id);
    const plan = snapshotPlan({
      id: "plan",
      name: "Nested write boundary",
      steps,
    });
    current.plans = [plan];
    await app.store.save(current);
    return plan;
  }
  return {
    app,
    client,
    project,
    base,
    owner,
    write,
    first,
    readonly,
    requests,
    savePlan,
    databaseConnections: () => connections,
    call: (name, args) => client.callTool({ name, arguments: args }),
  };
}
const group = (id, steps, enabled = true) => ({
  id,
  type: "repeat",
  count: 2,
  enabled,
  steps,
});
const leaf = (id, request) => ({ id, request });
async function noEffects(f) {
  assert.deepEqual(
    f.requests,
    [],
    "whole plan preflight occurs before any earlier HTTP or script callback",
  );
  assert.equal(
    f.databaseConnections(),
    0,
    "even AUTH/SELECT connection effects are forbidden",
  );
  const current = await f.app.store.get(f.project.id);
  assert.equal(current.environments[0].variables.forbidden_script, undefined);
}

test(
  "root enabled nested repeat SET rejects complete plan before preceding HTTP/script on owner and canonical/native SDK routes",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    await f.savePlan([
      leaf("earlier", f.first),
      group("outer", [group("inner", [leaf("write", f.write)])]),
    ]);
    const owner = await f.owner(f.base + "/run", { planId: "plan" });
    assert.equal(owner.status, 400, JSON.stringify(owner));
    await noEffects(f);
    for (const [name, args] of [
      ["localapi_run_plan", { projectId: f.project.id, planId: "plan" }],
      ["apipost_execute_flow", { project_id: f.project.id, flow_id: "plan" }],
    ]) {
      const result = await f.call(name, args);
      assert.equal(result.isError, true, JSON.stringify(result));
      await noEffects(f);
    }
  },
);

for (const disabled of ["outer", "inner"]) {
  test(
    `root disabled ${disabled} repeat ancestor suppresses SET without denying unrelated read-only HTTP`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      await f.savePlan([
        group(
          "outer",
          [group("inner", [leaf("write", f.write)], disabled !== "inner")],
          disabled !== "outer",
        ),
        leaf("readonly", f.readonly),
      ]);
      const owner = await f.owner(f.base + "/run", { planId: "plan" });
      assert.equal(owner.status, 200, JSON.stringify(owner));
      assert.equal(owner.data.status, "passed", JSON.stringify(owner));
      assert.deepEqual(
        owner.data.results.map((result) => result.stepId),
        ["readonly"],
      );
      const canonical = await f.call("localapi_run_plan", {
        projectId: f.project.id,
        planId: "plan",
      });
      assert.notEqual(canonical.isError, true, JSON.stringify(canonical));
      assert.equal(JSON.parse(canonical.content[0].text).status, "passed");
      // Native aliases have always rejected canonical repeat definitions,
      // including disabled groups. Preserve that separate capability boundary.
      const native = await f.call("apipost_execute_flow", {
        project_id: f.project.id,
        flow_id: "plan",
      });
      assert.equal(native.isError, true, JSON.stringify(native));
      assert.deepEqual(f.requests, ["/readonly-http", "/readonly-http"]);
      assert.equal(f.databaseConnections(), 0);
      assert.equal(
        (await f.app.store.get(f.project.id)).environments[0].variables
          .forbidden_script,
        undefined,
      );
    },
  );
}

test(
  "root native single-request and flat-flow SDK aliases cannot promote MCP read grant plus write/execute to SET authority",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    await f.savePlan([leaf("earlier", f.first), leaf("write", f.write)]);
    for (const [name, args] of [
      ["localapi_execute_api", { projectId: f.project.id, apiId: f.write.id }],
      [
        "apipost_execute_api",
        { project_id: f.project.id, target_id: f.write.id },
      ],
      ["apipost_execute_flow", { project_id: f.project.id, flow_id: "plan" }],
    ]) {
      const result = await f.call(name, args);
      assert.equal(result.isError, true, JSON.stringify(result));
      await noEffects(f);
    }
  },
);
