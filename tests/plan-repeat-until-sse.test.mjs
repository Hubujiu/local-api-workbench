// Canonical until contracts. Injected execution separates control policy from
// real-network completion semantics exercised in the companion workflow suite.
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { REPEAT_EVIDENCE_BYTES } from "../src/plan-repeat.mjs";
import { assertNativeLinearPlan } from "../src/native-mcp-plan.mjs";
import { prepareStagedLoad } from "../src/staged-load-plan.mjs";
const condition = (value = true) => ({
  op: "eq",
  left: { literal: value },
  right: { literal: true },
});
const wire = (extra = {}) => ({
  id: "wire",
  type: "protocol",
  protocol: {
    definition: { type: "sse", url: "http://127.0.0.1:1234" },
  },
  extract: [{ name: "token", path: "$.events[0].data", scope: "environment" }],
  ...extra,
});
const loop = (steps = [wire()], extra = {}) => ({
  id: "loop",
  type: "repeat",
  count: 3,
  untilCondition: condition(),
  steps,
  ...extra,
});
const http = (id = "http") => ({
  id,
  request: { url: "http://example.invalid" },
});
const response = async () => ({
  status: 200,
  headers: {},
  body: "ok",
  duration: 0,
});
const completed = (data = "ready") => ({
  status: "completed",
  durationMs: 0,
  result: { events: [{ data }], status: 200 },
});

test("SSE until remains excluded from native projection and staged load", () => {
  const plan = snapshotPlan({ steps: [loop()] });
  assert.equal(plan.steps[0].steps[0].expectedStatus, "completed");
  assert.throws(() => assertNativeLinearPlan(plan), /canonical|循环|条件/);
  assert.throws(
    () =>
      prepareStagedLoad({}, plan, {
        initialVUs: 1,
        stages: [{ durationSeconds: 1, targetVUs: 1 }],
        maxIterations: 1,
      }),
    /HTTP/,
  );
});

test("SSE until preflights false IF executor and credentials before earlier HTTP", async () => {
  let calls = 0;
  const leaf = wire();
  leaf.protocol.definition.handshake = { requiredHeaders: ["authorization"] };
  const plan = snapshotPlan({
    steps: [
      http(),
      loop([
        { id: "if", type: "if", condition: condition(false), steps: [leaf] },
      ]),
    ],
  });
  const send = async () => {
    calls++;
    return response();
  };
  const credentials = {
    wire: { headers: { authorization: "Bearer temporary" } },
  };
  await assert.rejects(
    runPlan(plan, {}, send, { protocolCredentials: credentials }),
    /未授权protocol/,
  );
  await assert.rejects(
    runPlan(plan, {}, send, { executeProtocol: completed }),
    /缺少协议运行时Header/,
  );
  await assert.rejects(
    runPlan(plan, {}, send, {
      executeProtocol: completed,
      protocolCredentials: { missing: {} },
    }),
    /凭据|协议|步骤/,
  );
  assert.equal(calls, 0);
  const run = await runPlan(plan, {}, send, {
    executeProtocol: () => {
      throw Error("false IF dispatched");
    },
    protocolCredentials: credentials,
  });
  assert.equal(calls, 1);
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.conditionResults.map((r) => r.matched),
    [false, true],
  );
  assert.equal(JSON.stringify(run).includes("Bearer temporary"), false);
});

test("SSE until preserves expected partial vs completed and stop vs continue, without implicit promotion", async () => {
  for (const expectedStatus of ["completed", "partial"])
    for (const failurePolicy of ["continue", "stop"]) {
      let exchanges = 0,
        commits = 0,
        httpCalls = 0;
      const plan = snapshotPlan({
        failurePolicy,
        steps: [loop([wire({ expectedStatus })]), http()],
      });
      const run = await runPlan(
        plan,
        { token: "initial" },
        async () => {
          httpCalls++;
          return response();
        },
        {
          executeProtocol: async () => {
            exchanges++;
            return {
              ...completed(),
              status: "partial",
              result: { events: [{ data: "limited" }], limited: true },
            };
          },
          onScopeChanges: async () => {
            commits++;
          },
        },
      );
      assert.equal(exchanges, 1);
      assert.equal(run.results[0].protocolResult.status, "partial");
      const passes = expectedStatus === "partial";
      assert.equal(run.results[0].status, passes ? "passed" : "failed");
      assert.equal(commits, passes ? 1 : 0);
      assert.equal(run.variables.token, passes ? "limited" : "initial");
      const stops = !passes && failurePolicy === "stop";
      assert.equal(httpCalls, stops ? 0 : 1);
      assert.equal(run.conditionResults.length, stops ? 0 : 1);
      assert.equal(run.stopReason, stops ? "step-failure" : undefined);
      assert.equal(run.status, passes ? "passed" : "failed");
    }
});

test("SSE until extraction is atomic and does not leak a partially extracted batch", async () => {
  let commits = 0;
  const plan = snapshotPlan({
    failurePolicy: "stop",
    steps: [
      loop([
        wire({
          extract: [
            { name: "token", path: "$.events[0].data", scope: "environment" },
            { name: "absent", path: "$.missing", scope: "environment" },
          ],
        }),
      ]),
      http(),
    ],
  });
  const run = await runPlan(
    plan,
    { token: "original" },
    () => {
      throw Error("tail dispatched");
    },
    {
      executeProtocol: completed,
      onScopeChanges: () => {
        commits++;
      },
    },
  );
  assert.equal(commits, 0);
  assert.equal(run.variables.token, "original");
  assert.deepEqual(run.results[0].extracted, {});
  assert.equal(run.results[0].protocolResult.status, "completed");
  assert.equal(run.results.length, 1);
  assert.deepEqual(run.conditionResults, []);
});

test("SSE until unknown scope acknowledgement stops before next body, condition, wait or sibling", async () => {
  for (const failurePolicy of ["continue", "stop"]) {
    let calls = 0,
      commits = 0;
    const run = await runPlan(
      snapshotPlan({
        failurePolicy,
        steps: [
          loop([wire(), http("body-tail")], { intervalMs: 10000 }),
          http(),
        ],
      }),
      { token: "original" },
      () => {
        throw Error("HTTP dispatched");
      },
      {
        executeProtocol: async () => {
          calls++;
          return completed();
        },
        onScopeChanges: async () => {
          commits++;
          throw Object.assign(Error("unconfirmed"), {
            code: "PROJECT_COMMIT_UNCERTAIN",
          });
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(commits, 1);
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(run.results[0].protocolResult.status, "completed");
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.deepEqual(run.conditionResults, []);
    assert.equal(run.variables.token, "original");
  }
});

test("SSE until cancellation after acknowledged persistence retains scope but skips the tail decision", async () => {
  const controller = new AbortController();
  let commits = 0,
    calls = 0;
  const run = await runPlan(
    snapshotPlan({ steps: [loop(), http()] }),
    { token: "old" },
    () => {
      throw Error("tail dispatched");
    },
    {
      signal: controller.signal,
      executeProtocol: async () => {
        calls++;
        return completed();
      },
      onScopeChanges: async () => {
        commits++;
        controller.abort();
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(commits, 1);
  assert.equal(run.status, "cancelled");
  assert.equal(run.results[0].status, "passed");
  assert.equal(run.variables.token, "ready");
  assert.deepEqual(run.conditionResults, []);
});

test("SSE until progress failure and evidence soft limit retain completed exchange without another decision", async () => {
  for (const boundary of ["progress", "evidence"]) {
    let calls = 0;
    const run = await runPlan(
      snapshotPlan({ steps: [loop([wire({ extract: [] })]), http()] }),
      { token: "initial" },
      () => {
        throw Error("tail dispatched");
      },
      {
        executeProtocol: async () => {
          calls++;
          return completed(
            boundary === "evidence"
              ? "x".repeat(REPEAT_EVIDENCE_BYTES + 1)
              : "ready",
          );
        },
        ...(boundary === "progress"
          ? {
              onStep: () => {
                throw Error("observer failed");
              },
            }
          : {}),
      },
    );
    assert.equal(calls, 1);
    assert.equal(run.status, "failed");
    assert.equal(run.results[0].protocolResult.status, "completed");
    assert.deepEqual(run.conditionResults, []);
    if (boundary === "progress")
      assert.equal(run.results[0].progressFailure.retry_safe, false);
    else assert.equal(run.stopReason, "evidence-limit");
  }
});
