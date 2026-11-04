import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
const expectedFailure = {
  code: "EXECUTION_PROGRESS_FAILED",
  message:
    "Execution stopped because progress reporting failed; inspect saved results, do not replay.",
  retry_safe: false,
};
for (const asynchronous of [false, true]) {
  for (const mode of ["true", "false", "condition-error", "cancelled"]) {
    test(
      (asynchronous ? "async" : "sync") +
        " terminal IF progress failure preserves " +
        mode +
        " evidence and durable identity without replay",
      { timeout: 15000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "if-progress-failure-"));
        let hits = 0;
        const peer = http.createServer((_req, res) => {
          hits++;
          res.end('{"receipt":"one-actual-effect"}');
        });
        await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
        t.after(async () => {
          peer.closeAllConnections();
          await new Promise((resolve) => peer.close(resolve));
          await rm(root, { recursive: true, force: true });
        });
        const store = new Store(root),
          project = await store.create("IF terminal reporting");
        const leaf = (id) => ({
          id,
          request: {
            url: "http://127.0.0.1:" + peer.address().port + "/" + id,
          },
        });
        const gate = (id, left, steps) => ({
          type: "if",
          id,
          condition: { left, op: "eq", right: { literal: true } },
          steps,
        });
        const plan = snapshotPlan({
          steps: [
            gate("first", { literal: mode !== "false" }, [leaf("completed")]),
            ...(mode === "condition-error"
              ? [
                  gate("missing", { scope: "runtime", name: "missing" }, [
                    leaf("never"),
                  ]),
                ]
              : []),
          ],
        });
        project.plans.push(plan);
        await store.save(project);
        let callbacks = 0,
          terminal = 0;
        const dispatch = createMCP({
          store,
          projects: [project.id],
          write: true,
          execute: true,
          onProgress: (progress) => {
            callbacks++;
            if (!progress.finished) return;
            terminal++;
            const error = Error("private-reporter-secret:" + root);
            if (asynchronous) return Promise.reject(error);
            throw error;
          },
        });
        const signal = mode === "cancelled" ? AbortSignal.abort() : undefined;
        const response = await dispatch(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "localapi_run_plan",
              arguments: { projectId: project.id, planId: plan.id },
            },
          },
          { signal },
        );
        assert.notEqual(
          response.result.isError,
          true,
          JSON.stringify(response),
        );
        const run = JSON.parse(response.result.content[0].text);
        assert.equal(run.recordSaved, true);
        assert.equal(run.recordId, run.id);
        assert.equal(run.status, mode === "cancelled" ? "cancelled" : "failed");
        assert.equal(
          run.stopReason,
          mode === "condition-error" ? "condition-error" : "progress-failure",
        );
        assert.deepEqual(run.progressFailure, expectedFailure);
        const expectedHits = ["false", "cancelled"].includes(mode) ? 0 : 1;
        assert.equal(hits, expectedHits);
        assert.equal(terminal, 1);
        assert.equal(callbacks, expectedHits + 1);
        assert.equal(run.results.length, expectedHits);
        for (const record of run.results) {
          assert.equal(record.status, "passed");
          assert.equal(record.response.body, '{"receipt":"one-actual-effect"}');
          assert.equal(Object.hasOwn(record, "progressFailure"), false);
        }
        assert.equal(
          run.conditionResults.length,
          mode === "cancelled" ? 0 : mode === "condition-error" ? 2 : 1,
        );
        if (mode === "false")
          assert.equal(run.conditionResults[0].matched, false);
        if (mode === "condition-error")
          assert.equal(run.conditionResults[1].status, "failed");
        assert.ok(!JSON.stringify(run).includes("private-reporter-secret"));
        assert.ok(!JSON.stringify(run).includes(root));
        const reopened = await new Store(root).get(project.id);
        const saved = reopened.runs.find((row) => row.id === run.id);
        assert.equal(reopened.runs.length, 1);
        assert.equal(saved.status, run.status);
        assert.equal(saved.stopReason, run.stopReason);
        assert.deepEqual(saved.progressFailure, run.progressFailure);
        assert.deepEqual(saved.results, run.results);
        assert.deepEqual(saved.conditionResults, run.conditionResults);
        assert.equal(saved.planHash, run.planHash);
        assert.equal(hits, expectedHits);
      },
    );
  }
}
