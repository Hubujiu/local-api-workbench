// Application, network and SDK workflows run in ordinary CI, not during local authoring.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import {
  importDocument,
  importIntoProject,
  exportOpenAPI,
} from "../src/core.mjs";
import { syncMCPOpenAPI } from "../src/mcp-openapi-sync.mjs";

const named = (location, name, type, value, fallback) => ({
  in: location,
  name,
  schema: { type, ...(fallback === undefined ? {} : { default: fallback }) },
  examples: { only: { summary: "Selected fixture", value } },
  ...(location === "query" && value === "" ? { allowEmptyValue: true } : {}),
});
function document(origin) {
  const flag = named("query", "flag", "boolean", false, true);
  flag.examples.only = { $ref: "#/components/examples/Off" };
  return {
    openapi: "3.0.3",
    info: { title: "Scalar values", version: "1" },
    servers: [{ url: origin }],
    components: {
      examples: {
        Off: { value: false, "x-literal": { $ref: "not a reference" } },
      },
      parameters: { ZeroHeader: named("header", "X-Zero", "integer", 0, 7) },
    },
    paths: {
      "/probe": {
        parameters: [named("query", "zero", "integer", 8)],
        get: {
          operationId: "scalarValues",
          parameters: [
            flag,
            named("query", "zero", "integer", 0, 7),
            named("query", "empty", "string", "", "fallback"),
            {
              in: "query",
              name: "text",
              schema: { type: "string", example: "one &+/%" },
            },
            {
              in: "query",
              name: "default",
              schema: { type: "boolean", default: false },
            },
            { $ref: "#/components/parameters/ZeroHeader" },
            named("header", "X-Empty", "string", "", "fallback"),
            {
              in: "header",
              name: "X-Default",
              schema: { type: "boolean", default: false },
            },
            named("cookie", "flag", "boolean", false, true),
            {
              in: "cookie",
              name: "zero",
              schema: { type: "integer", example: 0 },
            },
            named("cookie", "empty", "string", "", "fallback"),
          ],
          responses: { 200: { description: "Echo" } },
        },
      },
    },
  };
}
const expected = {
  // Path-level zero is overridden in place, so it remains the first query row.
  url: "/probe?zero=0&flag=false&empty=&text=one+%26%2B%2F%25&default=false",
  zero: "0",
  empty: "",
  fallback: "false",
  cookie: "flag=false; zero=0; empty=",
};
function rows(request) {
  return Object.fromEntries(
    ["query", "headers", "cookies"].map((key) => [
      key,
      request[key].map(({ key, value, schema }) => ({ key, value, schema })),
    ]),
  );
}
function decode(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
function runBody(run) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.results.length, 1);
  return JSON.parse(run.results[0].response.body);
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function files(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await files(file)
      : (await readFile(file)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scalar-values-")),
    seen = [],
    clients = [];
  const echo = http.createServer((req, res) => {
    const value = {
      url: req.url,
      zero: req.headers["x-zero"],
      empty: req.headers["x-empty"],
      fallback: req.headers["x-default"],
      cookie: req.headers.cookie,
    };
    seen.push(value);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await close(app.server);
    await close(echo);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    clients,
    seen,
    origin: `http://127.0.0.1:${echo.address().port}`,
    get app() {
      return app;
    },
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
    async call(url, method = "GET", body, status = 200) {
      const response = await fetch(app.url + url, {
        method,
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    },
  };
}

test("scalar examples preserve typed rows and real wire through owner cURL OpenAPI backup restart frozen plans and scoped MCP", async (t) => {
  const f = await fixture(t),
    source = document(f.origin),
    sourceBefore = structuredClone(source);
  let project = await f.call(
    "/api/projects",
    "POST",
    { name: "Scalar values" },
    201,
  );
  const url = "/api/projects/" + project.id;
  project = await f.call(url + "/import", "POST", { document: source });
  assert.deepEqual(source, sourceBefore);
  assert.equal(project.requests.length, 1);
  const request = project.requests[0],
    saved = rows(request);
  assert.deepEqual(
    saved.query.map((row) => row.value),
    [0, false, "", "one &+/%", false],
  );
  assert.deepEqual(
    saved.headers.map((row) => row.value),
    [0, "", false],
  );
  assert.deepEqual(
    saved.cookies.map((row) => row.value),
    [false, 0, ""],
  );
  const result = await f.call(url + "/execute", "POST", { request });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), expected);
  const { curl } = await f.call(url + "/curl", "POST", { request });
  assert(curl.includes(f.origin + expected.url));
  assert(curl.includes("'x-zero: 0'"));
  assert(curl.includes("'x-empty;'"));
  assert(curl.includes("'x-default: false'"));
  assert(curl.includes("'cookie: " + expected.cookie + "'"));
  const exported = await f.call(url + "/export?format=openapi");
  for (const parameter of exported.paths["/probe"].get.parameters) {
    const group =
      parameter.in === "header"
        ? "headers"
        : parameter.in === "cookie"
          ? "cookies"
          : "query";
    assert.equal(
      parameter.example,
      saved[group].find((row) => row.key === parameter.name).value,
    );
    assert.equal(Object.hasOwn(parameter, "examples"), false);
  }
  let fresh = await f.call(
    "/api/projects",
    "POST",
    { name: "Fresh reimport" },
    201,
  );
  fresh = await f.call(`/api/projects/${fresh.id}/import`, "POST", {
    document: exported,
  });
  assert.deepEqual(rows(fresh.requests[0]), saved);
  assert.deepEqual(
    JSON.parse(
      (
        await f.call(`/api/projects/${fresh.id}/execute`, "POST", {
          request: fresh.requests[0],
        })
      ).body,
    ),
    expected,
  );
  const plan = await f.call(url + "/plans", "POST", {
    name: "Frozen values",
    steps: [{ request }],
  });
  project = await f.call(url);
  project.requests[0].query[0].value = 99;
  await f.call(url, "PUT", project);
  await f.restart();
  assert.equal((await f.call(url)).requests[0].query[0].value, 99);
  assert.deepEqual(
    runBody(await f.call(url + "/run", "POST", { planId: plan.id })),
    expected,
  );
  const backup = await f.call(url + "/export"),
    restored = await f.call("/api/restore", "POST", { document: backup }, 201);
  assert.deepEqual(restored.requests, backup.requests);
  assert.deepEqual(restored.plans, backup.plans);
  assert.deepEqual(
    runBody(
      await f.call(`/api/projects/${restored.id}/run`, "POST", {
        planId: plan.id,
      }),
    ),
    expected,
  );
  const config = await f.call("/api/mcp/config", "POST", {
    enabled: true,
    projects: [project.id],
    write: true,
    execute: true,
    remember: false,
  });
  const client = new Client(
    { name: "scalar-values", version: "1" },
    { capabilities: {} },
  );
  f.clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert(tools.includes("localapi_sync_openapi"));
  assert(tools.includes("localapi_execute_api"));
  const synced = decode(
    await client.callTool({
      name: "localapi_sync_openapi",
      arguments: { projectId: project.id, document: source },
    }),
  );
  assert.equal(synced.length, 1);
  const before = await f.call(url);
  assert.deepEqual(rows(before.requests[0]), saved);
  const executed = decode(
    await client.callTool({
      name: "localapi_execute_api",
      arguments: {
        projectId: project.id,
        apiId: before.requests[0].id,
        input: { query: { zero: 2, flag: true } },
      },
    }),
  );
  assert.deepEqual(runBody(executed), {
    ...expected,
    url: expected.url.replace("zero=0&flag=false", "zero=2&flag=true"),
  });
  assert.deepEqual((await f.call(url)).requests, before.requests);
  const denied = await client.callTool({
    name: "localapi_execute_api",
    arguments: { projectId: fresh.id, apiId: fresh.requests[0].id },
  });
  assert.equal(denied.isError, true);
});

test("malformed scalar selections reject whole owner and HTTP/stdio MCP batches without changing source project or saved bytes", async (t) => {
  const f = await fixture(t),
    source = document(f.origin);
  let project = await f.call(
    "/api/projects",
    "POST",
    { name: "Atomic scalar values" },
    201,
  );
  const url = "/api/projects/" + project.id;
  project = await f.call(url + "/import", "POST", { document: source });
  const invalid = [];
  for (const location of ["query", "header", "cookie"])
    for (const extra of [
      { examples: { one: { value: false }, two: { value: true } } },
      {
        examples: {
          one: { externalValue: "https://example.invalid/never-fetch" },
        },
      },
      { examples: { one: {} } },
      { example: false, examples: { one: { value: false } } },
      { example: null },
      { example: {} },
      { example: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const doc = document(f.origin);
      doc.paths["/last"] = {
        get: {
          parameters: [
            {
              in: location,
              name: "invalid",
              schema: { type: "boolean", default: true },
              ...extra,
            },
          ],
          responses: { 200: { description: "Never sent" } },
        },
      };
      invalid.push(doc);
    }
  const config = await f.call("/api/mcp/config", "POST", {
    enabled: true,
    projects: [project.id],
    write: true,
    execute: false,
    remember: false,
  });
  const before = await f.call(url),
    disk = await files(f.app.store.directory(project.id));
  for (const doc of invalid) {
    const sourceBefore = structuredClone(doc);
    const error = await f.call(url + "/import", "POST", { document: doc }, 400);
    assert.match(error.error, /OpenAPI标量参数/);
    for (const sync of [false, true]) {
      const p = structuredClone(before);
      assert.throws(
        () => importIntoProject(p, doc, { sync }),
        /OpenAPI标量参数/,
      );
      assert.deepEqual(p, before);
    }
    assert.deepEqual(doc, sourceBefore);
    assert.deepEqual(await f.call(url), before);
    assert.deepEqual(await files(f.app.store.directory(project.id)), disk);
  }
  for (const transport of [
    new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        project.id,
        "--write",
      ],
      env: { LOCAL_API_DATA: f.root },
      stderr: "pipe",
    }),
  ]) {
    const client = new Client(
      { name: "scalar-value-admission", version: "1" },
      { capabilities: {} },
    );
    f.clients.push(client);
    await client.connect(transport);
    assert(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "localapi_sync_openapi",
      ),
    );
    for (const coverMode of ["url_and_folder", "url", "ignore", "both"]) {
      const rejected = await client.callTool({
        name: "localapi_sync_openapi",
        arguments: { projectId: project.id, document: invalid[0], coverMode },
      });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /OpenAPI标量参数/);
      assert.deepEqual(await f.call(url), before);
      assert.deepEqual(await files(f.app.store.directory(project.id)), disk);
    }
  }
  assert.equal(f.seen.length, 0);
  // The accepted legacy projection remains unchanged; no reinterpretation of
  // persisted string rows or Swagger source parameters occurs in this slice.
  const legacy = importDocument({
    requests: [
      {
        url: f.origin + "/legacy",
        query: [{ key: "flag", value: "false", schema: { type: "boolean" } }],
      },
    ],
  })[0];
  assert.equal(legacy.query[0].value, "false");
  assert.equal(
    exportOpenAPI({ name: "Legacy", requests: [legacy] }).paths["/legacy"].get
      .parameters[0].example,
    "false",
  );
  const swagger = {
    swagger: "2.0",
    host: "example.test",
    paths: {
      "/old": {
        get: {
          parameters: [
            { in: "header", name: "X-Old", type: "boolean", default: false },
          ],
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
  assert.equal(importDocument(swagger)[0].headers[0].value, "");
  // Direct sync has the same detached-draft atomic boundary.
  const draft = structuredClone(before);
  assert.throws(
    () => syncMCPOpenAPI(draft, { document: invalid[0] }),
    /OpenAPI标量参数/,
  );
  assert.deepEqual(draft, before);
});
