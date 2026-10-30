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
    let firstReply, childExit;
    lines.on("line", (line) => {
      firstReply ??= line;
    });
    child.on("exit", (code, signal) => {
      childExit = { code, signal };
    });
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
    let running, lastState;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await config();
      lastState = state;
      assert.equal(state.enabled, false);
      running = state.activities.find(
        (row) => row.source === "stdio" && row.completed === 1,
      );
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert(
      running,
      "stdio progress did not arrive: " +
        JSON.stringify({
          stderr: errors,
          firstReply,
          childExit,
          requests,
          state: lastState,
        }),
    );
    if (running.status !== "running")
      await Promise.race([
        response,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    assert.equal(
      running.status,
      "running",
      "stdio stopped before the gated second response: " +
        JSON.stringify({
          running,
          stderr: errors,
          firstReply,
          childExit,
          requests,
        }),
    );
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

test("MCP activity metadata is bounded and cancellation save failures remain readable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-activity-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const patch of [
    { planId: "x".repeat(10000) },
    { tool: "x".repeat(129) },
    { projectId: "bad\nproject" },
  ])
    assert.throws(
      () => new MCPActivity(root, { tool: "run", projectId: "p", ...patch }),
      /元数据/,
    );
  const activity = await new MCPActivity(root, {
    tool: "run",
    projectId: "p",
    planId: "plan",
  }).start();
  await activity.update({ stepId: "x".repeat(10000), completed: 1 });
  await activity.finish(false, { status: "cancelled", recordSaved: false });
  const [row] = await readMCPActivities(root);
  assert.equal(row.status, "failed");
  assert.equal(row.executionStatus, "cancelled");
  assert.equal(row.recordSaved, false);
  assert.equal(row.stepId, undefined);
  assert.equal(row.stepIdOmitted, true);
  assert(Buffer.byteLength(JSON.stringify(row)) <= 4096);
  const deliveredFailure = await new MCPActivity(root, {
    tool: "run",
    projectId: "q",
  }).start();
  await deliveredFailure.finish(true, {
    status: "cancelled",
    recordSaved: true,
  });
  const outputFailed = (await readMCPActivities(root)).find(
    (record) => record.projectId === "q",
  );
  assert.equal(outputFailed.status, "failed");
  assert.equal(outputFailed.executionStatus, "cancelled");
  assert.equal(outputFailed.recordSaved, true);
  assert.equal(outputFailed.persistenceError, undefined);
});

test("nested activity preserves complete identities or omits unsafe/oversized paths without invoking accessors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-activity-"));
  const activity = await new MCPActivity(root, {
    tool: "localapi_run_plan",
    projectId: "p",
    planId: "plan",
  }).start();
  t.after(async () => {
    await activity.finish();
    await rm(root, { recursive: true, force: true });
  });
  const repeatPath = [
    { groupId: "outer", iteration: 1 },
    { groupId: "inner", iteration: 0 },
  ];
  const repeat = {
    groupId: "inner",
    childId: "leaf",
    iteration: 0,
    occurrenceId: '[[["outer",1],["inner",0]],"leaf"]',
    path: repeatPath,
  };
  await activity.update({ repeat });
  assert.deepEqual((await readMCPActivities(root))[0].repeat, repeat);
  let accessed = false;
  const getter = { groupId: "outer" };
  Object.defineProperty(getter, "iteration", {
    enumerable: true,
    get() {
      accessed = true;
      throw Error("must not invoke");
    },
  });
  const hidden = { ...repeat };
  Object.defineProperty(hidden, "path", {
    value: repeatPath,
    enumerable: false,
  });
  const pathGetter = { ...repeat };
  Object.defineProperty(pathGetter, "path", {
    enumerable: true,
    get() {
      accessed = true;
      throw Error("must not invoke");
    },
  });
  for (const invalid of [
    { ...repeat, path: new Array(2) },
    { ...repeat, path: [getter, repeatPath[1]] },
    hidden,
    pathGetter,
    { ...repeat, occurrenceId: "x".repeat(1501) },
    { ...repeat, path: [{ ...repeatPath[0], extra: true }, repeatPath[1]] },
  ]) {
    await activity.update({ repeat: invalid });
    const [row] = await readMCPActivities(root);
    assert.equal(row.repeat, undefined);
    assert.equal(row.repeatOmitted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 4096);
  }
  assert.equal(accessed, false);
  await activity.update({ stepId: "ordinary" });
  assert.equal((await readMCPActivities(root))[0].repeatOmitted, undefined);
});
