import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";

const policy = { mode: "same-origin", maxHops: 2 };
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

for (const transport of ["http", "stdio"])
  test(
    `official MCP SDK ${transport} executes bounded redirects, retains blocked 302 evidence and enforces grants/input boundaries`,
    { timeout: 20000 },
    async (t) => {
      // Spaces/# are deliberate filesystem path coverage. This child needs no
      // --import preloader; its entrypoint is an ordinary filesystem argument.
      const root = await mkdtemp(path.join(tmpdir(), "redirect SDK # "));
      const seen = [],
        foreignSeen = [],
        clients = [];
      const foreign = createServer((request, response) => {
        foreignSeen.push(request.url);
        response.end("must not reach foreign origin");
      });
      foreign.listen(0, "127.0.0.1");
      await once(foreign, "listening");
      const foreignURL = `http://127.0.0.1:${foreign.address().port}`;
      const origin = createServer((request, response) => {
        seen.push(request.url);
        if (request.url === "/start") {
          response.writeHead(302, { Location: "/final" });
          response.end("redirect first hop");
        } else if (request.url === "/blocked") {
          response.writeHead(302, {
            Location: foreignURL + "/must-not-send",
            "Content-Type": "application/json",
          });
          response.end('{"value":"must-not-extract"}');
        } else {
          response.setHeader("Content-Type", "application/json");
          response.end('{"value":"final"}');
        }
      });
      origin.listen(0, "127.0.0.1");
      await once(origin, "listening");
      const url = `http://127.0.0.1:${origin.address().port}`;
      const app =
        transport === "http" ? await createApp({ root, port: 0 }) : undefined;
      const store = app?.store || new Store(root);
      await store.init();
      t.after(async () => {
        await Promise.all(
          clients.map((client) => client.close().catch(() => {})),
        );
        await Promise.all([
          close(origin),
          close(foreign),
          ...(app ? [close(app.server)] : []),
        ]);
        await rm(root, { recursive: true, force: true });
      });
      const allowed = await store.create("Redirect SDK allowed");
      const denied = await store.create("Redirect SDK denied");
      const common = { method: "GET", timeout: 10000 };
      allowed.requests = [
        {
          ...common,
          id: "follow",
          name: "Follow",
          url: url + "/start",
          redirect: policy,
        },
        {
          ...common,
          id: "blocked",
          name: "Blocked",
          url: url + "/blocked",
          redirect: policy,
          expectedStatus: 302,
          assertions: [{ target: "status", op: "eq", value: 302 }],
          extract: [
            { name: "mustNotExtract", path: "$.value", scope: "global" },
          ],
          after: [{ type: "set", name: "mustNotAfter", value: "bad" }],
        },
        {
          ...common,
          id: "off",
          name: "Default off",
          url: url + "/start",
          assertions: [{ target: "status", op: "eq", value: 302 }],
        },
      ];
      denied.requests = [{ ...allowed.requests[0] }];
      await store.save(allowed);
      await store.save(denied);
      const definitions = structuredClone(
        (await store.get(allowed.id)).requests,
      );
      async function connect(execute) {
        const client = new Client(
          { name: "redirect-sdk-fixture", version: "1.0.0" },
          { capabilities: {} },
        );
        clients.push(client);
        let channel;
        if (app) {
          const configured = await fetch(app.url + "/api/mcp/config", {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              enabled: true,
              projects: [allowed.id],
              write: execute,
              execute,
              remember: false,
            }),
          });
          assert.equal(configured.status, 200, await configured.clone().text());
          const { token } = await configured.json();
          channel = new StreamableHTTPClientTransport(
            new URL(app.url + "/mcp"),
            {
              requestInit: { headers: { Authorization: "Bearer " + token } },
            },
          );
        } else {
          channel = new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
              "--project",
              allowed.id,
              ...(execute ? ["--write", "--execute"] : []),
            ],
            env: { LOCAL_API_DATA: root },
            stderr: "pipe",
          });
          // Drain bounded diagnostic output without allowing a child stderr pipe
          // to stall. Never include arbitrary captured stderr on successful runs.
          let stderr = "";
          channel.stderr?.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-8192);
          });
          channel.onerror = (error) => {
            if (stderr) error.message += "\n" + stderr;
          };
        }
        await client.connect(channel);
        assert.equal(client.getServerVersion().name, "local-api-workbench");
        return client;
      }
      const readOnly = await connect(false);
      await readOnly.ping();
      assert(
        !(await readOnly.listTools()).tools.some(
          (tool) => tool.name === "localapi_execute_api",
        ),
      );
      assert.equal(
        (
          await readOnly.callTool({
            name: "localapi_execute_api",
            arguments: { projectId: allowed.id, apiId: "follow" },
          })
        ).isError,
        true,
      );
      assert.deepEqual(seen, []);
      await readOnly.close();
      const client = await connect(true);
      assert(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "localapi_execute_api",
        ),
      );
      const call = (name, args) =>
        client.callTool({
          name: "localapi_" + name,
          arguments: { projectId: allowed.id, ...args },
        });
      assert.equal(
        (await call("execute_api", { projectId: denied.id, apiId: "follow" }))
          .isError,
        true,
      );
      assert.deepEqual(seen, []);
      assert.equal(
        (
          await call("execute_api", {
            apiId: "off",
            input: { redirect: policy },
          })
        ).isError,
        true,
      );
      assert.deepEqual(seen, []);
      assert.equal((await store.get(allowed.id)).history.length, 0);
      const off = decode(await call("execute_api", { apiId: "off" }));
      assert.equal(off.status, "passed");
      assert.equal(off.results[0].response.status, 302);
      assert.equal(off.results[0].response.redirectTrace, undefined);
      assert.deepEqual(seen, ["/start"]);
      const success = decode(await call("execute_api", { apiId: "follow" }));
      assert.equal(success.status, "passed");
      assert.equal(success.results[0].response.status, 200);
      assert.equal(success.results[0].response.effectiveUrl, url + "/final");
      assert.deepEqual(
        success.results[0].response.redirectTrace.map((hop) => hop.status),
        [302, 200],
      );
      const failed = decode(await call("execute_api", { apiId: "blocked" }));
      assert.equal(failed.status, "failed");
      assert.equal(failed.results[0].response.status, 302);
      assert.equal(failed.results[0].redirectFailure.reason, "origin");
      assert.equal(failed.results[0].redirectFailure.retry_safe, false);
      assert.deepEqual(failed.results[0].assertions, []);
      assert.deepEqual(failed.results[0].extracted, {});
      assert.equal(failed.variables.mustNotAfter, undefined);
      assert.equal(failed.variables.mustNotExtract, undefined);
      assert.deepEqual(seen, ["/start", "/start", "/final", "/blocked"]);
      assert.deepEqual(foreignSeen, []);
      const list = decode(
        await call("list_execution_runs", { scope: "api", source: "mcp" }),
      );
      assert(list.some((record) => record.id === success.id));
      assert(list.some((record) => record.id === failed.id));
      assert.equal(
        (
          await call("get_execution_result", {
            projectId: denied.id,
            runId: success.id,
          })
        ).isError,
        true,
      );
      const detail = decode(
        await call("get_execution_result", { runId: success.id }),
      );
      assert.deepEqual(
        detail.response.redirectTrace,
        success.results[0].response.redirectTrace,
      );
      const failedDetail = decode(
        await call("get_execution_result", { runId: failed.id }),
      );
      assert.deepEqual(
        failedDetail.redirectFailure,
        failed.results[0].redirectFailure,
      );
      await client.close();
      const reopened = await connect(false);
      const reread = decode(
        await reopened.callTool({
          name: "localapi_get_execution_result",
          arguments: { projectId: allowed.id, runId: failed.id },
        }),
      );
      assert.equal(reread.response.status, 302);
      assert.deepEqual(
        reread.redirectFailure,
        failed.results[0].redirectFailure,
      );
      assert.deepEqual(
        seen,
        ["/start", "/start", "/final", "/blocked"],
        "detail reads and new transports never replay HTTP",
      );
      assert.deepEqual(foreignSeen, []);
      assert.deepEqual((await store.get(allowed.id)).requests, definitions);
      assert.equal((await store.get(denied.id)).history.length, 0);
    },
  );
