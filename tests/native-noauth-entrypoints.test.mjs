import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import {
  normalizeRequest,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
const decode = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
function cli(root, projectId, planId, environmentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
        ...(environmentId === undefined
          ? []
          : ["--environment", environmentId]),
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("Noauth CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI output exceeds bound");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}
for (const [transport, format] of [
  ["http", "apipost"],
  ["stdio", "apipost-directory"],
  ["http", "postman"],
  ["stdio", "openapi"],
])
  test(
    `explicit imported noauth ${transport}/${format} stays isolated through real frozen MCP CLI and restore`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "native-noauth-")),
        wire = [];
      const upstream = http.createServer((req, res) => {
        wire.push({ path: req.url, auth: req.headers.authorization });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
      });
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${upstream.address().port}`;
      let app = await createApp({ root, port: 0 }),
        client;
      t.after(async () => {
        await client?.close().catch(() => {});
        await closeServer(app.server);
        await closeServer(upstream);
        await rm(root, { recursive: true, force: true });
      });
      const source = await app.store.create("Explicit none"),
        target = await app.store.create("Has shared auth"),
        other = await app.store.create("Other project");
      const sourceRequest = normalizeRequest({
        id: "source-public",
        name: "Public",
        folder: "Public",
        url: base + "/public",
        auth: { type: "none" },
        inheritAuth: false,
        inheritSharedScripts: false,
        scriptDialect: "apipost8",
      });
      source.requests = [sourceRequest];
      source.folders = ["Public"];
      if (format === "apipost-directory")
        source.plans = [
          snapshotPlan({
            name: "Source native frozen",
            statusPolicy: "strict200",
            environmentId: source.environments[0].id,
            steps: [{ request: sourceRequest }],
          }),
        ];
      await app.store.save(source);
      target.settings.globalAuth = {
        type: "bearer",
        token: "fictional-destination-global",
      };
      target.settings.folderAuth = {
        Public: {
          type: "basic",
          username: "fictional-folder",
          password: "fictional-only",
        },
      };
      target.folders = ["Public"];
      target.environments.push({
        id: "override-env",
        name: "Override identity",
        variables: structuredClone(target.environments[0].variables),
      });
      target.requests = [
        normalizeRequest({
          id: "control",
          name: "Global control",
          url: base + "/control",
          inheritSharedScripts: false,
        }),
        normalizeRequest({
          id: "folder-control",
          name: "Folder control",
          folder: "Public",
          url: base + "/folder-control",
          inheritSharedScripts: false,
        }),
      ];
      await app.store.save(target);
      const sourceBefore = await app.store.get(source.id),
        otherBefore = await app.store.get(other.id);
      client = new Client(
        { name: "noauth-interchange", version: "1" },
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
            projects: [source.id, target.id],
            write: true,
            execute: true,
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
      } else {
        const stdio = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            source.id,
            "--project",
            target.id,
            "--write",
            "--execute",
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        stdio.stderr.resume();
        await client.connect(stdio);
      }
      const call = async (name, args) =>
        decode(
          await client.callTool({ name: "localapi_" + name, arguments: args }),
        );
      let imported;
      if (format === "apipost" || format === "apipost-directory") {
        const exported = await call("export_project", {
          projectId: source.id,
          format,
        });
        imported = await call("import_project", {
          projectId: target.id,
          format,
          document: exported.document,
        });
      } else {
        const document =
          format === "postman"
            ? {
                info: { name: "Explicit Postman opt-out" },
                item: [
                  {
                    name: "Public",
                    item: [
                      {
                        name: "Public",
                        request: {
                          method: "GET",
                          url: base + "/public",
                          auth: { type: "noauth" },
                        },
                      },
                    ],
                  },
                ],
              }
            : {
                openapi: "3.0.3",
                info: { title: "Explicit OpenAPI opt-out", version: "1" },
                servers: [{ url: base }],
                security: [{ sourceBearer: [] }],
                components: {
                  securitySchemes: {
                    sourceBearer: { type: "http", scheme: "bearer" },
                  },
                },
                paths: {
                  "/public": {
                    get: {
                      operationId: "public",
                      summary: "Public",
                      tags: ["Public"],
                      security: [],
                      responses: { 200: { description: "ok" } },
                    },
                  },
                },
              };
        const original = structuredClone(document);
        // These formats are accepted by the owner import API, not by the
        // explicitly native-only MCP interchange tool. Execution still uses
        // the same real MCP/CLI frozen-plan path below.
        const response = await fetch(
          app.url + `/api/projects/${target.id}/import`,
          {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({ document }),
          },
        );
        const output = await response.json();
        assert.equal(response.status, 200, JSON.stringify(output));
        assert.deepEqual(document, original);
        imported = {
          imported: {
            requestIds: output.requests
              .filter((request) => request.name === "Public")
              .map((request) => request.id),
            planIds: [],
          },
        };
        assert.equal(imported.imported.requestIds.length, 1);
      }
      let saved = await app.store.get(target.id);
      const request = saved.requests.find(
        (r) => r.id === imported.imported.requestIds[0],
      );
      assert.equal(request.auth.type, "none");
      assert.deepEqual(wire, [], "format conversion must not execute requests");
      const plan = await call("create_execution_flow", {
        projectId: target.id,
        plan: {
          name: "Noauth frozen",
          environmentId: saved.environments[0].id,
          steps: [{ request }],
        },
      });
      const checkRun = (run, frozenDefault = plan.environmentId) => {
        assert.equal(run.environmentId, "override-env");
        assert.equal(run.snapshot.environmentId, frozenDefault);
        assert.equal(run.status, "passed", JSON.stringify(run));
        assert.equal(run.recordSaved, true);
        assert.deepEqual(JSON.parse(run.results[0].response.body), {
          auth: null,
        });
        assert.equal(run.results[0].request.auth.type, "none");
      };
      checkRun(
        await call("execute_flow", {
          projectId: target.id,
          planId: plan.id,
          environmentId: "override-env",
        }),
      );
      assert.equal(request.inheritAuth, false);
      if (format === "apipost-directory") {
        assert.equal(imported.imported.planIds.length, 1);
        checkRun(
          await call("execute_flow", {
            projectId: target.id,
            planId: imported.imported.planIds[0],
            environmentId: "override-env",
          }),
          saved.plans.find((p) => p.id === imported.imported.planIds[0])
            .environmentId,
        );
      }
      const controls = await call("create_execution_flow", {
        projectId: target.id,
        plan: {
          name: "Keep normal inheritance",
          environmentId: saved.environments[0].id,
          steps: target.requests.map((request) => ({ request })),
        },
      });
      const controlRun = await call("execute_flow", {
        projectId: target.id,
        planId: controls.id,
      });
      assert.equal(controlRun.status, "passed");
      assert.equal(controlRun.environmentId, controls.environmentId);
      assert.equal(
        JSON.parse(controlRun.results[0].response.body).auth,
        "Bearer fictional-destination-global",
      );
      assert.equal(
        JSON.parse(controlRun.results[1].response.body).auth,
        "Basic " +
          Buffer.from("fictional-folder:fictional-only").toString("base64"),
      );
      await client.close();
      client = null;
      saved = await app.store.get(target.id);
      saved.settings.globalAuth = {
        type: "bearer",
        token: "fictional-later-global",
      };
      saved.settings.folderAuth.Public = {
        type: "bearer",
        token: "fictional-later-folder",
      };
      const live = saved.requests.find((r) => r.id === request.id);
      live.inheritAuth = true;
      live.auth = { type: "bearer", token: "fictional-live-change" };
      await app.store.save(saved);
      const result = await cli(root, target.id, plan.id, "override-env");
      assert.equal(result.code, 0, result.stderr);
      checkRun(JSON.parse(result.stdout));
      const persisted = await app.store.get(target.id),
        restored = restoreProject(persisted);
      for (const project of [persisted, restored]) {
        const records = project.runs.filter(
          (run) => run.snapshot?.id === plan.id,
        );
        assert(
          records.length >= 2,
          "both MCP and CLI records must actually exist",
        );
        assert(records.every((run) => run.environmentId === "override-env"));
      }
      await app.store.save(restored);
      await closeServer(app.server);
      app = await createApp({ root, port: 0 });
      const restoredResult = await cli(
        root,
        restored.id,
        plan.id,
        "override-env",
      );
      assert.equal(restoredResult.code, 0, restoredResult.stderr);
      checkRun(JSON.parse(restoredResult.stdout));
      assert(wire.filter((r) => r.path === "/public").length >= 3);
      assert(
        wire
          .filter((r) => r.path === "/public")
          .every((r) => r.auth === undefined),
      );
      assert.deepEqual(await app.store.get(source.id), sourceBefore);
      assert.deepEqual(await app.store.get(other.id), otherBefore);
    },
  );
