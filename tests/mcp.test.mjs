import test from "node:test";
import assert from "node:assert/strict";
import { createMCP } from "../src/mcp.mjs";
const project = {
  id: "allowed",
  requests: [{ id: "r", name: "One", method: "GET", url: "http://localhost" }],
  plans: [],
  runs: [],
};
const store = {
  list: async () => [{ id: "allowed" }, { id: "denied" }],
  get: async () => structuredClone(project),
  save: async () => {},
};
const call = (name, args = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});
test("MCP advertises only granted capabilities", async () => {
  const dispatch = createMCP({ store, projects: ["allowed"] });
  const r = await dispatch({ id: 1, method: "tools/list" });
  assert(!r.result.tools.some((t) => t.name === "localapi_run_plan"));
  assert(!r.result.tools.some((t) => t.name === "localapi_sync_openapi"));
  assert.equal(
    (await dispatch(call("localapi_sync_openapi", { projectId: "allowed" })))
      .result.isError,
    true,
  );
});
test("MCP filters projects and denies cross-project reads", async () => {
  const d = createMCP({ store, projects: ["allowed"] });
  assert.equal(
    JSON.parse((await d(call("localapi_list_projects"))).result.content[0].text)
      .length,
    1,
  );
  assert.equal(
    (await d(call("localapi_list_apis", { projectId: "denied" }))).result
      .isError,
    true,
  );
  assert.equal(
    JSON.parse(
      (
        await d(
          call("localapi_get_api_detail", { projectId: "allowed", apiId: "r" }),
        )
      ).result.content[0].text,
    ).id,
    "r",
  );
});
test("MCP initialization and notification lifecycle", async () => {
  const d = createMCP({ store });
  assert.equal(
    (await d({ id: 2, method: "initialize" })).result.protocolVersion,
    "2025-06-18",
  );
  assert.equal(await d({ method: "notifications/initialized" }), null);
  assert.equal((await d({ id: 3, method: "nope" })).error.code, -32601);
});
test("authorized MCP sync updates existing interfaces rather than duplicating them", async () => {
  let value = {
    id: "allowed",
    requests: [],
    environments: [],
    plans: [],
    runs: [],
  };
  const store = {
    list: async () => [{ id: "allowed" }],
    get: async () => structuredClone(value),
    save: async (project) => {
      value = structuredClone(project);
    },
  };
  const dispatch = createMCP({ store, projects: ["allowed"], write: true });
  const document = {
    openapi: "3.0.3",
    paths: {
      "/ping": {
        get: { operationId: "ping", responses: { 200: { description: "OK" } } },
      },
    },
  };
  const first = await dispatch(
    call("localapi_sync_openapi", { projectId: "allowed", document }),
  );
  assert.equal(first.result.isError, undefined);
  const id = value.requests[0].id;
  const second = await dispatch(
    call("localapi_sync_openapi", { projectId: "allowed", document }),
  );
  assert.equal(second.result.isError, undefined);
  assert.equal(value.requests.length, 1);
  assert.equal(value.requests[0].id, id);
});

test("MCP tool arguments must be JSON objects, while omitted arguments remain valid", async () => {
  let reads = 0;
  const dispatch = createMCP({
    store: {
      ...store,
      list: async () => {
        reads++;
        return [];
      },
    },
  });
  for (const args of [null, false, true, 0, 1, "", [], [1]]) {
    const response = await dispatch(call("localapi_list_projects", args));
    assert.equal(response.result.isError, true, JSON.stringify(args));
    assert.match(response.result.content[0].text, /参数必须为对象/);
  }
  assert.equal(reads, 0);
  assert.equal(
    (
      await dispatch({
        id: 1,
        method: "tools/call",
        params: { name: "localapi_list_projects" },
      })
    ).result.isError,
    undefined,
  );
  assert.equal(
    (await dispatch(call("localapi_list_projects", {}))).result.isError,
    undefined,
  );
  assert.equal(reads, 2);
});

test("MCP inherited property names are unknown arguments and cannot reach mutations", async () => {
  let writes = 0;
  const dispatch = createMCP({
    store: {
      ...store,
      create: async () => {
        writes++;
        return { id: "created" };
      },
    },
    write: true,
  });
  for (const key of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    const args = JSON.parse(
      JSON.stringify({ name: "blocked" }).slice(0, -1) + ',"' + key + '":{}}',
    );
    const response = await dispatch(call("localapi_create_project", args));
    assert.equal(response.result.isError, true, key);
    assert.match(response.result.content[0].text, /未知参数/);
  }
  assert.equal(writes, 0);
});
