// Independent injected-executor contracts: no network, scripts, database or Store.
import test from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../src/core.mjs";
import { assertNativeLinearResult } from "../src/native-mcp-tools.mjs";
const condition = (matched) => ({
  op: "eq",
  left: { literal: matched },
  right: { literal: true },
});
const leaf = (id) => ({
  id,
  request: {
    url: "http://example.test",
    extract: [{ name: "n", source: "json", path: "$.n", scope: "environment" }],
  },
});
for (const matched of [true, false]) {
  for (const failurePolicy of [undefined, "continue", "stop"]) {
    test(`until ${matched}: unknown scope commit stops before any further work (${failurePolicy || "omitted"})`, async () => {
      let calls = 0,
        commits = 0;
      const plan = {
        ...(failurePolicy === undefined ? {} : { failurePolicy }),
        steps: [
          {
            type: "repeat",
            id: "loop",
            count: 2,
            untilCondition: condition(matched),
            steps: [leaf("effect"), leaf("next-body")],
          },
          leaf("tail"),
        ],
      };
      const result = await runPlan(
        plan,
        {},
        async () => {
          calls++;
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"n":1}',
            duration: 0,
          };
        },
        {
          onScopeChanges: async () => {
            commits++;
            throw Object.assign(Error("unconfirmed persistence"), {
              code: "PROJECT_COMMIT_UNCERTAIN",
            });
          },
        },
      );
      assert.equal(calls, 1);
      assert.equal(commits, 1);
      assert.equal(result.status, "failed");
      assert.equal(result.stopReason, "scope-commit-unknown");
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].response.status, 200);
      assert.deepEqual(result.results[0].scopeCommit, {
        outcome: "unknown",
        retrySafe: false,
      });
      assert.deepEqual(result.conditionResults, []);
      assert.equal(result.untilLimit, undefined);
    });
  }
}
test("native rejects snapshot-free until decision evidence", () => {
  assert.throws(
    () =>
      assertNativeLinearResult({
        results: [],
        conditionResults: [{ kind: "repeat-until", matched: false }],
      }),
    /循环|条件|canonical/,
  );
});
for (const evidence of [
  { stopReason: "repeat-condition-exhausted" },
  {
    untilLimit: {
      groupId: "loop",
      count: 1,
      completedIterations: 1,
      occurrenceId: '["repeat-until",[],"loop",0]',
    },
  },
]) {
  test(`native rejects sparse until historical evidence ${Object.keys(evidence)[0]}`, () => {
    assert.throws(
      () => assertNativeLinearResult({ results: [], ...evidence }),
      /循环|条件|canonical/,
    );
  });
}
test("cancel after a completed body preserves response but does not evaluate until or run tail", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runPlan(
    {
      steps: [
        {
          type: "repeat",
          id: "loop",
          count: 2,
          untilCondition: condition(true),
          steps: [{ id: "body", request: { url: "http://example.test" } }],
        },
        leaf("tail"),
      ],
    },
    {},
    async () => {
      calls++;
      return { status: 200, headers: {}, body: "accepted", duration: 0 };
    },
    { signal: controller.signal, onStep: () => controller.abort() },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "cancelled");
  assert.equal(result.results[0].response.body, "accepted");
  assert.deepEqual(result.conditionResults, []);
});
test("evidence soft limit before tail condition prevents another iteration and retains full response", async () => {
  let calls = 0;
  const body = "x".repeat(8 * 1024 * 1024 + 1);
  const result = await runPlan(
    {
      steps: [
        {
          type: "repeat",
          id: "loop",
          count: 2,
          untilCondition: condition(false),
          steps: [{ id: "body", request: { url: "http://example.test" } }],
        },
        leaf("tail"),
      ],
    },
    {},
    async () => {
      calls++;
      return { status: 200, headers: {}, body, duration: 0 };
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "evidence-limit");
  assert.equal(result.results[0].response.body.length, body.length);
  assert.deepEqual(result.conditionResults, []);
  assert.equal(result.evidenceBudget.next.kind, "condition");
  assert.match(result.evidenceBudget.next.occurrenceId, /repeat-until/);
  assert.equal(result.evidenceBudget.remainingIsPotential, true);
});
