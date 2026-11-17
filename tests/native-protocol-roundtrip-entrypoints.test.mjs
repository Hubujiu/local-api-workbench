import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { nativeProtocolExportFixture } from "./fixtures/native-protocol-export.mjs";
import { runPlanCLI } from "./helpers/run-plan-cli.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const definitions = (project) =>
  project.protocols.map(({ id, ...definition }) => definition);
const closeApp = async (app) => {
  app.server.closeAllConnections();
  const result = await app.close();
  assert.equal(result.allRecordsSaved, true);
};
const assertGraph = (project, expected) => {
  assert.deepEqual(definitions(project), expected);
  assert.equal(project.protocols.length, 3);
  assert.equal(new Set(project.protocols.map((d) => d.id)).size, 3);
  assert.equal(project.requests.length, 1);
  assert.equal(project.documents.length, 1);
  assert.equal(project.dictionary.length, 1);
  assert.equal(project.dictionary[0].name, "Payload");
  assert.deepEqual(project.dictionary[0].schema, { type: "string" });
  assert.equal(project.documents[0].title, "Protocol guide");
  assert.equal(project.documents[0].content, "inert protocol notes");
  const sources = project.settings.apipostProtocolSources;
  assert.equal(sources.length, 4);
  const container = sources.find((x) => x.source.target_type === "socket");
  const method = sources.find((x) => x.source.target_type === "socket_method");
  assert.equal(method.source.parent_id, container.source.target_id);
  assert(sources.every((x) => x.source.project_id === x.sourceProjectId));
  assert.equal(project.folders.filter((f) => f === "A/B/TCP").length, 1);
};

for (const transport of ["http", "stdio"])
  for (const format of ["apipost", "apipost-directory"])
    test(
      `native TCP/SSE ${transport}/${format} SDK interchange and real CLI preserve frozen protocol graphs through restore`,
      { timeout: 45000 },
      async (t) => {
        const root = await mkdtemp(
          path.join(tmpdir(), "native-protocol-roundtrip-"),
        );
        const seen = [],
          sockets = new Set();
        const tcp = net.createServer((socket) => {
          sockets.add(socket);
          socket.on("error", () => {});
          socket.on("close", () => sockets.delete(socket));
          socket.on("data", (body) => {
            seen.push({ type: "tcp", body: body.toString() });
            socket.write(body);
          });
        });
        const upstream = http.createServer(async (req, res) => {
          let body = "";
          for await (const chunk of req) body += chunk;
          seen.push({
            type: "sse",
            body,
            method: req.method,
            url: req.url,
            language: req.headers["accept-language"],
            authorization: req.headers.authorization,
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("id: proof\ndata: " + body + "\n\n");
        });
        tcp.listen(0, "127.0.0.1");
        upstream.listen(0, "127.0.0.1");
        await Promise.all([
          once(tcp, "listening"),
          once(upstream, "listening"),
        ]);
        let app = await createApp({ root, port: 0 }),
          client;
        t.after(async () => {
          await client?.close().catch(() => {});
          await closeApp(app);
          for (const socket of sockets) socket.destroy();
          upstream.closeAllConnections();
          await Promise.all([
            new Promise((r) => tcp.close(r)),
            new Promise((r) => upstream.close(r)),
          ]);
          await rm(root, { recursive: true, force: true });
        });
        const owner = async (route, method = "GET", body, status = 200) => {
          const res = await fetch(app.url + route, {
            method,
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const result = await res.json();
          assert.equal(res.status, status, JSON.stringify(result));
          return result;
        };
        const source = await app.store.create("source"),
          target = await app.store.create("target"),
          second = await app.store.create("second"),
          other = await app.store.create("ungranted");
        const document = nativeProtocolExportFixture(
          `127.0.0.1:${tcp.address().port}`,
          `http://127.0.0.1:${upstream.address().port}/events?x=one`,
        );
        const untouchedInput = structuredClone(document);
        importIntoProject(source, document, { modelNameMode: "preserve" });
        await app.store.save(source);
        const sourceBefore = await app.store.get(source.id),
          otherBefore = await app.store.get(other.id),
          targetBefore = await app.store.get(target.id),
          expected = definitions(sourceBefore);
        const connect = async (write, execute) => {
          await client?.close().catch(() => {});
          client = new Client(
            { name: "protocol-interchange", version: "1" },
            { capabilities: {} },
          );
          if (transport === "http") {
            const configuration = await owner("/api/mcp/config", "POST", {
              enabled: true,
              projects: [source.id, target.id, second.id],
              write,
              execute,
              remember: false,
            });
            await client.connect(
              new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
                requestInit: {
                  headers: { Authorization: "Bearer " + configuration.token },
                },
              }),
            );
          } else {
            const wire = new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                "--project",
                source.id,
                "--project",
                target.id,
                "--project",
                second.id,
                ...(write ? ["--write"] : []),
                ...(execute ? ["--execute"] : []),
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            });
            wire.stderr.resume();
            await client.connect(wire);
          }
        };
        const raw = (name, args) =>
          client.callTool({ name: "localapi_" + name, arguments: args });
        const call = async (name, args) => decode(await raw(name, args));
        await connect(false, false);
        const exported = await call("export_project", {
          projectId: source.id,
          format,
          modelNameMode: "preserve",
        });
        assert.equal(
          (
            await raw("export_project", {
              projectId: other.id,
              format,
              modelNameMode: "preserve",
            })
          ).isError,
          true,
        );
        assert.equal(
          (
            await raw("import_project", {
              projectId: target.id,
              format,
              document: exported.document,
              modelNameMode: "preserve",
            })
          ).isError,
          true,
        );
        assert.deepEqual(await app.store.get(target.id), targetBefore);
        assert.deepEqual(seen, []);
        await connect(true, false);
        const imported = await call("import_project", {
          projectId: target.id,
          format,
          document: exported.document,
          modelNameMode: "preserve",
        });
        assert.equal(imported.imported.protocolIds.length, 3);
        assert.equal(imported.imported.documentIds.length, 1);
        assert.equal(imported.imported.requestIds.length, 1);
        const firstSaved = await app.store.get(target.id);
        assertGraph(firstSaved, expected);
        assert.deepEqual(
          new Set(imported.imported.protocolIds),
          new Set(firstSaved.protocols.map((d) => d.id)),
        );
        const secondExport = await call("export_project", {
          projectId: target.id,
          format,
          modelNameMode: "preserve",
        });
        const secondImport = await call("import_project", {
          projectId: second.id,
          format,
          document: secondExport.document,
          modelNameMode: "preserve",
        });
        assert.equal(secondImport.imported.protocolIds.length, 3);
        const saved = await app.store.get(second.id);
        assertGraph(saved, expected);
        assert.deepEqual(
          seen,
          [],
          "two generations of SDK definition conversion must not open transports",
        );
        const environmentId = saved.environments.find(
          (e) => e.name === "Imported",
        ).id;
        const plan = await call("create_execution_flow", {
          projectId: second.id,
          plan: {
            name: "Frozen protocol graph",
            environmentId,
            steps: saved.protocols.map((d) => ({
              id: d.id,
              type: "protocol",
              protocol: { definitionId: d.id, duration: 1000 },
            })),
          },
        });
        assert.equal(plan.steps.length, 3);
        assert(
          plan.steps.every(
            (s) => s.type === "protocol" && s.protocol.definition,
          ),
        );
        assert.equal(
          (await raw("run_plan", { projectId: second.id, planId: plan.id }))
            .isError,
          true,
        );
        assert.equal(
          (
            await raw("export_project", {
              projectId: second.id,
              format,
              modelNameMode: "preserve",
            })
          ).isError,
          true,
          "native protocol-plan interchange remains unsupported",
        );
        assert.deepEqual(seen, []);
        await client.close();
        client = null;
        const live = await app.store.get(second.id);
        for (const definition of live.protocols) {
          if (definition.type === "tcp") {
            definition.port = 1;
            definition.message = "live-edit-must-not-run";
          } else {
            definition.url = "http://127.0.0.1:1/changed";
            definition.body = "live-edit-must-not-run";
          }
        }
        await app.store.save(live);
        const check = (run) => {
          assert.equal(run.status, "passed", JSON.stringify(run));
          assert.equal(run.recordSaved, true);
          assert.equal(run.environmentId, environmentId);
          assert.equal(run.results.length, 3);
          assert.deepEqual(run.snapshot.steps, plan.steps);
        };
        const checkWire = (count) => {
          assert.equal(seen.length, count);
          assert(seen.every((r) => r.body === "wire-value"));
          for (const r of seen.filter((r) => r.type === "sse")) {
            assert.equal(r.method, "POST");
            assert.equal(r.url, "/events?x=one");
            assert.equal(r.language, "zh-CN");
            assert.equal(r.authorization, undefined);
          }
        };
        await connect(true, true);
        const sdkRun = await call("run_plan", {
          projectId: second.id,
          planId: plan.id,
        });
        check(sdkRun);
        checkWire(3);
        const read = await call("get_run", {
          projectId: second.id,
          runId: sdkRun.id,
        });
        assert.equal(read.id, sdkRun.id);
        assert.equal(
          (await raw("get_run", { projectId: other.id, runId: sdkRun.id }))
            .isError,
          true,
        );
        await client.close();
        client = null;
        const executed = await runPlanCLI(
          root,
          second.id,
          plan.id,
          environmentId,
        );
        assert.equal(executed.code, 0, executed.stderr);
        check(JSON.parse(executed.stdout));
        checkWire(6);
        const backup = await owner(`/api/projects/${second.id}/export`);
        assert.equal(
          backup.runs.filter((r) => r.snapshot?.id === plan.id).length,
          2,
        );
        const restored = await owner(
          "/api/restore",
          "POST",
          { document: backup },
          201,
        );
        assert.deepEqual(restored.plans, backup.plans);
        assert.deepEqual(restored.runs, backup.runs);
        await closeApp(app);
        app = await createApp({ root, port: 0 });
        const disk = await new Store(root).get(restored.id);
        assert.deepEqual(disk.plans, backup.plans);
        assert.equal(disk.runs.length, 2);
        const resumed = await runPlanCLI(
          root,
          restored.id,
          plan.id,
          environmentId,
        );
        assert.equal(resumed.code, 0, resumed.stderr);
        check(JSON.parse(resumed.stdout));
        checkWire(9);
        const persisted = await new Store(root).get(restored.id);
        assert.equal(persisted.runs.length, 3);
        assert(
          persisted.runs.every(
            (run) =>
              run.snapshot.id === plan.id &&
              run.environmentId === environmentId,
          ),
        );
        assert.deepEqual(await app.store.get(source.id), sourceBefore);
        assert.deepEqual(await app.store.get(other.id), otherBefore);
        assert.deepEqual(document, untouchedInput);
      },
    );
