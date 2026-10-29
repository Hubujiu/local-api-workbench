import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";
test("MCP covers project/environment/service/global lifecycle and plan CRUD with scoped grants", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-expanded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const projects = [];
  const d = createMCP({ store, projects, write: true, execute: true });
  const call = async (name, args = {}) => {
    const r = await d({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "localapi_" + name, arguments: args },
    });
    assert(!r.result.isError, r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  };
  const list = await d({ id: 1, method: "tools/list" });
  assert.equal(list.result.tools.length, 42);
  const toolNames = new Set(list.result.tools.map((tool) => tool.name));
  assert.equal(toolNames.size, 42);
  assert(toolNames.has("localapi_list_imported_execution_runs"));
  assert(toolNames.has("localapi_get_imported_execution_run"));
  assert(toolNames.has("localapi_list_protocol_runs"));
  assert(toolNames.has("localapi_get_protocol_run"));
  const detail = list.result.tools.find(
    (tool) => tool.name === "localapi_get_protocol_run",
  );
  assert.deepEqual(detail.inputSchema.required, ["projectId", "recordId"]);
  assert.equal(detail.inputSchema.additionalProperties, false);
  assert(list.result.tools.some((t) => t.name === "localapi_create_project"));
  for (const name of [
    "localapi_list_grpc_definitions",
    "localapi_get_grpc_definition",
    "localapi_list_socketio_definitions",
    "localapi_get_socketio_definition",
  ])
    assert(list.result.tools.some((t) => t.name === name));
  const p = await call("create_project", { name: "MCP project" });
  assert(projects.includes(p.id));
  const env = await call("create_environment", {
    projectId: p.id,
    name: "QA",
    baseUrl: "http://localhost",
  });
  await call("switch_environment", { projectId: p.id, environmentId: env.id });
  await call("upsert_global_variable", {
    projectId: p.id,
    key: "token",
    value: "fixture",
  });
  await call("upsert_environment_variable", {
    projectId: p.id,
    environmentId: env.id,
    key: "token",
    value: "qa",
  });
  const vars = await call("get_environment_variables", {
    projectId: p.id,
    environmentId: env.id,
  });
  assert.equal(vars.effectiveVariables.token, "qa");
  const service = await call("create_environment_server", {
    projectId: p.id,
    environmentId: env.id,
    name: "Backend",
    url: "http://127.0.0.1:12345",
  });
  assert.equal(
    (
      await call("list_environment_servers", {
        projectId: p.id,
        environmentId: env.id,
      })
    ).servers[0].id,
    service.id,
  );
  const plan = await call("create_execution_flow", {
    projectId: p.id,
    plan: { name: "Flow", description: "human-readable", steps: [] },
  });
  assert.equal(plan.description, "human-readable");
  assert.equal(
    (await call("get_execution_flow", { projectId: p.id, planId: plan.id })).id,
    plan.id,
  );
  await call("delete_execution_flow", {
    projectId: p.id,
    planId: plan.id,
    confirm: true,
  });
  assert.equal(
    (await call("list_execution_flows", { projectId: p.id })).length,
    0,
  );
  const denied = createMCP({ store, projects, write: false });
  const result = await denied({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_upsert_global_variable",
      arguments: { projectId: p.id, key: "x", value: 1 },
    },
  });
  assert.equal(result.result.isError, true);
  const invalid = await d({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_delete_environment",
      arguments: { projectId: p.id, environmentId: "absent" },
    },
  });
  assert.equal(invalid.result.isError, true);
});

test("MCP HTTP execution uses selected service/global variables and exposes runtime extraction", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { manageEnvironment } = await import("../src/environments.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-execute-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Execution");
  const service = manageEnvironment(p, "create_environment_server", {
    name: "Fixture",
    url: app.url,
  });
  p.globalVariables = { auth: "global-fixture" };
  p.requests = [
    {
      id: "fixture",
      name: "Fixture",
      method: "GET",
      serviceId: service.id,
      url: "/mock/" + p.id + "/fixture",
      examples: [{ status: 200, body: '{"token":"runtime-fixture"}' }],
      headers: [{ key: "x-fixture", value: "{{auth}}" }],
      extract: [{ name: "issuedToken", path: "$.token" }],
    },
  ];
  await app.store.save(p);
  const enabled = await (
    await fetch(app.url + "/api/mcp/config", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        projects: [p.id],
        write: true,
        execute: true,
      }),
    })
  ).json();
  const call = async (name, args) => {
    const r = await (
      await fetch(app.url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + enabled.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "localapi_" + name, arguments: args },
        }),
      })
    ).json();
    assert(!r.result.isError, r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  };
  const run = await call("execute_api", { projectId: p.id, apiId: "fixture" });
  assert.equal(run.status, "passed");
  assert.equal(
    run.results[0].request.url,
    app.url + "/mock/" + p.id + "/fixture",
  );
  assert.equal(run.results[0].request.headers[0].value, "global-fixture");
  const vars = await call("get_environment_variables", { projectId: p.id });
  assert.equal(vars.runtimeVariables.issuedToken, "runtime-fixture");
  const fresh = await call("create_project", { name: "Created through HTTP" });
  assert(
    (await call("list_projects", {})).some(
      (project) => project.id === fresh.id,
    ),
  );
  assert(
    (await call("list_environments", { projectId: fresh.id })).environments
      .length === 1,
  );
});

test("MCP plan execution reports ordered progress and preserves final evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createApp } = await import("../src/server.mjs");
  const app = await createApp({ root, port: 0 });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const p = await app.store.create("Progress");
  const req = {
    id: "r",
    name: "Mock",
    method: "GET",
    url: app.url + "/mock/" + p.id + "/r",
    examples: [{ status: 200, body: "{}" }],
  };
  p.requests = [req];
  await app.store.save(p);
  const events = [],
    d = createMCP({
      store: app.store,
      projects: [p.id],
      write: true,
      execute: true,
      onProgress: (event) => events.push(event),
    });
  const call = async (name, args) => {
    const r = await d({
      id: 1,
      method: "tools/call",
      params: { name: "localapi_" + name, arguments: args },
    });
    assert(!r.result.isError, r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  };
  const plan = await call("create_execution_flow", {
    projectId: p.id,
    plan: { name: "Two steps", steps: [{ request: req }, { request: req }] },
  });
  assert.equal(plan.provenance.fields.name, "ai");
  const result = await call("execute_flow", {
    projectId: p.id,
    planId: plan.id,
  });
  assert.equal(result.status, "passed");
  const summaries = await call("list_execution_runs", {
    projectId: p.id,
    scope: "flow",
    source: "mcp",
    planId: plan.id,
  });
  assert.equal(summaries[0].id, result.id);
  assert(Number.isFinite(summaries[0].durationMs));
  assert.equal(summaries[0].failedStepCount, 0);
  assert.deepEqual(
    events.map((event) => event.completed),
    [1, 2],
  );
  assert(events.every((event) => event.total === 2));
});
