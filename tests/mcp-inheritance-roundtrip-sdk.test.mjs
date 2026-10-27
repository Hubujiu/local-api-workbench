import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { restoreProject } from "../src/core.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
const decode = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
for (const transport of ["http", "stdio"])
  for (const format of ["apipost", "apipost-directory"])
    test(
      `official SDK ${transport} ${format} preserves native inheritance through two generations and scoped live/frozen execution`,
      { timeout: 45000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "mcp-inheritance-"));
        const wire = [];
        const peer = http.createServer((req, res) => {
          wire.push({ url: req.url, headers: req.headers });
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        });
        await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
        const app = await createApp({ root, port: 0 });
        let client;
        t.after(async () => {
          await client?.close().catch(() => {});
          await close(app.server);
          await close(peer);
          await rm(root, { recursive: true, force: true });
        });
        const first = await app.store.create("first"),
          second = await app.store.create("second"),
          flat = await app.store.create("flat"),
          denied = await app.store.create("denied");
        const deniedBefore = await app.store.get(denied.id);
        const projects = [first.id, second.id, flat.id];
        const source = nativeInheritanceFixture();
        source.global.envs[0].server_list[0].uri = `http://127.0.0.1:${peer.address().port}`;
        source.global.envs[0].env_var_list.token = {
          value: "fictional",
          current_value: "fictional",
        };
        const original = structuredClone(source);
        const document =
          format === "apipost" ? source : nativeDirectoryFixture(source);
        async function connect(write = false, execute = false) {
          await client?.close().catch(() => {});
          client = new Client(
            { name: "inheritance-sdk", version: "1" },
            { capabilities: {} },
          );
          if (transport === "http") {
            const response = await fetch(app.url + "/api/mcp/config", {
              method: "POST",
              headers: {
                "x-local-token": app.token,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                enabled: true,
                projects,
                write,
                execute,
                remember: false,
              }),
            });
            assert.equal(response.status, 200);
            const { token } = await response.json();
            await client.connect(
              new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
                requestInit: { headers: { Authorization: "Bearer " + token } },
              }),
            );
          } else
            await client.connect(
              new StdioClientTransport({
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                  ...projects.flatMap((id) => ["--project", id]),
                  ...(write ? ["--write"] : []),
                  ...(execute ? ["--execute"] : []),
                ],
                env: { LOCAL_API_DATA: root },
                stderr: "pipe",
              }),
            );
        }
        const call = (name, args) =>
          client.callTool({ name: "localapi_" + name, arguments: args });
        const success = async (name, args) => decode(await call(name, args));
        async function rejected(args) {
          const before = await app.store.get(args.projectId);
          const result = await call("import_project", args);
          assert.equal(result.isError, true, JSON.stringify(result));
          assert.deepEqual(await app.store.get(args.projectId), before);
          assert.equal(wire.length, 0);
        }
        const args = {
          projectId: first.id,
          format,
          document,
          inheritanceMode: "preserve",
        };
        await connect();
        await rejected(args);
        await connect(true);
        const tools = (await client.listTools()).tools;
        assert.deepEqual(
          tools.find((x) => x.name === "localapi_import_project").inputSchema
            .properties.inheritanceMode.enum,
          ["flatten", "preserve"],
        );
        assert.equal(
          tools.find((x) => x.name === "localapi_export_project").inputSchema
            .properties.inheritanceMode,
          undefined,
        );
        await rejected({ ...args, projectId: denied.id });
        for (const inheritanceMode of [null, "unknown", {}, false])
          await rejected({ ...args, inheritanceMode });
        const broken = structuredClone(source);
        broken.apis[0].parent_id = "missing";
        await rejected({
          ...args,
          document:
            format === "apipost" ? broken : nativeDirectoryFixture(broken),
        });
        const imported = await success("import_project", args);
        assert.equal(imported.imported.requestIds.length, 1);
        await rejected(args);
        const graph = (await app.store.get(first.id)).settings
          .nativeInheritance;
        assert(graph && graph.bindings.length === 1);
        const exported = await success("export_project", {
          projectId: first.id,
          format,
        });
        assert.deepEqual(Object.keys(exported).sort(), [
          "document",
          "format",
          "projectId",
        ]);
        await success("import_project", {
          ...args,
          projectId: second.id,
          document: exported.document,
        });
        const secondExport = await success("export_project", {
          projectId: second.id,
          format,
        });
        const third = await app.store.create("third generation");
        projects.push(third.id);
        await connect(true);
        await success("import_project", {
          ...args,
          projectId: third.id,
          document: secondExport.document,
        });
        const final = await app.store.get(third.id);
        assert.deepEqual(
          final.settings.nativeInheritance.projectLayer,
          graph.projectLayer,
        );
        assert.deepEqual(
          final.settings.nativeInheritance.folders.map(
            ({ sourceId, ...row }) => row,
          ),
          graph.folders.map(({ sourceId, ...row }) => row),
        );
        assert.equal(final.settings.nativeInheritance.bindings.length, 1);
        assert.equal(
          final.settings.nativeInheritance.bindings[0].parentId,
          final.settings.nativeInheritance.folders[0].sourceId,
        );
        await success("import_project", {
          projectId: flat.id,
          format,
          document,
        });
        assert.equal(
          (await app.store.get(flat.id)).settings.nativeInheritance,
          undefined,
        );
        assert.equal(wire.length, 0);
        assert.deepEqual(source, original);
        const refused = await call("execute_api", {
          projectId: third.id,
          apiId: final.requests[0].id,
        });
        assert.equal(refused.isError, true);
        assert.equal(wire.length, 0);
        await connect(true, true);
        async function owner(route, body) {
          const res = await fetch(
            app.url + "/api/projects/" + third.id + "/" + route,
            {
              method: "POST",
              headers: {
                "x-local-token": app.token,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          const output = await res.json();
          assert.equal(res.status, 200, JSON.stringify(output));
          return output;
        }
        await owner("execute", { request: final.requests[0] });
        assert.equal(wire.at(-1).headers["x-shared"], "project");
        assert.equal(wire.at(-1).headers.authorization, "Bearer fictional");
        const plan = await owner("plans", {
          name: "Frozen inheritance",
          environmentId: final.environments[0].id,
          steps: [{ request: final.requests[0] }],
        });
        assert.equal(plan.steps[0].request.nativeInheritance, undefined);
        const live = await app.store.get(third.id);
        live.settings.nativeInheritance.projectLayer.headers[0].value =
          "live-edited";
        await app.store.save(live);
        await success("execute_api", {
          projectId: third.id,
          apiId: final.requests[0].id,
        });
        assert.equal(wire.at(-1).headers["x-shared"], "live-edited");
        const run = await success("run_plan", {
          projectId: third.id,
          planId: plan.id,
        });
        assert.equal(run.status, "passed");
        assert.equal(wire.at(-1).headers["x-shared"], "project");
        assert.equal(wire.length, 3);
        const reopened = new Store(root);
        await reopened.init();
        assert.equal(
          (await reopened.get(third.id)).settings.nativeInheritance.projectLayer
            .headers[0].value,
          "live-edited",
        );
        const persisted = await reopened.get(third.id);
        assert.equal(persisted.runs.length, 1);
        const restored = restoreProject(persisted);
        await reopened.save(restored);
        projects.push(restored.id);
        await connect(true, true);
        const afterRestore = new Store(root);
        await afterRestore.init();
        const diskCopy = await afterRestore.get(restored.id);
        assert.deepEqual(
          diskCopy.settings.nativeInheritance,
          persisted.settings.nativeInheritance,
        );
        assert.equal(wire.length, 3, "restoration does not replay traffic");
        const restoredRun = await success("run_plan", {
          projectId: restored.id,
          planId: diskCopy.plans[0].id,
        });
        assert.equal(restoredRun.status, "passed");
        assert.equal(wire.at(-1).headers["x-shared"], "project");
        assert.equal(wire.length, 4);
        assert.equal((await afterRestore.get(restored.id)).runs.length, 2);
        assert.equal((await afterRestore.get(third.id)).runs.length, 1);
        assert.deepEqual(await reopened.get(denied.id), deniedBefore);
        assert.deepEqual(
          (await reopened.get(first.id)).settings.nativeInheritance,
          graph,
        );
      },
    );
