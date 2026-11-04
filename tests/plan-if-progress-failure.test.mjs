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
  for (const mode of [
    "true",
    "false",
    "condition-error",
    "cancelled",
    "terminal-cancel-reject",
    "terminal-cancel-resolve",
    "terminal-cancel-condition-error",
    "evidence-limit",
  ]) {
    test(
      (asynchronous ? "async" : "sync") +
        " terminal IF progress failure preserves " +
        mode +
        " evidence and durable identity without replay",
      { timeout: 15000 },
      async (t) => {
        const root = await mkdtemp(path.join(tmpdir(), "if-progress-failure-"));
        const body =
          mode === "evidence-limit"
            ? "x".repeat(3 * 1024 * 1024)
            : '{"receipt":"one-actual-effect"}';
        let hits = 0;
        const peer = http.createServer((_req, res) => {
          hits++;
          res.end(body);
        });
        await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
        t.after(async () => {
          peer.closeAllConnections();
          await new Promise((resolve) => peer.close(resolve));
          await rm(root, { recursive: true, force: true });
        });
        const controller = new AbortController();
        const abortInReporter = mode.startsWith("terminal-cancel");
        const conditionError = mode.includes("condition-error");
        const resolves = mode === "terminal-cancel-resolve";
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
            gate(
              "first",
              { literal: mode !== "false" },
              mode === "evidence-limit"
                ? [
                    {
                      type: "repeat",
                      id: "repeat",
                      count: 3,
                      steps: [leaf("completed")],
                    },
                  ]
                : [leaf("completed")],
            ),
            ...(mode === "evidence-limit"
              ? [gate("pending", { literal: true }, [leaf("never")])]
              : []),
            ...(conditionError
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
            const settle = () => {
              if (abortInReporter) controller.abort();
              if (!resolves) throw error;
            };
            if (asynchronous) return Promise.resolve().then(settle);
            return settle();
          },
        });
        if (mode === "cancelled") controller.abort();
        const signal = controller.signal;
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
        assert.equal(
          run.status,
          mode === "cancelled" || abortInReporter ? "cancelled" : "failed",
        );
        assert.equal(
          run.stopReason,
          mode === "evidence-limit"
            ? "evidence-limit"
            : conditionError
              ? "condition-error"
              : resolves
                ? undefined
                : "progress-failure",
        );
        assert.deepEqual(
          run.progressFailure,
          resolves ? undefined : expectedFailure,
        );
        const expectedHits = ["false", "cancelled"].includes(mode)
          ? 0
          : mode === "evidence-limit"
            ? 3
            : 1;
        assert.equal(hits, expectedHits);
        assert.equal(terminal, 1);
        assert.equal(callbacks, expectedHits + 1);
        assert.equal(run.results.length, expectedHits);
        if (mode === "evidence-limit") {
          assert.equal(run.evidenceBudget.executed, 3);
          assert.equal(run.evidenceBudget.last.repeat.iteration, 2);
          assert.equal(run.evidenceBudget.next.kind, "condition");
          assert.equal(run.evidenceBudget.next.stepId, "pending");
        }
        for (const record of run.results) {
          assert.equal(record.status, "passed");
          assert.equal(record.response.body, body);
          assert.equal(Object.hasOwn(record, "progressFailure"), false);
        }
        assert.equal(
          run.conditionResults.length,
          mode === "cancelled" ? 0 : conditionError ? 2 : 1,
        );
        if (mode === "false")
          assert.equal(run.conditionResults[0].matched, false);
        if (conditionError)
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
        assert.deepEqual(saved.evidenceBudget, run.evidenceBudget);
        assert.equal(hits, expectedHits);
      },
    );
  }
}
