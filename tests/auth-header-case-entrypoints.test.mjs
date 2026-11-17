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
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { runPlanCLI } from "./helpers/run-plan-cli.mjs";

test(
  "auth header casing is stable through owner, frozen HTTP/stdio MCP, CLI and cancellation",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "auth-header-case-"));
    const seen = [];
    let arrived;
    const held = new Promise((resolve) => {
      arrived = resolve;
    });
    const peer = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const value = {
        headers: req.headers,
        raw: req.rawHeaders,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(value);
      if (req.url === "/hold") {
        arrived();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${peer.address().port}`;
    const app = await createApp({ root, port: 0 });
    const clients = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const call = async (route, body) => {
      const response = await fetch(app.url + route, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const project = await app.store.create("Synthetic auth header case");
    project.requests = ["content-type", "Content-Type", "CONTENT-TYPE"].flatMap(
      (key) => [
        normalizeRequest({
          name: key,
          url,
          method: "POST",
          bodyType: "json",
          body: '{"fixture":true}',
          headers: [{ key: "Content-Type", value: "text/original" }],
          auth: { type: "apiKey", key, value: "application/vnd.fixture+json" },
        }),
        normalizeRequest({
          name: key + " length",
          url,
          method: "POST",
          bodyType: "raw",
          body: "界",
          auth: {
            type: "apiKey",
            key: key.replace(
              /type/i,
              key.endsWith("TYPE")
                ? "LENGTH"
                : key.endsWith("Type")
                  ? "Length"
                  : "length",
            ),
            value: "99",
          },
        }),
      ],
    );
    const plan = snapshotPlan({
      name: "Frozen auth header case",
      environmentId: project.environments[0].id,
      steps: project.requests.map((request) => ({ request })),
    });
    project.plans = [plan];
    await app.store.save(project);
    function check(response, index) {
      assert.equal(response.status, 200);
      const wire = JSON.parse(response.body);
      const key = index % 2 ? "content-length" : "content-type";
      assert.equal(
        wire.headers[key],
        index % 2 ? "3" : "application/vnd.fixture+json",
      );
      assert.equal(
        wire.raw.filter((v, i) => i % 2 === 0 && v.toLowerCase() === key)
          .length,
        1,
      );
      assert.deepEqual(
        Object.keys(response.request.headers).filter(
          (v) => v.toLowerCase() === key,
        ),
        [key],
      );
    }
    function checkRun(run) {
      assert.equal(run.status, "passed");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 6);
      run.results.forEach((step, index) => check(step.response, index));
    }
    for (const [index, request] of project.requests.entries())
      check(
        await call(`/api/projects/${project.id}/execute`, { request }),
        index,
      );
    checkRun(
      await call(`/api/projects/${project.id}/run`, { planId: plan.id }),
    );
    const config = await call("/api/mcp/config", {
      enabled: true,
      projects: [project.id],
      execute: true,
      write: true,
      remember: false,
    });
    for (const kind of ["http", "stdio"]) {
      const client = new Client(
        { name: "auth-header-case", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      const transport =
        kind === "http"
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
                project.id,
                "--write",
                "--execute",
              ],
              env: { LOCAL_API_DATA: root },
              stderr: "pipe",
            });
      if (kind === "stdio") transport.stderr.resume();
      await client.connect(transport);
      const result = await client.callTool({
        name: "localapi_execute_flow",
        arguments: { projectId: project.id, planId: plan.id },
      });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      checkRun(JSON.parse(result.content[0].text));
    }
    const cli = await runPlanCLI(root, project.id, plan.id);
    assert.equal(cli.code, 0);
    checkRun(JSON.parse(cli.stdout));
    assert.equal(seen.length, 30);
    const holdPlan = await call(`/api/projects/${project.id}/plans`, {
      name: "Cancel auth header case",
      steps: [
        { request: { ...project.requests[2], url: url + "/hold" } },
        { request: project.requests[0] },
      ],
    });
    const pending = call(`/api/projects/${project.id}/run`, {
      planId: holdPlan.id,
      runId: "auth-header-case-cancel",
    });
    assert.equal(
      await Promise.race([
        held.then(() => "arrived"),
        pending.then(() => "completed"),
      ]),
      "arrived",
    );
    await call("/api/cancel", { id: "auth-header-case-cancel" });
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.recordSaved, true);
    assert.equal(seen.length, 31);
    assert.equal(
      seen.at(-1).headers["content-type"],
      "application/vnd.fixture+json",
    );
  },
);
