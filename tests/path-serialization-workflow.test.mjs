// CI-only application/network workflow. Authoring checks are syntax/format only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { initializeQueryRuntime } from "../src/script-url-runtime.mjs";
const values = { simple: "中文/%!", label: 0, matrix: false };
const expected = {
  simple: "/simple/%E4%B8%AD%E6%96%87%2F%25%21",
  label: "/label/.0",
  matrix: "/matrix/;value=false",
};
function document(origin) {
  return {
    openapi: "3.0.3",
    info: { title: "Scalar path fixture", version: "1" },
    servers: [{ url: origin }],
    paths: Object.fromEntries(
      Object.entries(values).map(([style, value]) => [
        `/${style}/{value}`,
        {
          get: {
            operationId: style,
            parameters: [
              {
                in: "path",
                name: "value",
                required: true,
                style,
                explode: true,
                schema: { type: typeof value },
                example: value,
              },
            ],
            responses: { 200: { description: "echo" } },
          },
        },
      ]),
    ),
  };
}
async function close(server) {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
async function files(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const p = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await files(p)
      : (await readFile(p)).toString("base64");
  }
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scalar-path-")),
    seen = [],
    clients = [];
  const echo = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
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
    seen,
    clients,
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
function runURLs(run) {
  assert.equal(run.status, "passed", JSON.stringify(run));
  return run.results.map((item) => JSON.parse(item.response.body).url);
}
test("scalar paths preserve real wire URLs through owner execution cURL frozen plans restart export reimport backup and scoped MCP", async (t) => {
  const f = await fixture(t);
  let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Scalar paths" },
      201,
    ),
    url = "/api/projects/" + project.id;
  project = await f.call(url + "/import", "POST", {
    document: document(f.origin),
  });
  const savedRequests = structuredClone(project.requests);
  for (const request of project.requests) {
    const result = await f.call(url + "/execute", "POST", { request });
    assert.equal(result.status, 200);
    assert.equal(
      JSON.parse(result.body).url,
      expected[request.sourceOperationId],
    );
    const curl = await f.call(url + "/curl", "POST", { request });
    assert(curl.curl.includes(f.origin + expected[request.sourceOperationId]));
  }
  const exported = await f.call(url + "/export?format=openapi");
  for (const [style, value] of Object.entries(values)) {
    const parameter = exported.paths[`/${style}/{value}`].get.parameters[0];
    assert.equal(parameter.style, style);
    assert.equal(parameter.explode, true);
    assert.equal(parameter.example, value);
    assert.equal(parameter.schema.type, typeof value);
  }
  let roundtrip = await f.call(
    "/api/projects",
    "POST",
    { name: "Reimport" },
    201,
  );
  roundtrip = await f.call(`/api/projects/${roundtrip.id}/import`, "POST", {
    document: exported,
  });
  for (const request of roundtrip.requests) {
    const result = await f.call(
      `/api/projects/${roundtrip.id}/execute`,
      "POST",
      { request },
    );
    assert.equal(
      JSON.parse(result.body).url,
      expected[request.sourceOperationId],
    );
  }
  const plan = await f.call(url + "/plans", "POST", {
    name: "Frozen scalar paths",
    steps: savedRequests.map((request) => ({ request })),
  });
  project = await f.call(url);
  project.requests[0].path[0].value = "live-edited";
  project = await f.call(url, "PUT", project);
  await f.restart();
  assert.deepEqual(
    runURLs(await f.call(url + "/run", "POST", { planId: plan.id })),
    Object.values(expected),
  );
  const backup = await f.call(url + "/export"),
    restored = await f.call("/api/restore", "POST", { document: backup }, 201);
  assert.deepEqual(restored.requests, backup.requests);
  assert.deepEqual(restored.plans, backup.plans);
  assert.deepEqual(
    runURLs(
      await f.call(`/api/projects/${restored.id}/run`, "POST", {
        planId: plan.id,
      }),
    ),
    Object.values(expected),
  );
  const config = await f.call("/api/mcp/config", "POST", {
    enabled: true,
    projects: [project.id],
    execute: true,
    write: true,
    remember: false,
  });
  const client = new Client(
    { name: "scalar-path-workflow", version: "1" },
    { capabilities: {} },
  );
  f.clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  const executeTool = (await client.listTools()).tools.find(
    (tool) => tool.name === "localapi_execute_api",
  );
  assert(executeTool, "fixture requires the explicit write and execute grants");
  const before = await f.call(url),
    matrix = before.requests.find((r) => r.sourceOperationId === "matrix");
  const result = await client.callTool({
    name: executeTool.name,
    arguments: {
      projectId: project.id,
      apiId: matrix.id,
      input: { path: { value: true } },
    },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(runURLs(JSON.parse(result.content[0].text)), [
    "/matrix/;value=true",
  ]);
  assert.deepEqual((await f.call(url)).requests, before.requests);
  const count = f.seen.length,
    after = await f.call(url);
  for (const value of [
    { secret: "must not become path" },
    [false],
    null,
    "false",
  ]) {
    const rejected = await client.callTool({
      name: executeTool.name,
      arguments: {
        projectId: project.id,
        apiId: matrix.id,
        input: { path: { value } },
      },
    });
    assert.equal(rejected.isError, true);
  }
  assert.equal(f.seen.length, count);
  assert.deepEqual(await f.call(url), after);
});
test("scalar path errors are atomic and dynamic/template inputs are admitted before coercion", async (t) => {
  const f = await fixture(t);
  let project = await f.call(
      "/api/projects",
      "POST",
      { name: "Path boundary" },
      201,
    ),
    url = "/api/projects/" + project.id;
  project = await f.call(url + "/import", "POST", {
    document: document(f.origin),
  });
  const before = await f.call(url),
    disk = await files(f.app.store.directory(project.id));
  for (const change of [
    (p) => (p.requests[0].path[0].pathSerialization.version = 2),
    (p) => (p.requests[0].scriptURLMode = "sdk"),
    (p) => (p.requests[0].path[0].enabled = false),
    (p) => (p.requests[0].url = f.origin + "/prefix{value}"),
  ]) {
    const invalid = structuredClone(before);
    change(invalid);
    await f.call(url, "PUT", invalid, 400);
    assert.deepEqual(await f.call(url), before);
    assert.deepEqual(await files(f.app.store.directory(project.id)), disk);
  }
  for (const extra of [
    { style: "form" },
    { schema: { type: "array", items: { type: "string" } }, example: ["x"] },
    { required: false },
  ]) {
    const invalid = document(f.origin);
    Object.assign(invalid.paths["/simple/{value}"].get.parameters[0], extra);
    await f.call(url + "/import", "POST", { document: invalid }, 400);
    assert.deepEqual(await f.call(url), before);
    assert.deepEqual(await files(f.app.store.directory(project.id)), disk);
  }
  const sdk = structuredClone(project.requests[0]);
  sdk.scriptURLMode = "sdk";
  sdk.scriptURLRuntime = initializeQueryRuntime({ url: f.origin + "/safe" });
  await f.call(url + "/curl", "POST", { request: sdk }, 400);
  assert.equal(f.seen.length, 0);
  const matrix = structuredClone(
    project.requests.find((r) => r.sourceOperationId === "matrix"),
  );
  matrix.path[0].dynamic = { source: "fixed", value: true };
  let result = await f.call(url + "/execute", "POST", { request: matrix });
  assert.equal(JSON.parse(result.body).url, "/matrix/;value=true");
  delete matrix.path[0].dynamic;
  matrix.path[0].value = "{{flag}}";
  project = await f.call(url);
  project.environments[0].variables.flag = false;
  project = await f.call(url, "PUT", project);
  result = await f.call(url + "/execute", "POST", {
    request: matrix,
    environmentId: project.environments[0].id,
  });
  assert.equal(JSON.parse(result.body).url, "/matrix/;value=false");
  const count = f.seen.length;
  for (const value of [[true], { flag: true }, null]) {
    matrix.path[0].dynamic = { source: "fixed", value };
    const failed = await f.call(url + "/execute", "POST", { request: matrix });
    assert.equal(failed.outcome, "failed");
    assert.match(failed.error, /path/i);
  }
  delete matrix.path[0].dynamic;
  project = await f.call(url);
  project.environments[0].variables.flag = [false];
  await f.call(url, "PUT", project);
  const failed = await f.call(url + "/execute", "POST", {
    request: matrix,
    environmentId: project.environments[0].id,
  });
  assert.equal(failed.outcome, "failed");
  assert.match(failed.error, /path/i);
  assert.equal(f.seen.length, count);
  const unbound = document(f.origin);
  delete unbound.paths["/simple/{value}"].get.parameters[0].example;
  let target = await f.call("/api/projects", "POST", { name: "Unbound" }, 201);
  target = await f.call(`/api/projects/${target.id}/import`, "POST", {
    document: unbound,
  });
  const definition = await f.call(
    `/api/projects/${target.id}/export?format=openapi`,
  );
  assert.equal(
    Object.hasOwn(
      definition.paths["/simple/{value}"].get.parameters[0],
      "example",
    ),
    false,
  );
  const missing = await f.call(`/api/projects/${target.id}/execute`, "POST", {
    request: target.requests[0],
  });
  assert.equal(missing.outcome, "failed");
  assert.match(missing.error, /path/i);
  assert.equal(f.seen.length, count);
});
