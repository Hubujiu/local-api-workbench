import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { createMCP } from "../src/mcp.mjs";

test("MCP destructive tools require explicit boolean confirmation without replacing write grants", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-confirm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const p = await store.create("Confirmation fixture"),
    envId = p.environments[0].id;
  p.requests = [
    {
      id: "request",
      name: "Fixture",
      method: "GET",
      url: "http://localhost/fixture",
    },
  ];
  p.plans = [{ id: "flow", name: "Flow", steps: [] }];
  p.environments.push({
    id: "alternate",
    name: "Alternate",
    variables: {},
    serverUrls: {},
  });
  p.environments[0].variables = { remove: "env", keep: "retained" };
  p.servers = [{ id: "server", name: "Fixture" }];
  p.environments[0].serverUrls = { server: "http://localhost" };
  p.globalVariables = { remove: "global", keep: "retained" };
  await store.save(p);
  const invoke = createMCP({ store, projects: [p.id], write: true });
  const call = (dispatch, name, args) =>
    dispatch({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "localapi_" + name,
        arguments: { projectId: p.id, ...args },
      },
    });
  const cases = [
    [
      "delete_apis",
      { apiIds: ["request"] },
      (p) => Boolean(p.requests.find((r) => r.id === "request")?.deletedAt),
    ],
    [
      "delete_environment",
      { environmentId: "alternate" },
      (p) => !p.environments.some((e) => e.id === "alternate"),
    ],
    [
      "delete_environment_server",
      { serverId: "server" },
      (p) => !p.servers.some((s) => s.id === "server"),
    ],
    [
      "delete_environment_variable",
      { environmentId: envId, key: "remove" },
      (p) => !Object.hasOwn(p.environments[0].variables, "remove"),
    ],
    [
      "delete_global_variable",
      { key: "remove" },
      (p) => !Object.hasOwn(p.globalVariables, "remove"),
    ],
    [
      "delete_execution_flow",
      { planId: "flow" },
      (p) => !p.plans.some((f) => f.id === "flow"),
    ],
  ];
  const catalog = (await invoke({ id: 2, method: "tools/list" })).result.tools;
  const readonly = createMCP({ store, projects: [p.id], write: false });
  for (const [name, args, removed] of cases) {
    const before = await store.get(p.id);
    for (const confirm of [undefined, false, "true", 1, null]) {
      const result = await call(invoke, name, {
        ...args,
        ...(confirm === undefined ? {} : { confirm }),
      });
      assert.equal(
        result.result.isError,
        true,
        `${name} must reject ${String(confirm)}`,
      );
      assert.deepEqual(await store.get(p.id), before);
    }
    assert.equal(
      (await call(readonly, name, { ...args, confirm: true })).result.isError,
      true,
    );
    const tool = catalog.find((t) => t.name === "localapi_" + name);
    assert(tool.inputSchema.required.includes("confirm"));
    assert.equal(tool.inputSchema.properties.confirm.const, true);
    const allowed = await call(invoke, name, { ...args, confirm: true });
    assert.notEqual(
      allowed.result.isError,
      true,
      allowed.result.content[0].text,
    );
    assert(removed(await store.get(p.id)), name);
  }
  const after = await store.get(p.id);
  assert.equal(after.globalVariables.keep, "retained");
  assert.equal(after.environments[0].variables.keep, "retained");
});
