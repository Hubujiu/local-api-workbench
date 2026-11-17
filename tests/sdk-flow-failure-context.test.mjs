import test from "node:test";
import assert from "node:assert/strict";
import { sdkFlowFailureContext } from "./support/sdk-flow-failure.mjs";

test("SDK failure context preserves only bounded classification and existing diagnostics", () => {
  const context = sdkFlowFailureContext({
    status: "failed",
    results: [
      {
        status: "failed",
        error: "private raw error",
        response: { status: 503 },
        assertions: [{ passed: false }, { passed: true }],
        scriptStage: "serialization",
        scriptScope: "private scope",
        scriptDiagnostics: { activityBudgetMs: 250, elapsedMs: 123 },
        sequenceActivity: [{ stageIndex: 0, activityMs: 1, elapsedMs: 2 }],
      },
    ],
  });
  assert.deepEqual(context, {
    label: "sdk-environment-override",
    status: "failed",
    stepStatus: "failed",
    hasError: true,
    failedAssertionCount: 1,
    assertionCountCapped: false,
    httpStatus: 503,
    scriptStage: "serialization",
    scriptDiagnostics: { activityBudgetMs: 250, elapsedMs: 123 },
    sequenceActivity: [{ stageIndex: 0, activityMs: 1, elapsedMs: 2 }],
  });
});

test("hostile JSON payload cannot leak credentials identifiers bodies or arbitrary diagnostic strings", () => {
  const secret = "DO-NOT-LOG-token-password-private-id-body";
  const step = {
    id: secret,
    status: secret,
    error: secret,
    scriptStage: secret,
    scriptScope: secret,
    request: { headers: { Authorization: secret }, body: secret },
    response: {
      status: secret,
      headers: { authorization: secret },
      body: secret,
    },
    variables: { password: secret },
    assertions: Array.from({ length: 1001 }, () => ({
      passed: false,
      message: secret,
    })),
    scriptDiagnostics: {
      activityOperation: secret,
      lastWorkerStage: secret,
      elapsedMs: secret,
      password: secret,
    },
    sequenceActivity: Array.from({ length: 100 }, () => ({
      stageIndex: 0,
      activityMs: 60000,
      elapsedMs: 60000,
      scriptScope: secret,
      error: secret,
    })),
  };
  const output = sdkFlowFailureContext(
    JSON.parse(
      JSON.stringify({
        id: secret,
        status: secret,
        results: [step],
        password: secret,
      }),
    ),
  );
  const serialized = JSON.stringify(output);
  assert(!serialized.includes(secret));
  assert.equal(output.status, "unknown");
  assert.equal(output.stepStatus, "unknown");
  assert.equal(output.hasError, true);
  assert.equal(output.failedAssertionCount, 1000);
  assert.equal(output.assertionCountCapped, true);
  assert.equal(output.sequenceActivity.length, 34);
  assert.equal(Object.hasOwn(output, "httpStatus"), false);
  assert.equal(Object.hasOwn(output, "scriptScope"), false);
  assert(serialized.length < 32768);
});

test("empty and malformed decoded evidence stays bounded without inventing a cause", () => {
  for (const input of [
    null,
    {},
    { results: [null] },
    {
      status: "failed",
      results: [
        {
          assertions: "secret",
          response: { status: 999 },
          scriptDiagnostics: { compatibilityMs: Infinity, elapsedMs: -1 },
          sequenceActivity: [null, { stageIndex: 99 }],
        },
      ],
    },
  ]) {
    const result = sdkFlowFailureContext(input);
    assert.equal(result.hasError, false);
    assert.equal(result.failedAssertionCount, 0);
    assert.equal(Object.hasOwn(result, "httpStatus"), false);
    assert(JSON.stringify(result).length < 32768);
  }
});

test("maximum admitted numeric evidence has a fixed serialized ceiling", () => {
  const activityMetrics = Object.fromEntries(
    [
      "compatibilityMs",
      "fakerLoadMs",
      "functionLibraryMs",
      "userScriptMs",
      "microtaskMs",
      "callbackMs",
      "promiseStateMs",
      "serializationMs",
    ].map((key) => [key, 60000]),
  );
  const counters = {
    activityBudgetMs: 250,
    fakerCalls: 1001,
    timerCount: 101,
    requestCount: 11,
  };
  const output = sdkFlowFailureContext({
    status: "failed",
    results: [
      {
        status: "failed",
        error: "not logged",
        scriptStage: "total-deadline",
        activityMetrics,
        scriptDiagnostics: {
          ...counters,
          elapsedMs: Number.MAX_SAFE_INTEGER,
          activityOperation: "serialization",
          lastWorkerStage: "serialization",
        },
        sequenceActivity: Array.from({ length: 100 }, (_, i) => ({
          ...counters,
          stageIndex: i % 34,
          activityMetrics,
          activityMs: 60000,
          elapsedMs: 60000,
        })),
      },
    ],
  });
  assert.equal(output.sequenceActivity.length, 34);
  assert.equal(output.scriptDiagnostics.elapsedMs, Number.MAX_SAFE_INTEGER);
  assert(Buffer.byteLength(JSON.stringify(output), "utf8") < 32768);
});
