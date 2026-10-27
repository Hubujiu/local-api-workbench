import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
import { nativeSampleExportFixture } from "./fixtures/apipost-sample-export.mjs";
import { runPlanCLI } from "./helpers/run-plan-cli.mjs";
import { caseRunOrder } from "../public/case-folders.js";
const orderedCases = (p) => p.requests.flatMap((r) => caseRunOrder(p, r.id));
const graph = (p) => ({
  cases: orderedCases(p).map((c) => ({
    name: c.name,
    api: p.requests.findIndex((r) => r.id === c.sourceRequestId),
    group: c.folderId
      ? p.caseFolders.findIndex((g) => g.id === c.folderId)
      : -1,
    body: c.request.body,
    url: c.request.url,
    flags: [
      c.request.serviceSnapshot,
      c.request.parametersSnapshot,
      c.request.authSnapshot,
      c.request.sharedScriptsSnapshot,
    ],
  })),
  groups: p.caseFolders.map((g) => ({
    name: g.name,
    sort: g.sort,
    api: p.requests.findIndex((r) => r.id === g.sourceRequestId),
    parent: g.parentId
      ? p.caseFolders.findIndex((x) => x.id === g.parentId)
      : -1,
  })),
});
for (const transport of ["http", "stdio"])
  for (const format of ["apipost", "apipost-directory"])
    test(
      `native samples ${transport}/${format} preserve frozen case graphs through SDK CLI and restored history`,
      { timeout: 45000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "sample-entry-")),
          seen = [];
        const peer = http.createServer(async (req, res) => {
          let body = "";
          for await (const chunk of req) body += chunk;
          seen.push({
            url: req.url,
            body,
            auth: req.headers.authorization,
            live: req.headers["x-live-only"],
          });
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        });
        peer.listen(0, "127.0.0.1");
        await once(peer, "listening");
        let app = await createApp({ root, port: 0 }),
          client;
        const closeApp = async () => {
          app.server.closeAllConnections();
          await app.close();
        };
        t.after(async () => {
          await client?.close().catch(() => {});
          await closeApp();
          peer.closeAllConnections();
          await new Promise((r) => peer.close(r));
          await rm(root, { recursive: true, force: true });
        });
        const owner = async (route, method = "GET", body, status = 200) => {
          const response = await fetch(app.url + route, {
            method,
            headers: {
              "content-type": "application/json",
              "x-local-token": app.token,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const result = await response.json();
          assert.equal(response.status, status, JSON.stringify(result));
          return result;
        };
        const source = await app.store.create("source"),
          first = await app.store.create("first"),
          second = await app.store.create("second"),
          other = await app.store.create("isolated");
        const input = nativeSampleExportFixture(
            `http://127.0.0.1:${peer.address().port}`,
          ),
          inputBefore = structuredClone(input);
        importIntoProject(source, input);
        await app.store.save(source);
        const expected = graph(source),
          sourceBefore = await app.store.get(source.id),
          otherBefore = await app.store.get(other.id),
          firstBefore = await app.store.get(first.id);
        const connect = async (write, execute) => {
          await client?.close().catch(() => {});
          client = new Client(
            { name: "sample-interchange", version: "1" },
            { capabilities: {} },
          );
          const projects = [source.id, first.id, second.id];
          if (transport === "http") {
            const config = await owner("/api/mcp/config", "POST", {
              enabled: true,
              projects,
              write,
              execute,
              remember: false,
            });
            await client.connect(
              new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
                requestInit: {
                  headers: { Authorization: "Bearer " + config.token },
                },
              }),
            );
          } else {
            const wire = new StdioClientTransport({
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
                ...projects.flatMap((id) => ["--project", id]),
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
        const call = async (name, args) => {
          const r = await raw(name, args);
          assert.notEqual(r.isError, true, JSON.stringify(r));
          return JSON.parse(r.content[0].text);
        };
        await connect(false, false);
        const exported = await call("export_project", {
          projectId: source.id,
          format,
        });
        assert.equal(
          (
            await raw("import_project", {
              projectId: first.id,
              format,
              document: exported.document,
            })
          ).isError,
          true,
        );
        assert.equal(
          (await raw("export_project", { projectId: other.id, format }))
            .isError,
          true,
        );
        assert.deepEqual(await app.store.get(first.id), firstBefore);
        await connect(true, false);
        const imported = await call("import_project", {
          projectId: first.id,
          format,
          document: exported.document,
        });
        const generationOne = await app.store.get(first.id);
        assert.deepEqual(graph(generationOne), expected);
        assert.equal(imported.imported.requestIds.length, 2);
        const exportedAgain = await call("export_project", {
          projectId: first.id,
          format,
        });
        await call("import_project", {
          projectId: second.id,
          format,
          document: exportedAgain.document,
        });
        let saved = await app.store.get(second.id);
        assert.deepEqual(graph(saved), expected);
        assert.equal(saved.cases.length, 3);
        assert.equal(saved.caseFolders.length, 2);
        assert.equal(
          saved.cases.some((c) => c.folderId === saved.caseFolders[1].id),
          false,
        );
        assert.deepEqual(seen, [], "definition conversion is inert");
        // Test the actual inheritance guard before plans could independently reject export.
        const originalHeader = structuredClone(saved.requests[0].headers);
        saved.requests[0].headers.push({
          key: "X-Live-Only",
          value: "not-frozen",
          enabled: true,
        });
        await app.store.save(saved);
        const rejectedBefore = await app.store.get(second.id);
        const rejected = await raw("export_project", {
          projectId: second.id,
          format,
        });
        assert.equal(rejected.isError, true);
        assert.match(JSON.stringify(rejected), /冻结请求语义|重新注入/);
        assert.deepEqual(await app.store.get(second.id), rejectedBefore);
        assert.deepEqual(seen, []);
        saved = await app.store.get(second.id);
        saved.requests[0].headers = originalHeader;
        await app.store.save(saved);
        const environmentId = saved.environments.find((e) =>
          Object.hasOwn(e.variables, "id"),
        ).id;
        const frozenCases = structuredClone(saved.cases);
        const plan = await call("create_execution_flow", {
          projectId: second.id,
          plan: {
            name: "three frozen samples",
            environmentId,
            steps: orderedCases(saved).map((c) => ({
              name: c.name,
              request: c.request,
            })),
          },
        });
        assert.equal(
          (await raw("run_plan", { projectId: second.id, planId: plan.id }))
            .isError,
          true,
        );
        assert.deepEqual(seen, []);
        const live = await app.store.get(second.id);
        for (const api of live.requests) {
          api.url = "http://127.0.0.1:1/live";
          api.auth = { type: "bearer", token: "fictional-live" };
          api.headers.push({ key: "X-Live-Only", value: "injected" });
          api.query.push({ key: "liveOnly", value: "injected" });
          api.body = '{"changed":true}';
        }
        await app.store.save(live);
        const checkRun = (run) => {
          assert.equal(run.status, "passed", JSON.stringify(run));
          assert.equal(run.recordSaved, true);
          assert.equal(run.recordId, run.id);
          assert.equal(run.attemptedRecordId, run.id);
          assert.equal(run.environmentId, environmentId);
          assert.deepEqual(run.snapshot.steps, plan.steps);
          assert.equal(run.results.length, 3);
          assert(run.results.every((r) => r.status === "passed"));
        };
        const checkWire = (count) => {
          assert.equal(seen.length, count * 3);
          for (let i = 0; i < seen.length; i++) {
            assert.equal(
              seen[i].url,
              ["/case-root", "/case-grouped", "/case-other"][i % 3],
            );
            assert.equal(seen[i].auth, undefined);
            assert.equal(seen[i].live, undefined);
            assert.equal(JSON.parse(seen[i].body).id, "43");
            assert.equal(
              JSON.parse(seen[i].body).case,
              ["root", "grouped", "other"][i % 3],
            );
          }
        };
        const checkDisk = async (id, run, count) => {
          const p = await new Store(root).get(id);
          assert.deepEqual(p.cases, frozenCases);
          assert.equal(p.runs.length, count);
          assert.deepEqual(
            p.runs.find((r) => r.id === run.id).results,
            run.results,
          );
        };
        await connect(true, true);
        const runOne = await call("run_plan", {
          projectId: second.id,
          planId: plan.id,
        });
        checkRun(runOne);
        checkWire(1);
        await checkDisk(second.id, runOne, 1);
        assert.equal(
          (await call("get_run", { projectId: second.id, runId: runOne.id }))
            .id,
          runOne.id,
        );
        await client.close();
        client = null;
        const cli = await runPlanCLI(root, second.id, plan.id, environmentId);
        assert.equal(cli.code, 0, cli.stderr);
        const runTwo = JSON.parse(cli.stdout);
        checkRun(runTwo);
        checkWire(2);
        await checkDisk(second.id, runTwo, 2);
        const backup = await owner(`/api/projects/${second.id}/export`),
          restored = await owner(
            "/api/restore",
            "POST",
            { document: backup },
            201,
          );
        assert.deepEqual(restored.cases, backup.cases);
        assert.deepEqual(restored.caseFolders, backup.caseFolders);
        assert.deepEqual(restored.plans, backup.plans);
        await closeApp();
        app = await createApp({ root, port: 0 });
        const again = await runPlanCLI(
          root,
          restored.id,
          plan.id,
          environmentId,
        );
        assert.equal(again.code, 0, again.stderr);
        const runThree = JSON.parse(again.stdout);
        checkRun(runThree);
        checkWire(3);
        await checkDisk(restored.id, runThree, 3);
        assert.equal(new Set([runOne.id, runTwo.id, runThree.id]).size, 3);
        assert.equal((await new Store(root).get(second.id)).runs.length, 2);
        assert.deepEqual(await app.store.get(source.id), sourceBefore);
        assert.deepEqual(await app.store.get(other.id), otherBefore);
        assert.deepEqual(input, inputBefore);
      },
    );
