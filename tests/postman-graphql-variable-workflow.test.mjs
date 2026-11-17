import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { exportOpenAPI, toCurl } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

// Entirely fictional local HTTP fixture. No GraphQL service or original client
// is installed, and templates are data rather than scripts.
const query = "query Echo($id: ID!, $nested: String!) { echo(id: $id) }";
const tricky = 'quoted " slash \\ newline\n中文🙂 {{must-not-expand-again}}';
const variables = {
  id: "{{customerId}}",
  nested: { list: ["{{customerId}}", "literal"] },
  enabled: false,
  count: 1,
};
const collection = (url) => ({
  info: {
    name: "Synthetic GraphQL template",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [
    {
      name: "Echo",
      request: {
        method: "POST",
        url,
        body: {
          mode: "graphql",
          graphql: {
            query,
            operationName: "Echo",
            variables: JSON.stringify(variables),
          },
        },
      },
    },
  ],
});
const expected = (value) => ({
  query,
  operationName: "Echo",
  variables: {
    id: value,
    nested: { list: [value, "literal"] },
    enabled: false,
    count: 1,
  },
});
async function close(server) {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "graphql-variable-workflow-"));
  const seen = [],
    clients = [];
  const peer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    seen.push({
      url: req.url,
      body,
      method: req.method,
      contentType: req.headers["content-type"],
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ received: JSON.parse(body) }));
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await close(app.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  });
  const response = (route, data, method = "POST") =>
    fetch(app.url + "/api" + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const api = async (route, data, method = "POST") => {
    const res = await response(route, data, method),
      value = await res.json();
    assert.equal(res.ok, true, JSON.stringify(value));
    return value;
  };
  let project = await api("/projects", { name: "GraphQL variable workflow" });
  project.environments = [
    { id: "first", name: "First", variables: { customerId: tricky } },
    { id: "second", name: "Second", variables: { customerId: "second-id" } },
    { id: "missing", name: "Missing", variables: {} },
    { id: "wrong-type", name: "Wrong type", variables: { customerId: 42 } },
  ];
  const route = "/projects/" + project.id;
  await api(route, project, "PUT");
  project = await api(route + "/import", {
    document: collection(`http://127.0.0.1:${peer.address().port}/graphql`),
  });
  const connect = async () => {
    const client = new Client({
      name: "graphql-variables-acceptance",
      version: "1",
    });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          project.id,
          "--write",
          "--execute",
        ],
        env: { ...process.env, LOCAL_API_DATA: root },
        stderr: "pipe",
      }),
    );
    return (args) =>
      client.callTool({
        name: "localapi_execute_api",
        arguments: {
          projectId: project.id,
          apiId: project.requests[0].id,
          ...args,
        },
      });
  };
  return {
    root,
    seen,
    project,
    route,
    api,
    response,
    connect,
    async restart() {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
function assertResponse(response, value) {
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).received, expected(value));
}
function assertWire(entry, value) {
  assert.equal(entry.url, "/graphql");
  assert.equal(entry.method, "POST");
  assert.equal(entry.contentType, "application/json");
  assert.deepEqual(JSON.parse(entry.body), expected(value));
}

test(
  "GraphQL string templates preserve owner/MCP environment switching, JSON escaping and missing-variable zero-send",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const request = structuredClone(f.project.requests[0]);
    assert.deepEqual(request.graphqlVariableTemplate, { version: 1 });
    assert.deepEqual(JSON.parse(request.body).variables, variables);
    assert.equal(f.seen.length, 0, "import cannot execute a template");
    for (const [environmentId, value] of [
      ["first", tricky],
      ["second", "second-id"],
    ]) {
      assertResponse(
        await f.api(f.route + "/execute", { request, environmentId }),
        value,
      );
      assertWire(f.seen.at(-1), value);
    }
    const invoke = await f.connect();
    for (const [environmentId, value] of [
      ["first", tricky],
      ["second", "second-id"],
    ]) {
      const result = await invoke({ environmentId });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const run = JSON.parse(result.content[0].text);
      assert.equal(run.status, "passed", JSON.stringify(run));
      assertResponse(run.results[0].response, value);
      assertWire(f.seen.at(-1), value);
    }
    for (const environmentId of ["missing", "wrong-type"]) {
      const count = f.seen.length;
      const owner = await f.response(f.route + "/execute", {
        request,
        environmentId,
      });
      const ownerFailure = await owner.json();
      assert.equal(
        ownerFailure.outcome,
        "failed",
        JSON.stringify(ownerFailure),
      );
      assert.match(ownerFailure.error, /GraphQL.*字符串变量/);
      const result = await invoke({ environmentId });
      const output = JSON.parse(result.content[0].text);
      assert(
        result.isError || output.status === "failed",
        JSON.stringify(output),
      );
      assert.equal(
        f.seen.length,
        count,
        "missing or non-string variables fail before sending",
      );
    }
    assert.deepEqual(
      (await f.api(f.route, undefined, "GET")).requests,
      f.project.requests,
    );
    assert.deepEqual(request, f.project.requests[0]);
  },
);

test(
  "GraphQL template definitions stay frozen through backup/restart and native exporters cannot erase the contract",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      request = structuredClone(f.project.requests[0]);
    const plan = await f.api(f.route + "/plans", {
      id: "frozen-graphql",
      name: "Frozen parameterized GraphQL",
      environmentId: "first",
      steps: [{ request }],
    });
    assert.deepEqual(plan.steps[0].request.graphqlVariableTemplate, {
      version: 1,
    });
    for (const exportDefinition of [
      exportApipost,
      exportApipostDirectory,
      exportOpenAPI,
    ])
      assert.throws(() => exportDefinition(f.project), /GraphQL|graphql/);
    assert.throws(() => toCurl(request), /GraphQL|graphql/);
    let live = await f.api(f.route, undefined, "GET");
    live.requests[0].body = JSON.stringify({
      query: "query Changed { changed }",
    });
    live.requests[0].url += "-changed";
    delete live.requests[0].graphqlVariableTemplate;
    await f.api(f.route, live, "PUT");
    const beforeBackup = f.seen.length;
    const backup = await f.api(f.route + "/export", undefined, "GET");
    assert.deepEqual(backup.plans[0].steps[0].request.graphqlVariableTemplate, {
      version: 1,
    });
    assert.equal(backup.plans[0].steps[0].request.body, request.body);
    const restored = await f.api("/restore", { document: backup });
    await f.restart();
    const saved = await new Store(f.root).get(restored.id);
    assert.equal(f.seen.length, beforeBackup);
    assert.deepEqual(
      saved.plans[0].steps[0].request,
      backup.plans[0].steps[0].request,
    );
    // A plain live API must not hide unsupported metadata in its frozen plan.
    assert.throws(() => exportApipostDirectory(saved), /GraphQL|graphql/);
    const run = await f.api(`/projects/${restored.id}/run`, {
      planId: "frozen-graphql",
      environmentId: "second",
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assertResponse(run.results[0].response, "second-id");
    assertWire(f.seen.at(-1), "second-id");
    assert.equal(
      f.seen.some((entry) => entry.url.endsWith("-changed")),
      false,
    );
    assert.equal(saved.plans[0].steps[0].request.body, request.body);
  },
);
