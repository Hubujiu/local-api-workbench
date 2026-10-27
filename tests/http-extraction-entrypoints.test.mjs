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
import { normalizeRequest } from "../src/core.mjs";
import { runPlanCLI } from "./helpers/run-plan-cli.mjs";

for (const transport of ["http", "stdio"])
  test(
    `ordinary HTTP extraction ${transport} SDK and CLI retain atomic lists without suppressing failed-status extraction`,
    { timeout: 45000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "http-extract-entry-")),
        seen = [];
      const peer = http.createServer((req, res) => {
        seen.push({
          url: req.url,
          runtime: req.headers["x-runtime"],
          environment: req.headers["x-environment"],
          global: req.headers["x-global"],
        });
        res.writeHead(req.url === "/failure" ? 500 : 200, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            token: req.url === "/prime" ? "committed" : "fresh",
            url: req.url,
          }),
        );
      });
      peer.listen(0, "127.0.0.1");
      await once(peer, "listening");
      const url = `http://127.0.0.1:${peer.address().port}`;
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
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value));
        return value;
      };
      const project = await app.store.create("ordinary HTTP"),
        other = await app.store.create("isolated"),
        otherBefore = await app.store.get(other.id);
      const environmentId = project.environments[0].id;
      project.environments[0].variables.envToken = "initial-environment";
      project.globalVariables.globalToken = "initial-global";
      const rows = () => [
        {
          name: "runtimeToken",
          scope: "runtime",
          source: "json",
          path: "$.token",
        },
        {
          name: "envToken",
          scope: "environment",
          source: "json",
          path: "$.token",
        },
        {
          name: "globalToken",
          scope: "global",
          source: "json",
          path: "$.token",
        },
      ];
      const requests = [
        { id: "prime", url: url + "/prime", extract: rows() },
        {
          id: "broken",
          url: url + "/broken",
          extract: [
            ...rows(),
            { name: "missing", scope: "runtime", path: "$.missing" },
          ],
        },
        { id: "old", url: url + "/echo-old" },
        {
          id: "failure",
          url: url + "/failure",
          extract: rows(),
          afterScript:
            'pm.test("complete HTTP extraction visible after 500",()=>pm.expect(pm.variables.get("runtimeToken")).to.equal("fresh"));',
        },
        { id: "new", url: url + "/echo-new" },
      ].map(normalizeRequest);
      for (const index of [2, 4])
        requests[index].headers = [
          { key: "x-runtime", value: "{{runtimeToken}}", enabled: true },
          { key: "x-environment", value: "{{envToken}}", enabled: true },
          { key: "x-global", value: "{{globalToken}}", enabled: true },
        ];
      project.requests = requests;
      await app.store.save(project);
      client = new Client(
        { name: "http-extraction", version: "1" },
        { capabilities: {} },
      );
      if (transport === "http") {
        const config = await owner("/api/mcp/config", "POST", {
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
        const wire = new StdioClientTransport({
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
        wire.stderr.resume();
        await client.connect(wire);
      }
      const raw = (name, args) =>
        client.callTool({ name: "localapi_" + name, arguments: args });
      const call = async (name, args) => {
        const value = await raw(name, args);
        assert.notEqual(value.isError, true, JSON.stringify(value));
        return JSON.parse(value.content[0].text);
      };
      const plan = await call("create_execution_flow", {
        projectId: project.id,
        plan: {
          name: "five ordinary HTTP steps",
          environmentId,
          steps: requests.map((request) => ({ request })),
        },
      });
      assert.equal(plan.steps.length, 5);
      assert.deepEqual(
        seen,
        [],
        "saving and freezing requests never sends them",
      );
      const live = await app.store.get(project.id);
      for (const request of live.requests) {
        request.url = "http://127.0.0.1:1/live-edited";
        request.extract = [];
      }
      await app.store.save(live);
      const checkRun = (run) => {
        assert.equal(run.status, "failed");
        assert.equal(run.recordSaved, true);
        assert.equal(run.recordId, run.id);
        assert.equal(run.attemptedRecordId, run.id);
        assert.equal(run.environmentId, environmentId);
        assert.deepEqual(run.snapshot.steps, plan.steps);
        assert.deepEqual(
          run.results.map((r) => r.status),
          ["passed", "failed", "passed", "failed", "passed"],
        );
        assert.deepEqual(run.results[1].extracted, {});
        assert.match(run.results[1].error, /提取|missing/);
        assert.equal(JSON.parse(run.results[1].response.body).token, "fresh");
        assert.equal(run.results[3].response.status, 500);
        assert.deepEqual(run.results[3].extracted, {
          runtimeToken: "fresh",
          envToken: "fresh",
          globalToken: "fresh",
        });
        const after = run.results[3].assertions.filter(
          (a) => a.phase === "after",
        );
        assert.equal(after.length, 1);
        assert.equal(after[0].passed, true);
      };
      const checkWire = (count) => {
        assert.equal(seen.length, count * 5);
        for (let offset = 0; offset < seen.length; offset += 5) {
          assert.deepEqual(
            seen.slice(offset, offset + 5).map((x) => x.url),
            ["/prime", "/broken", "/echo-old", "/failure", "/echo-new"],
          );
          for (const field of ["runtime", "environment", "global"]) {
            assert.equal(seen[offset + 2][field], "committed");
            assert.equal(seen[offset + 4][field], "fresh");
          }
        }
      };
      const checkDisk = async (id, run, count) => {
        const disk = await new Store(root).get(id);
        assert.equal(
          disk.environments.find((e) => e.id === environmentId).variables
            .envToken,
          "fresh",
        );
        assert.equal(disk.globalVariables.globalToken, "fresh");
        assert.equal(disk.runs.length, count);
        assert.deepEqual(
          disk.runs.find((r) => r.id === run.id).results,
          run.results,
        );
      };
      const first = await call("run_plan", {
        projectId: project.id,
        planId: plan.id,
      });
      checkRun(first);
      checkWire(1);
      await checkDisk(project.id, first, 1);
      assert.equal(
        (await call("get_run", { projectId: project.id, runId: first.id })).id,
        first.id,
      );
      assert.equal(
        (await raw("run_plan", { projectId: other.id, planId: plan.id }))
          .isError,
        true,
      );
      checkWire(1);
      await client.close();
      client = null;
      const cli = await runPlanCLI(root, project.id, plan.id, environmentId);
      assert.equal(cli.code, 1, cli.stderr);
      const second = JSON.parse(cli.stdout);
      checkRun(second);
      checkWire(2);
      await checkDisk(project.id, second, 2);
      const backup = await owner(`/api/projects/${project.id}/export`);
      const restored = await owner(
        "/api/restore",
        "POST",
        { document: backup },
        201,
      );
      assert.deepEqual(restored.plans, backup.plans);
      assert.deepEqual(restored.runs, backup.runs);
      await closeApp();
      app = await createApp({ root, port: 0 });
      const cliRestored = await runPlanCLI(
        root,
        restored.id,
        plan.id,
        environmentId,
      );
      assert.equal(cliRestored.code, 1, cliRestored.stderr);
      const third = JSON.parse(cliRestored.stdout);
      checkRun(third);
      checkWire(3);
      await checkDisk(restored.id, third, 3);
      assert.equal(new Set([first.id, second.id, third.id]).size, 3);
      assert.equal((await new Store(root).get(project.id)).runs.length, 2);
      assert.deepEqual(await new Store(root).get(other.id), otherBefore);
    },
  );
