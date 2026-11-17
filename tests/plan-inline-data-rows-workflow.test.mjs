import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";

test(
  "owner and official MCP SDK execute frozen data rows across restore",
  { timeout: 20000 },
  async (t) => {
    const seen = [];
    const peer = createServer((req, res) => {
      seen.push(req.headers["x-row"]);
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "inline-rows-workflow-"));
    const app = await createApp({ root, port: 0 });
    const sdk = new Client({ name: "rows-test", version: "1" });
    t.after(async () => {
      await sdk.close().catch(() => {});
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("data rows");
    const post = async (path, data) => {
      const response = await fetch(app.url + "/api/" + path, {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const url = `http://127.0.0.1:${peer.address().port}/`;
    const plan = await post(`projects/${project.id}/plans`, {
      name: "rows",
      steps: [
        {
          type: "repeat",
          id: "rows",
          count: 2,
          rows: [{ name: "first" }, { name: "second" }],
          steps: [
            {
              id: "request",
              request: {
                url,
                headers: [{ key: "x-row", value: "{{selected}}" }],
                beforeScript:
                  "pm.environment.set('selected', pm.iterationData.get('name'));",
              },
            },
          ],
        },
      ],
    });
    const owner = await post(`projects/${project.id}/run`, { planId: plan.id });
    assert.equal(owner.status, "passed");
    assert.deepEqual(seen, ["first", "second"]);
    const config = await post("mcp/config", {
      enabled: true,
      projects: [project.id],
      write: true,
      execute: true,
      remember: false,
    });
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    const response = await sdk.callTool({
      name: "localapi_run_plan",
      arguments: { projectId: project.id, planId: plan.id },
    });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    const fromSdk = JSON.parse(response.content[0].text);
    assert.equal(fromSdk.status, "passed");
    assert.deepEqual(seen, ["first", "second", "first", "second"]);
    assert.equal(fromSdk.planHash, owner.planHash);
    const document = await app.store.get(project.id);
    const restored = await app.store.restore(document);
    assert.deepEqual(restored.plans[0].steps[0].rows, [
      { name: "first" },
      { name: "second" },
    ]);
    const replay = await post(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(replay.status, "passed");
    assert.deepEqual(seen.slice(-2), ["first", "second"]);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const cli = await promisify(execFile)(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", restored.id, "--plan", plan.id],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOCAL_API_DATA: root },
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const cliRun = JSON.parse(cli.stdout);
    assert.equal(cliRun.status, "passed");
    assert.equal(cliRun.recordSaved, true);
    assert.deepEqual(seen.slice(-2), ["first", "second"]);
  },
);
