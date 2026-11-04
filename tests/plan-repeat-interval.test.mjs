import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { executeRequest } from "../src/runtime.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { planOccurrences } from "../src/plan-repeat.mjs";

const leaf = (id) => ({
  id,
  request: { method: "GET", url: `http://example.test/${id}` },
});
const repeat = (more = {}) => ({
  type: "repeat",
  id: "group",
  count: 2,
  intervalMs: 40,
  steps: [leaf("a"), leaf("b")],
  ...more,
});
const response = async () => ({
  status: 200,
  body: "ok",
  headers: {},
  duration: 0,
});

test("interval waits between iterations without changing identities or progress", async () => {
  const plan = snapshotPlan({ steps: [repeat()] });
  const events = [];
  const result = await runPlan(plan, {}, async (req) => {
    events.push({ url: req.url, at: performance.now() });
    return response();
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(
    events.map((e) => new URL(e.url).pathname),
    ["/a", "/b", "/a", "/b"],
  );
  assert(events[2].at - events[1].at >= 30);
  assert.equal(result.results.length, 4);
  assert.equal(result.snapshot.steps[0].intervalMs, 40);
  const without = snapshotPlan({ steps: [repeat({ intervalMs: undefined })] });
  assert.deepEqual(
    planOccurrences(plan.steps).map((o) => o.repeat.occurrenceId),
    planOccurrences(without.steps).map((o) => o.repeat.occurrenceId),
  );
});

test("cancellation during the delay preserves finished evidence and starts no next request", async () => {
  const controller = new AbortController();
  let hits = 0;
  const result = await runPlan(
    snapshotPlan({ steps: [repeat({ intervalMs: 1000, steps: [leaf("a")] })] }),
    {},
    async () => {
      hits++;
      setTimeout(() => controller.abort(), 20);
      return response();
    },
    { signal: controller.signal },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(hits, 1);
  assert.equal(result.results.length, 1);
});

test("invalid or over-budget waits reject before execution, including disabled subtrees", () => {
  for (const intervalMs of [-0, -1, 0.5, 10001, "1", null])
    assert.throws(() => snapshotPlan({ steps: [repeat({ intervalMs })] }));
  assert.throws(
    () =>
      snapshotPlan({
        steps: [repeat({ count: 8, intervalMs: 10000, enabled: false })],
      }),
    /60000/,
  );
  const plan = snapshotPlan({ steps: [repeat({ intervalMs: 0 })] });
  assert.equal(plan.steps[0].intervalMs, 0);
});

test("disabled groups do not create waits and if skip includes internal waits", async () => {
  const disabled = snapshotPlan({
    steps: [repeat({ steps: [{ ...leaf("a"), enabled: false }] })],
  });
  await assert.rejects(() => runPlan(disabled, {}, response), /没有可执行/);
  const conditional = snapshotPlan({
    steps: [
      {
        type: "if",
        id: "if",
        condition: { op: "eq", left: { literal: 1 }, right: { literal: 2 } },
        steps: [repeat()],
      },
      leaf("tail"),
    ],
  });
  let hits = 0;
  const result = await runPlan(conditional, {}, async () => {
    hits++;
    return response();
  });
  assert.equal(hits, 1);
  assert.equal(result.results[0].stepId, "tail");
});

test("nested repeat intervals and false per-iteration conditions retain their own boundaries", async () => {
  const plan = snapshotPlan({
    steps: [
      repeat({
        intervalMs: 20,
        steps: [
          {
            type: "if",
            id: "check",
            condition: {
              op: "eq",
              left: { literal: 1 },
              right: { literal: 2 },
            },
            steps: [leaf("hidden")],
          },
          {
            type: "repeat",
            id: "inner",
            count: 2,
            intervalMs: 20,
            steps: [leaf("inner-leaf")],
          },
        ],
      }),
    ],
  });
  const hits = [];
  const run = await runPlan(plan, {}, async () => {
    hits.push(performance.now());
    return response();
  });
  assert.equal(run.status, "passed");
  assert.equal(run.conditionResults.length, 2);
  assert.equal(run.results.length, 4);
  assert(hits[1] - hits[0] >= 14);
  assert(hits[2] - hits[1] >= 14);
  assert(hits[3] - hits[2] >= 14);
});

test("ordinary stop does not wait or start another iteration", async () => {
  const plan = snapshotPlan({
    failurePolicy: "stop",
    steps: [repeat({ intervalMs: 1000, steps: [leaf("a")] })],
  });
  let hits = 0;
  const result = await runPlan(plan, {}, async () => {
    hits++;
    return { status: 500, body: "", headers: {}, duration: 0 };
  });
  assert.equal(hits, 1);
  assert.equal(result.stopReason, "step-failure");
});

test("real HTTP arrivals preserve the iteration boundary", async (t) => {
  const arrivals = [];
  const server = createServer((req, res) => {
    arrivals.push({ path: req.url, time: performance.now() });
    res.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const plan = snapshotPlan({
    steps: [
      repeat({
        intervalMs: 40,
        steps: [
          { id: "a", request: { url: url + "/a" } },
          { id: "b", request: { url: url + "/b" } },
        ],
      }),
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed");
  assert.deepEqual(
    arrivals.map((row) => row.path),
    ["/a", "/b", "/a", "/b"],
  );
  assert(arrivals[2].time - arrivals[1].time >= 30);
});
