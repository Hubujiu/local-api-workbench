import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { MCPActivity, readMCPActivities } from "../src/mcp-activity.mjs";
import { createApp } from "../src/server.mjs";
import { snapshotPlan } from "../src/core.mjs";
test("MCP activity journal tracks safe progress and does not leave stale work running", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-activity-"));
  const activity = await new MCPActivity(root, {
    tool: "localapi_run_plan",
    projectId: "p",
    planId: "plan",
    secret: "not-persisted",
  }).start();
  t.after(async () => {
    await activity.finish();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  await activity.update({
    completed: 1,
    total: 2,
    stepId: "one",
    stepStatus: "failed",
    body: "not-persisted",
  });
  let [row] = await readMCPActivities(root);
  assert.equal(row.status, "running");
  assert.equal(row.completed, 1);
  assert(!JSON.stringify(row).includes("not-persisted"));
  [row] = await readMCPActivities(root, Date.now() + 11000);
  assert.equal(row.status, "interrupted");
  await activity.finish();
  [row] = await readMCPActivities(root);
  assert.equal(row.status, "failed");
});
test(
  "independent stdio process exposes step progress to the local UI without enabling HTTP MCP",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-stdio-progress-"));
    const app = await createApp({ root, port: 0 });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const fixture = http.createServer(async (_req, res) => {
      if (++requests === 2) await gate;
      res.end("{}");
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    let child;
    t.after(async () => {
      release();
      child?.kill();
      await new Promise((resolve) => fixture.close(resolve));
      await new Promise((resolve) => app.server.close(resolve));
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const project = await app.store.create("observable");
    project.plans = [
      snapshotPlan({
        name: "two steps",
        steps: [1, 2].map((n) => ({
          name: "step " + n,
          request: { url: "http://127.0.0.1:" + fixture.address().port },
        })),
      }),
    ];
    await app.store.save(project);
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
        "--project",
        project.id,
        "--write",
        "--execute",
      ],
      {
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let errors = "";
    child.stderr.on("data", (part) => {
      errors += part;
    });
    const lines = readline.createInterface({ input: child.stdout });
    const response = once(lines, "line");
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "localapi_run_plan",
          arguments: { projectId: project.id, planId: project.plans[0].id },
        },
      }) + "\n",
    );
    const config = async () => {
      const r = await fetch(app.url + "/api/mcp/config", {
        headers: { "x-local-token": app.token },
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    let running;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await config();
      assert.equal(state.enabled, false);
      running = state.activities.find(
        (row) => row.source === "stdio" && row.completed === 1,
      );
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert(running, "stdio progress did not arrive: " + errors);
    assert.equal(running.status, "running");
    assert.equal(running.total, 2);
    assert.equal(running.projectId, project.id);
    release();
    const [line] = await response;
    const answer = JSON.parse(line);
    assert.equal(answer.result.isError, undefined);
    assert.equal(JSON.parse(answer.result.content[0].text).status, "passed");
    const finished = (await config()).activities.find(
      (row) => row.id === running.id,
    );
    assert.equal(finished.status, "completed");
    assert.equal(finished.completed, 2);
    const closed = once(child, "close");
    child.stdin.end();
    await closed;
    lines.close();
  },
);
