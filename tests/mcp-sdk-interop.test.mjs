import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
const client = () =>
  new Client(
    { name: "workbench-interop-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

test(
  "official MCP SDK negotiates HTTP, discovers tools, respects grants and rejects revoked tokens",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-sdk-http-"));
    const app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const allowed = await app.store.create("SDK allowed"),
      denied = await app.store.create("SDK denied");
    const configure = async (options = {}) => {
      const r = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          projects: [allowed.id],
          write: false,
          execute: false,
          remember: false,
          ...options,
        }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const connect = async (token) => {
      const c = client();
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      assert.equal(c.getServerVersion().name, "local-api-workbench");
      return c;
    };
    const first = await configure();
    const c = await connect(first.token);
    await c.ping();
    const tools = await c.listTools();
    assert(tools.tools.some((x) => x.name === "localapi_list_projects"));
    assert(!tools.tools.some((x) => x.name === "localapi_execute_api"));
    const projects = decode(
      await c.callTool({ name: "localapi_list_projects", arguments: {} }),
    );
    assert.deepEqual(
      projects.map((p) => p.id),
      [allowed.id],
    );
    assert.equal(
      (
        await c.callTool({
          name: "localapi_list_apis",
          arguments: { projectId: denied.id },
        })
      ).isError,
      true,
    );
    const rotated = await configure({ rotate: true });
    assert.notEqual(rotated.token, first.token);
    await assert.rejects(c.listTools(), /403|unauthorized/i);
    const replacement = await connect(rotated.token);
    assert((await replacement.listTools()).tools.length > 0);
    allowed.requests = [
      {
        id: "sdk-fixture",
        name: "SDK fixture",
        method: "GET",
        url: app.url + "/mock/" + allowed.id + "/sdk-fixture",
        examples: [{ status: 200, body: '{"sdk":true}' }],
      },
    ];
    await app.store.save(allowed);
    await configure({ write: true, execute: true });
    assert(
      (await replacement.listTools()).tools.some(
        (x) => x.name === "localapi_execute_api",
      ),
    );
    const result = decode(
      await replacement.callTool({
        name: "localapi_execute_api",
        arguments: { projectId: allowed.id, apiId: "sdk-fixture" },
      }),
    );
    assert.equal(result.status, "passed");
    assert.equal(result.results[0].response.status, 200);
    const summaries = decode(
      await replacement.callTool({
        name: "localapi_list_execution_runs",
        arguments: {
          projectId: allowed.id,
          scope: "api",
          source: "mcp",
          status: "passed",
          limit: 1,
        },
      }),
    );
    assert.equal(summaries[0].id, result.id);
    assert.equal(summaries[0].scope, "api");
    assert(Number.isFinite(summaries[0].durationMs));
    assert.equal(Object.hasOwn(summaries[0], "response"), false);
    const detail = decode(
      await replacement.callTool({
        name: "localapi_get_execution_result",
        arguments: { projectId: allowed.id, runId: result.id },
      }),
    );
    assert.equal(detail.response.status, 200);
    assert.equal(detail.source, "mcp");
    assert.equal(
      (
        await replacement.callTool({
          name: "localapi_list_execution_runs",
          arguments: { projectId: allowed.id, limit: 0 },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await replacement.callTool({
          name: "localapi_get_execution_result",
          arguments: { projectId: denied.id, runId: result.id },
        })
      ).isError,
      true,
    );

    const invokeFlowTool = async (name, args) =>
      decode(
        await replacement.callTool({
          name: "localapi_" + name,
          arguments: { projectId: allowed.id, ...args },
        }),
      );
    const defaultEnvironmentId = allowed.environments[0].id;
    const alternate = await invokeFlowTool("create_environment", {
      name: "SDK alternate environment",
    });
    await invokeFlowTool("switch_environment", {
      environmentId: defaultEnvironmentId,
    });
    await invokeFlowTool("upsert_environment_variable", {
      environmentId: defaultEnvironmentId,
      key: "selection",
      value: "default",
    });
    await invokeFlowTool("upsert_environment_variable", {
      environmentId: alternate.id,
      key: "selection",
      value: "alternate",
    });
    const flow = await invokeFlowTool("create_execution_flow", {
      plan: {
        name: "SDK environment override",
        environmentId: defaultEnvironmentId,
        steps: [
          {
            request: {
              ...allowed.requests[0],
              headers: [{ key: "x-selection", value: "{{selection}}" }],
              beforeScript: 'pm.environment.set("touched","yes");',
            },
          },
        ],
      },
    });
    const overridden = await invokeFlowTool("execute_flow", {
      planId: flow.id,
      environmentId: alternate.id,
    });
    assert.equal(overridden.status, "passed");
    assert.equal(overridden.environmentId, alternate.id);
    assert.equal(
      overridden.results[0].request.headers.find(
        (row) => row.key === "x-selection",
      ).value,
      "alternate",
    );
    const persistedOverride = await app.store.get(allowed.id);
    assert.equal(persistedOverride.currentEnvironmentId, defaultEnvironmentId);
    assert.equal(
      persistedOverride.plans.find((plan) => plan.id === flow.id).environmentId,
      defaultEnvironmentId,
    );
    assert.equal(
      persistedOverride.environments.find((env) => env.id === alternate.id)
        .variables.touched,
      "yes",
    );
    assert.equal(
      persistedOverride.environments.find(
        (env) => env.id === defaultEnvironmentId,
      ).variables.touched,
      undefined,
    );
    const defaultRun = await invokeFlowTool("execute_flow", {
      planId: flow.id,
    });
    assert.equal(defaultRun.environmentId, defaultEnvironmentId);
    assert.equal(
      defaultRun.results[0].request.headers.find(
        (row) => row.key === "x-selection",
      ).value,
      "default",
    );
    const runCount = (await app.store.get(allowed.id)).runs.length;
    const invalidEnvironment = await replacement.callTool({
      name: "localapi_execute_flow",
      arguments: {
        projectId: allowed.id,
        planId: flow.id,
        environmentId: "missing-environment",
      },
    });
    assert.equal(invalidEnvironment.isError, true);
    assert.equal((await app.store.get(allowed.id)).runs.length, runCount);
    const rejectedDelete = await replacement.callTool({
      name: "localapi_delete_execution_flow",
      arguments: { projectId: allowed.id, planId: flow.id, confirm: false },
    });
    assert.equal(rejectedDelete.isError, true);
    assert.equal(
      (await invokeFlowTool("get_execution_flow", { planId: flow.id })).id,
      flow.id,
    );
    await invokeFlowTool("delete_execution_flow", {
      planId: flow.id,
      confirm: true,
    });
    assert.equal(
      (await invokeFlowTool("get_execution_result", { runId: defaultRun.id }))
        .id,
      defaultRun.id,
    );
    await configure({ enabled: false });
    await assert.rejects(replacement.listTools(), /403|unauthorized/i);
  },
);

test(
  "official MCP SDK stdio transport initializes a real subprocess with read-only project isolation",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-sdk-stdio-"));
    const store = new Store(root);
    await store.init();
    const allowed = await store.create("SDK stdio allowed"),
      denied = await store.create("SDK stdio denied");
    const c = client();
    t.after(async () => {
      await c.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          allowed.id,
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    );
    assert.equal(c.getServerVersion().name, "local-api-workbench");
    await c.ping();
    assert(
      !(await c.listTools()).tools.some(
        (x) => x.name === "localapi_create_project",
      ),
    );
    assert.deepEqual(
      decode(
        await c.callTool({ name: "localapi_list_projects", arguments: {} }),
      ).map((p) => p.id),
      [allowed.id],
    );
    assert.equal(
      (
        await c.callTool({
          name: "localapi_list_apis",
          arguments: { projectId: denied.id },
        })
      ).isError,
      true,
    );
  },
);
