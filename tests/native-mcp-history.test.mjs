import test from "node:test";
import assert from "node:assert/strict";
import { createMCP } from "../src/mcp.mjs";
test("native history filters before limiting and retains bounded safe summaries across both stores", async () => {
  const p = {
    id: "p",
    history: Array.from({ length: 50 }, (_, i) => ({
      id: "a" + i,
      createdAt: new Date(1000 + i).toISOString(),
      status: "passed",
      source: "mcp",
      request: { body: "SECRET" },
      response: { body: "SECRET" },
    })),
    runs: Array.from({ length: 50 }, (_, i) => ({
      id: "f" + i,
      createdAt: new Date(2000 + i).toISOString(),
      status: "failed",
      source: "manual",
      planId: "flow",
      planName: "Flow",
      durationMs: 4,
      environmentId: "env",
      results: Array.from({ length: 7 }, (_, j) => ({
        stepId: "s" + j,
        name: "Failed",
        status: "failed",
        response: { body: "SECRET" },
      })),
    })),
  };
  const d = createMCP({
    store: { get: async () => structuredClone(p) },
    projects: ["p"],
  });
  const call = async (args = {}) =>
    (
      await d({
        id: 1,
        method: "tools/call",
        params: {
          name: "apipost_list_execution_runs",
          arguments: { project_id: "p", ...args },
        },
      })
    ).result;
  const all = JSON.parse((await call({ limit: 1 })).content[0].text);
  assert.equal(all.total, 100);
  assert.equal(all.records.length, 1);
  assert.equal(all.records[0].failed, 7);
  assert.equal(all.records[0].failed_steps.length, 7);
  assert.equal(all.records[0].environment_id, "env");
  assert.equal(all.records[0].started_at, new Date(2045).toISOString());
  assert.doesNotMatch(JSON.stringify(all), /SECRET|response|request/);
  const filtered = JSON.parse(
    (
      await call({
        scope: "flow",
        source: "manual",
        status: "failed",
        flow_id: "flow",
        limit: 50,
      })
    ).content[0].text,
  );
  assert.equal(filtered.total, 50);
  assert.equal(filtered.records.length, 50);
  assert.equal(
    JSON.parse((await call({ scope: "api", flow_id: "flow" })).content[0].text)
      .total,
    0,
  );
  for (const args of [
    { limit: 0 },
    { limit: 51 },
    { limit: "1" },
    { source: "cli" },
    { project_id: "other" },
  ])
    assert.equal((await call(args)).isError, true);
});
