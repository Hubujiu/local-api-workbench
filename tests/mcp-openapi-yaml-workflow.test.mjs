import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
for (const transport of ["http", "stdio"])
  for (const native of [false, true])
    test(
      `MCP YAML ${transport}/${native ? "native" : "canonical"}: atomic sync, grants, restore and execution`,
      { timeout: 20000 },
      async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mcp-yaml-"));
        let hits = 0;
        const upstream = http.createServer((req, res) => {
          hits++;
          assert.equal(req.url, "/echo");
          res.setHeader("content-type", "application/json");
          res.end('{"value":"yaml-wire"}');
        });
        await new Promise((resolve) =>
          upstream.listen(0, "127.0.0.1", resolve),
        );
        let app = await createApp({ root, port: 0 });
        const clients = [];
        t.after(async () => {
          await Promise.all(
            clients.map((client) => client.close().catch(() => {})),
          );
          await close(app.server);
          await close(upstream);
          await rm(root, { recursive: true, force: true });
        });
        const owner = async (route, document) => {
          const response = await fetch(app.url + route, {
            method: document === undefined ? "GET" : "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            ...(document === undefined
              ? {}
              : { body: JSON.stringify(document) }),
          });
          assert.equal(response.ok, true, await response.clone().text());
          return response.json();
        };
        const allowed = await app.store.create("YAML allowed");
        const denied = await app.store.create("YAML denied");
        allowed.folders = ["target"];
        await app.store.save(allowed);
        const connect = async (projectId, write = true) => {
          const c = new Client(
            { name: "yaml-sync-fixture", version: "1" },
            { capabilities: {} },
          );
          clients.push(c);
          if (transport === "http") {
            const config = await owner("/api/mcp/config", {
              enabled: true,
              projects: [projectId],
              write,
              execute: true,
              remember: false,
            });
            await c.connect(
              new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
                requestInit: {
                  headers: { Authorization: "Bearer " + config.token },
                },
              }),
            );
          } else {
            await c.connect(
              new StdioClientTransport({
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                  "--project",
                  projectId,
                  "--execute",
                  ...(write ? ["--write"] : []),
                ],
                env: { LOCAL_API_DATA: root },
                stderr: "pipe",
              }),
            );
          }
          return c;
        };
        let c = await connect(allowed.id);
        const invoke = (name, args) => c.callTool({ name, arguments: args });
        const prefix = native ? "apipost_" : "localapi_";
        const base = `http://127.0.0.1:${upstream.address().port}`;
        if (native)
          decode(
            await invoke("apipost_update_environment", {
              project_id: allowed.id,
              environment_id: "1",
              base_url: base,
            }),
          );
        const yaml = `openapi: 3.1.0\ninfo: {title: YAML fixture, version: "1"}\nservers:\n  - url: ${JSON.stringify(base)}\npaths:\n  /echo:\n    get:\n      summary: YAML request\n      responses:\n        "200": {description: OK}\n`;
        const script = 'apt.environment.set("yamlProof", "executed");';
        const args = (id, document = yaml, mode = "url_and_folder") =>
          native
            ? {
                project_id: id,
                openapi: document,
                api_cover_mode: mode,
                api_scripts: [
                  { method: "GET", url: "/echo", post_script: script },
                ],
              }
            : {
                projectId: id,
                document,
                coverMode: mode,
                apiScripts: [
                  { method: "GET", url: "/echo", afterScript: script },
                ],
              };
        const first = decode(
          await invoke(prefix + "sync_openapi", args(allowed.id)),
        );
        const requestId = native ? first.sync_items[0].target_id : first[0].id;
        const afterImport = await app.store.get(allowed.id);
        assert.equal(afterImport.requests.length, 1);
        assert.equal(afterImport.requests[0].afterScript, script);
        assert.equal(
          afterImport.environments[0].variables.yamlProof,
          undefined,
        );
        assert.equal(
          hits,
          0,
          "sync must not execute requests or script mappings",
        );
        const updated = decode(
          await invoke(
            prefix + "sync_openapi",
            args(allowed.id, yaml.replace("YAML request", "YAML updated")),
          ),
        );
        assert.equal(
          native ? updated.sync_items[0].target_id : updated[0].id,
          requestId,
        );
        assert.equal(
          (await app.store.get(allowed.id)).requests[0].name,
          "YAML updated",
        );
        const ignored = decode(
          await invoke(
            prefix + "sync_openapi",
            args(allowed.id, yaml, "ignore"),
          ),
        );
        assert.equal(native ? ignored.skipped : ignored.length, native ? 1 : 0);
        decode(
          await invoke(prefix + "sync_openapi", args(allowed.id, yaml, "both")),
        );
        assert.equal((await app.store.get(allowed.id)).requests.length, 2);
        const updatedAcrossFolder = decode(
          await invoke(prefix + "sync_openapi", {
            ...args(allowed.id, yaml, "url"),
            ...(native ? { folder_id: "folder:target" } : { folder: "target" }),
          }),
        );
        assert.equal(
          native
            ? updatedAcrossFolder.sync_items[0].target_id
            : updatedAcrossFolder[0].id,
          requestId,
        );
        assert.equal(
          (await app.store.get(allowed.id)).requests.find(
            (request) => request.id === requestId,
          ).folder,
          "target",
        );
        const before = await readFile(app.store.file(allowed.id));
        const beforeProject = await app.store.get(allowed.id);
        for (const [invalid, expected] of [
          [yaml + "  /blocked:\n    trace:\n      responses: {}\n", /TRACE/],
          [
            yaml.replace("openapi: 3.1.0", "openapi: 3.1.0\nopenapi: 3.0.3"),
            /unique|重复/i,
          ],
          [yaml.replace("openapi: 3.1.0", "swagger: '2.0'"), /OpenAPI 3/],
          [
            yaml +
              "components:\n  examples:\n    Loop:\n      value: &cycle [*cycle]\n",
            /循环别名/,
          ],
        ]) {
          const rejected = await invoke(
            prefix + "sync_openapi",
            args(allowed.id, invalid),
          );
          assert.equal(rejected.isError, true);
          assert.match(rejected.content[0].text, expected);
          assert.deepEqual(await app.store.get(allowed.id), beforeProject);
          assert.deepEqual(await readFile(app.store.file(allowed.id)), before);
        }
        const deniedBefore = await readFile(app.store.file(denied.id));
        const denial = await invoke(prefix + "sync_openapi", args(denied.id));
        assert.equal(denial.isError, true);
        assert.match(denial.content[0].text, /项目未授权/);
        assert.deepEqual(
          await readFile(app.store.file(denied.id)),
          deniedBefore,
        );
        const execute = async (id) =>
          decode(
            await invoke(
              prefix + "execute_api",
              native
                ? {
                    project_id: id,
                    target_id: requestId,
                  }
                : { projectId: id, apiId: requestId },
            ),
          );
        assert.equal((await execute(allowed.id)).status, "passed");
        assert.equal(hits, 1);
        assert.equal(
          (await app.store.get(allowed.id)).environments[0].variables.yamlProof,
          "executed",
        );
        const backup = await owner(`/api/projects/${allowed.id}/export`);
        const restored = await owner("/api/restore", { document: backup });
        assert.notEqual(restored.id, allowed.id);
        assert.deepEqual(restored.requests, backup.requests);
        assert.equal(
          (await invoke(prefix + "sync_openapi", args(restored.id))).isError,
          true,
        );
        await c.close();
        await close(app.server);
        app = await createApp({ root, port: 0 });
        assert.deepEqual(
          (await app.store.get(restored.id)).requests,
          backup.requests,
        );
        c = await connect(restored.id, false);
        const readOnlyBefore = await readFile(app.store.file(restored.id));
        assert.equal(
          (await invoke(prefix + "sync_openapi", args(restored.id))).isError,
          true,
        );
        assert.deepEqual(
          await readFile(app.store.file(restored.id)),
          readOnlyBefore,
        );
        await c.close();
        c = await connect(restored.id);
        assert.equal((await execute(restored.id)).status, "passed");
        assert.equal(hits, 2);
        assert.equal(
          (await app.store.get(restored.id)).environments[0].variables
            .yamlProof,
          "executed",
        );
        assert.deepEqual(
          await readFile(app.store.file(denied.id)),
          deniedBefore,
        );
      },
    );
