import test from "node:test";
import assert from "node:assert/strict";
import {
  listExecutionHistory,
  findExecutionResult,
} from "../src/execution-history.mjs";

test("execution history combines API and flow summaries with explicit filters and no response payload", () => {
  const project = {
    history: [
      {
        id: "api",
        name: "API",
        createdAt: "2026-10-22T02:00:00Z",
        source: "mcp",
        status: "failed",
        durationMs: 12,
        response: { body: "PRIVATE" },
        error: "PRIVATE",
      },
    ],
    runs: [
      {
        id: "flow",
        planId: "p",
        planName: "Flow",
        createdAt: "2026-10-22T01:00:00Z",
        source: "manual",
        status: "passed",
        durationMs: 20,
        results: [{ status: "passed", response: { body: "PRIVATE" } }],
      },
    ],
  };
  const all = listExecutionHistory(project);
  assert.deepEqual(
    all.map((r) => r.id),
    ["api", "flow"],
  );
  assert.deepEqual(
    all.map((r) => r.scope),
    ["api", "flow"],
  );
  assert.equal(JSON.stringify(all).includes("PRIVATE"), false);
  assert.equal(all[0].durationMs, 12);
  assert.deepEqual(
    listExecutionHistory(project, {
      scope: "flow",
      source: "manual",
      status: "passed",
      planId: "p",
    }).map((r) => r.id),
    ["flow"],
  );
  assert.equal(
    listExecutionHistory(project, { scope: "api", planId: "p" }).length,
    0,
  );
  assert.equal(findExecutionResult(project, "api").response.body, "PRIVATE");
});
test("execution history bounds output and does not invent legacy origins or timings", () => {
  const project = {
    runs: Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      status: "failed",
      results: Array.from({ length: 9 }, (_, n) => ({
        stepId: String(n),
        name: "step",
        status: "failed",
        error: "PRIVATE",
      })),
    })),
    history: [],
  };
  const rows = listExecutionHistory(project);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, "59");
  assert.equal(rows[0].source, "unknown");
  assert.equal(rows[0].durationMs, undefined);
  assert.equal(rows[0].failedStepCount, 9);
  assert.equal(rows[0].failedSteps.length, 5);
  assert.equal(listExecutionHistory(project, { source: "manual" }).length, 0);
  assert.equal(listExecutionHistory(project, { limit: 50 }).length, 50);
  for (const args of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: "2" },
    { scope: "all" },
    { source: "invented" },
    { status: "unknown" },
  ])
    assert.throws(() => listExecutionHistory(project, args));
  assert.throws(
    () =>
      findExecutionResult(
        { runs: [{ id: "same" }], history: [{ id: "same" }] },
        "same",
      ),
    /不唯一/,
  );
});
