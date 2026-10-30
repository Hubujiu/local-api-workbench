import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import {
  REPEAT_EVIDENCE_BYTES,
  repeatEvidenceExceeded,
} from "../src/plan-repeat.mjs";

test("repeat evidence byte threshold is an exclusive soft stop, not a transport limit", () => {
  assert.equal(REPEAT_EVIDENCE_BYTES, 8 * 1024 * 1024);
  assert.equal(repeatEvidenceExceeded(REPEAT_EVIDENCE_BYTES - 1), false);
  assert.equal(repeatEvidenceExceeded(REPEAT_EVIDENCE_BYTES), false);
  assert.equal(repeatEvidenceExceeded(REPEAT_EVIDENCE_BYTES + 1), true);
});

test("real repeated HTTP evidence stops before the next occurrence, preserves terminal records, and bounded SDK stdio never suggests replay", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repeat-evidence-"));
  const body = "x".repeat(3 * 1024 * 1024);
  let requests = 0;
  const peer = http.createServer((_req, res) => {
    requests++;
    res.end(body);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const app = await createApp({ root, port: 0 });
  let client;
  t.after(async () => {
    await client?.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("evidence fixture");
  const plan = snapshotPlan({
    name: "Evidence bounded repetition",
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 5,
        steps: [
          {
            id: "leaf",
            request: { url: `http://127.0.0.1:${peer.address().port}` },
          },
        ],
      },
    ],
  });
  plan.steps[0] = {
    type: "repeat",
    id: "outer-evidence",
    name: "outer",
    enabled: true,
    count: 1,
    steps: [plan.steps[0]],
  };
  p.plans.push(plan);
  await app.store.save(p);
  const response = await fetch(app.url + `/api/projects/${p.id}/run`, {
    method: "POST",
    headers: {
      "x-local-token": app.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ planId: plan.id }),
  });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "evidence-limit");
  assert.equal(run.recordSaved, true);
  assert.equal(run.recordId, run.id);
  assert.equal(run.results.length, 3);
  assert.equal(requests, 3);
  assert.deepEqual(
    run.results.map((r) => r.status),
    ["passed", "passed", "passed"],
  );
  assert.deepEqual(
    run.results.map((r) => r.repeat.iteration),
    [0, 1, 2],
  );
  for (const r of run.results) assert.equal(r.response.body, body);
  assert.equal(run.evidenceBudget.executed, 3);
  assert.equal(run.evidenceBudget.remaining, 2);
  assert.equal(run.evidenceBudget.next.repeat.iteration, 3);
  assert.equal(run.evidenceBudget.last.repeat.iteration, 2);
  assert.deepEqual(run.evidenceBudget.next.repeat.path, [
    { groupId: "outer-evidence", iteration: 0 },
    { groupId: "group", iteration: 3 },
  ]);
  assert.deepEqual(run.evidenceBudget.last.repeat.path, [
    { groupId: "outer-evidence", iteration: 0 },
    { groupId: "group", iteration: 2 },
  ]);
  assert.ok(run.evidenceBudget.recordedBytes > REPEAT_EVIDENCE_BYTES);
  assert.equal((await new Store(root).get(p.id)).runs[0].results.length, 3);
  client = new Client({ name: "repeat-bounded-output", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve(import.meta.dirname, "../src/mcp.mjs"),
        "--project",
        p.id,
        "--execute",
        "--write",
      ],
      env: { ...process.env, LOCAL_API_DATA: root },
      stderr: "pipe",
    }),
  );
  await assert.rejects(
    client.callTool({
      name: "localapi_run_plan",
      arguments: { projectId: p.id, planId: plan.id },
    }),
    /inspect history, do not replay/,
  );
  assert.equal(requests, 6);
  const historyResult = await client.callTool({
    name: "localapi_list_execution_runs",
    arguments: { projectId: p.id },
  });
  assert.notEqual(historyResult.isError, true);
  const history = JSON.parse(historyResult.content[0].text);
  assert.equal(history.length, 2);
  assert.equal(history[0].status, "failed");
  assert.equal(history[0].stopReason, "evidence-limit");
  assert.equal(history[0].evidenceBudget.remaining, 2);
  const durable = await new Store(root).get(p.id);
  assert.equal(durable.runs.length, 2);
  assert.equal(durable.runs[0].id, history[0].id);
  assert.equal(durable.runs[0].results.length, 3);
  assert.equal(
    requests,
    6,
    "output limit and read-only history do not replay any network",
  );
  const finalOnly = structuredClone(plan);
  finalOnly.steps[0].steps[0].count = 3;
  const finalRun = await runPlan(finalOnly, {}, executeRequest);
  assert.equal(finalRun.status, "passed");
  assert.equal(
    finalRun.stopReason,
    undefined,
    "crossing after the final occurrence does not invent unexecuted work",
  );
  assert.equal(finalRun.results.length, 3);
  assert.equal(requests, 9);
  const controller = new AbortController();
  const cancelled = await runPlan(plan, {}, executeRequest, {
    signal: controller.signal,
    onStep: (r) => {
      if (r.repeat.iteration === 2) controller.abort();
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stopReason, undefined);
  assert.equal(cancelled.results.length, 3);
  assert.equal(requests, 12);
});
