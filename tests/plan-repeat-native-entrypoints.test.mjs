import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { runPlanCLI } from "./helpers/run-plan-cli.mjs";

const pick = (source, expression, name, type) => ({
  id: name,
  name,
  type: "pickVars",
  enabled: 1,
  data: { source, variables: [{ expression, name, type }] },
});
const stop = async (app) => {
  app.server.closeAllConnections();
  await app.close();
};
for (const transport of ["http", "stdio"])
  test(
    `repeat BEFORE Header/JSON5 picks retain strict stop through official ${transport} SDK, CLI and restored restart`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "repeat-native-entry-"));
      const seen = [];
      let ordinal = 0;
      const peer = http
        .createServer(async (req, res) => {
          let body = "";
          for await (const chunk of req) body += chunk;
          seen.push({ url: req.url, header: req.headers["x-source"], body });
          res.statusCode = ++ordinal === 2 ? 500 : 200;
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        })
        .listen(0, "127.0.0.1");
      await once(peer, "listening");
      let app = await createApp({ root, port: 0 }),
        client;
      t.after(async () => {
        await client?.close().catch(() => {});
        await stop(app);
        peer.closeAllConnections();
        await new Promise((resolve) => peer.close(resolve));
        await rm(root, { recursive: true, force: true });
      });
      const owner = async (route, data, status = 200) => {
        const response = await fetch(app.url + route, {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value));
        return value;
      };
      const project = await app.store.create("Native repeat"),
        other = await app.store.create("Isolated");
      const isolated = await app.store.get(other.id);
      const document = modernApipostFixture();
      document.global.envs = [];
      document.global.servers = [];
      document.global.global_vars = {};
      document.global.global_param.pre_tasks = [];
      document.global.global_param.post_tasks = [];
      document.apis[0].request.pre_tasks = [];
      document.apis[0].request.post_tasks = [];
      const source = document.apis[1];
      source.url = `http://127.0.0.1:${peer.address().port}/repeat`;
      source.method = "POST";
      source.request.query.parameter = [];
      source.request.header.parameter = [
        { key: "X-Source", value: "frozen-header", is_checked: 1 },
      ];
      const rawBody =
        "{/* literal snapshot */ token:'body-token', number:0x3, list:[1,2,],}";
      source.request.body = {
        mode: "raw",
        raw: rawBody,
        raw_lang: "json",
        parameter: [],
        raw_parameter: [],
      };
      source.request.pre_tasks = [
        pick("requestHeader", " x-source ", "preHeader", "envVars"),
        pick("requestBody", "$.token", "preBody", "globalVars"),
        pick("requestBody", "$.number", "preNumber", "envVars"),
      ];
      source.request.post_tasks = [];
      const original = structuredClone(document);
      await owner(`/api/projects/${project.id}/import`, { document });
      assert.deepEqual(document, original);
      const imported = await app.store.get(project.id);
      const request = imported.requests[0];
      assert.equal(request.body, rawBody);
      client = new Client(
        { name: "native-repeat", version: "1" },
        { capabilities: {} },
      );
      if (transport === "http") {
        const config = await owner("/api/mcp/config", {
          enabled: true,
          projects: [project.id],
          write: true,
          execute: true,
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
        const pipe = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            project.id,
            "--write",
            "--execute",
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        pipe.stderr.resume();
        await client.connect(pipe);
      }
      const call = async (name, args) => {
        const value = await client.callTool({
          name: "localapi_" + name,
          arguments: args,
        });
        assert.notEqual(value.isError, true, JSON.stringify(value));
        return JSON.parse(value.content[0].text);
      };
      const plan = await call("create_execution_flow", {
        projectId: project.id,
        plan: {
          name: "Request snapshots in repeat",
          environmentId: imported.environments[0].id,
          steps: [
            {
              type: "repeat",
              id: "group",
              count: 3,
              steps: [{ id: "child", request }],
            },
            {
              id: "after",
              request: {
                url: source.url + "/must-not-run",
                inheritSharedScripts: false,
              },
            },
          ],
        },
      });
      assert.equal(seen.length, 0);
      const live = await app.store.get(project.id);
      live.requests[0].url += "/live-only";
      live.requests[0].headers[0].value = "live-only";
      live.requests[0].body = "{token:'live-only'}";
      await app.store.save(live);
      const verify = async (run, projectId, expectedRuns) => {
        assert.equal(run.status, "failed");
        assert.equal(run.recordSaved, true);
        assert.equal(run.recordId, run.id);
        assert.equal(run.attemptedRecordId, run.id);
        assert.deepEqual(
          run.results.map((r) => [
            r.stepId,
            r.repeat.iteration,
            r.status,
            r.response.status,
          ]),
          [
            ["child", 0, "passed", 200],
            ["child", 1, "failed", 500],
          ],
        );
        assert.match(run.results[1].error, /成功前置变量已提交/);
        assert.equal(
          new Set(run.results.map((r) => r.repeat.occurrenceId)).size,
          2,
        );
        assert.deepEqual(run.snapshot.steps, plan.steps);
        assert.equal(
          run.planHash,
          createHash("sha256")
            .update(JSON.stringify(run.snapshot))
            .digest("hex"),
        );
        assert.equal(
          ordinal,
          2,
          "third iteration and trailing step were never sent",
        );
        assert.deepEqual(
          seen.slice(-2),
          [0, 1].map(() => ({
            url: "/repeat",
            header: "frozen-header",
            body: rawBody,
          })),
        );
        const saved = await new Store(root).get(projectId);
        assert.equal(
          saved.environments[0].variables.preHeader,
          "frozen-header",
        );
        assert.equal(saved.environments[0].variables.preNumber, 3);
        assert.equal(saved.globalVariables.preBody, "body-token");
        assert.equal(saved.runs.length, expectedRuns);
        assert(saved.runs.some((r) => r.id === run.recordId));
        assert.deepEqual(await app.store.get(other.id), isolated);
      };
      ordinal = 0;
      await verify(
        await call("run_plan", { projectId: project.id, planId: plan.id }),
        project.id,
        1,
      );
      ordinal = 0;
      const cli = await runPlanCLI(root, project.id, plan.id);
      assert.equal(cli.code, 1, cli.stderr);
      await verify(JSON.parse(cli.stdout), project.id, 2);
      const backup = await app.store.get(project.id);
      const restored = await owner("/api/restore", { document: backup }, 201);
      assert.equal(seen.length, 4, "backup restore performs no replay");
      await client.close();
      client = undefined;
      await stop(app);
      app = await createApp({ root, port: 0 });
      ordinal = 0;
      const afterRestart = await runPlanCLI(root, restored.id, plan.id);
      assert.equal(afterRestart.code, 1, afterRestart.stderr);
      await verify(JSON.parse(afterRestart.stdout), restored.id, 3);
      assert.deepEqual(await app.store.get(project.id), backup);
      assert.equal(seen.length, 6);
    },
  );
