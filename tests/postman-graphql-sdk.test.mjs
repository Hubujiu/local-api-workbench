import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const payload = {
  query: "query Echo($input: String!) { echo(input: $input) }",
  operationName: "Echo",
  variables: { input: '中文 "quoted" \\ newline\n', nested: { enabled: true } },
};

for (const transportKind of ["HTTP", "stdio"]) {
  test(
    `Postman GraphQL owner import executes through official SDK ${transportKind}, persists evidence and isolates grants`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "graphql sdk # "));
      const received = [];
      const target = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        received.push({
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ data: { echo: JSON.parse(received.at(-1).body) } }),
        );
      });
      await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
      const app = await createApp({ root, port: 0 });
      const clients = [];
      t.after(async () => {
        await Promise.all(
          clients.map((client) => client.close().catch(() => {})),
        );
        app.server.closeAllConnections();
        target.closeAllConnections();
        await Promise.all(
          [app.server, target].map(
            (server) => new Promise((resolve) => server.close(resolve)),
          ),
        );
        await rm(root, { recursive: true, force: true });
      });
      const owner = async (route, body, method = "POST") => {
        const response = await fetch(app.url + "/api" + route, {
          method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text);
      };
      const document = {
        info: {
          name: "Static GraphQL",
          schema:
            "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        item: [
          {
            name: "Echo",
            request: {
              method: "POST",
              url: `http://127.0.0.1:${target.address().port}/graphql`,
              body: {
                mode: "graphql",
                graphql: {
                  ...payload,
                  variables: JSON.stringify(payload.variables),
                },
              },
            },
          },
        ],
      };
      const allowed = await app.store.create("GraphQL allowed");
      const denied = await app.store.create("GraphQL denied exists");
      const imported = await owner(`/projects/${allowed.id}/import`, {
        document,
      });
      const deniedImported = await owner(`/projects/${denied.id}/import`, {
        document,
      });
      const request = imported.requests[0];
      await owner(
        `/projects/${denied.id}`,
        {
          ...deniedImported,
          plans: [
            {
              id: "denied-graphql-plan",
              name: "Existing denied GraphQL plan",
              steps: [{ request: deniedImported.requests[0] }],
            },
          ],
        },
        "PUT",
      );
      assert.equal(request.bodyType, "json");
      assert.deepEqual(JSON.parse(request.body), payload);
      // Complete fixture preflight: no scripts, shared script library, functions, database or protocol steps.
      for (const project of [imported, deniedImported]) {
        assert.equal(project.requests.length, 1);
        assert.equal(project.requests[0].beforeScript, "");
        assert.equal(project.requests[0].afterScript, "");
        assert.equal(project.plans.length, 0);
        assert.equal((project.settings.functions || []).length, 0);
      }
      const config =
        transportKind === "HTTP"
          ? await owner("/mcp/config", {
              enabled: true,
              projects: [allowed.id],
              write: true,
              execute: true,
              remember: false,
            })
          : null;
      const connect = async (readOnly = false) => {
        const client = new Client(
          { name: "graphql-import-sdk-fixture", version: "1.0.0" },
          { capabilities: {} },
        );
        clients.push(client);
        const transport =
          transportKind === "HTTP"
            ? new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
                requestInit: {
                  headers: { Authorization: "Bearer " + config.token },
                },
              })
            : new StdioClientTransport({
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                  "--project",
                  allowed.id,
                  ...(readOnly ? [] : ["--write", "--execute"]),
                ],
                env: { LOCAL_API_DATA: root },
                stderr: "pipe",
              });
        if (transportKind === "stdio") transport.stderr?.resume();
        await client.connect(transport);
        return client;
      };
      const call = async (client, name, args = {}) =>
        decode(
          await client.callTool({
            name: "localapi_" + name,
            arguments: { projectId: allowed.id, ...args },
          }),
        );
      const client = await connect();
      const detail = await call(client, "get_api_detail", {
        apiId: request.id,
      });
      assert.deepEqual(JSON.parse(detail.body), payload);
      const flow = await call(client, "create_execution_flow", {
        plan: { name: "Frozen imported GraphQL", steps: [{ request: detail }] },
      });
      assert.deepEqual(JSON.parse(flow.steps[0].request.body), payload);
      const apiRun = await call(client, "execute_api", { apiId: request.id });
      const flowRun = await call(client, "execute_flow", { planId: flow.id });
      assert.equal(apiRun.status, "passed");
      assert.equal(flowRun.status, "passed");
      assert.equal(received.length, 2);
      for (const wire of received) {
        assert.equal(wire.method, "POST");
        assert.match(wire.headers["content-type"], /^application\/json/);
        assert.deepEqual(JSON.parse(wire.body), payload);
      }
      const disk = new Store(root);
      await disk.init();
      const saved = await disk.get(allowed.id);
      assert.equal(saved.history.length, 1);
      assert.equal(saved.runs.length, 1);
      assert.deepEqual(saved.requests, imported.requests);
      const deniedBefore = await disk.get(denied.id);
      for (const [name, args] of [
        ["get_api_detail", { apiId: deniedImported.requests[0].id }],
        ["execute_api", { apiId: deniedImported.requests[0].id }],
        ["execute_flow", { planId: "denied-graphql-plan" }],
        [
          "create_execution_flow",
          {
            plan: {
              name: "must not save",
              steps: [{ request: deniedImported.requests[0] }],
            },
          },
        ],
        ["get_execution_result", { runId: apiRun.id }],
      ]) {
        const rejected = await client.callTool({
          name: "localapi_" + name,
          arguments: { projectId: denied.id, ...args },
        });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /项目未授权/);
      }
      assert.deepEqual(await disk.get(denied.id), deniedBefore);
      assert.deepEqual(await disk.get(allowed.id), saved);
      assert.equal(received.length, 2);
      await client.close();
      const reconnected = await connect();
      const summaries = await call(reconnected, "list_execution_runs", {
        source: "mcp",
      });
      assert.deepEqual(
        new Set(summaries.map((row) => row.id)),
        new Set([apiRun.id, flowRun.id]),
      );
      const apiEvidence = await call(reconnected, "get_execution_result", {
        runId: apiRun.id,
      });
      const flowEvidence = await call(reconnected, "get_execution_result", {
        runId: flowRun.id,
      });
      assert.deepEqual(
        JSON.parse(apiEvidence.response.body).data.echo,
        payload,
      );
      assert.deepEqual(
        JSON.parse(flowEvidence.results[0].response.body).data.echo,
        payload,
      );
      assert.deepEqual(
        JSON.parse(
          (await call(reconnected, "get_execution_flow", { planId: flow.id }))
            .steps[0].request.body,
        ),
        payload,
      );
      assert.equal(
        received.length,
        2,
        "reconnect and evidence reads must not replay requests",
      );
      assert.deepEqual(await disk.get(allowed.id), saved);
      await reconnected.close();
      if (transportKind === "HTTP")
        await owner("/mcp/config", {
          enabled: true,
          projects: [allowed.id],
          write: false,
          execute: false,
          remember: false,
        });
      const readOnly = await connect(true);
      for (const name of [
        "execute_api",
        "execute_flow",
        "create_execution_flow",
      ]) {
        assert(
          !(await readOnly.listTools()).tools.some(
            (tool) => tool.name === "localapi_" + name,
          ),
        );
        const rejected = await readOnly.callTool({
          name: "localapi_" + name,
          arguments: {
            projectId: allowed.id,
            apiId: request.id,
            planId: flow.id,
            plan: flow,
          },
        });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /未授权/);
      }
      assert.deepEqual(await disk.get(allowed.id), saved);
      assert.equal(received.length, 2);
    },
  );
}
