import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
test("script errors retain execution stage without replacing semantic error messages", async () => {
  await assert.rejects(
    runScript('require("node:fs")', { variables: {} }),
    (error) => {
      assert.match(error.message, /不允许/);
      assert.equal(error.scriptStage, "script");
      assert.equal(Number.isSafeInteger(error.elapsedMs), true);
      assert.ok(error.elapsedMs >= 0);
      assert.equal(typeof error.lastWorkerStage, "string");
      return true;
    },
  );
  const run = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "https://example.test",
            beforeScript: 'throw Error("diagnostic-fixture")',
          },
        },
      ],
    }),
    {},
    async () => {
      throw Error("must not send");
    },
  );
  assert.equal(run.status, "failed");
  assert.match(run.results[0].error, /diagnostic-fixture/);
  assert.equal(run.results[0].scriptStage, "script");
});

test("manual debug returns bounded script diagnostics and retains them in history", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "script-diagnostics-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (url, method = "GET", data) => {
    const response = await fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(
      response.status,
      url === "/api/projects" && method === "POST" ? 201 : 200,
    );
    return response.json();
  };
  const project = await call("/api/projects", "POST", { name: "Diagnostics" });
  const result = await call(`/api/projects/${project.id}/execute`, "POST", {
    request: {
      url: "http://127.0.0.1:1/must-not-send",
      beforeScript: 'throw Error("diagnostic-evidence")',
    },
  });
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /diagnostic-evidence/);
  assert.equal(result.scriptStage, "script");
  assert.equal(result.scriptDiagnostics.activityBudgetMs, 250);
  assert.equal(result.scriptDiagnostics.requestCount, 0);
  assert.equal(result.scriptDiagnostics.fakerCalls, 0);
  const saved = await call(`/api/projects/${project.id}`);
  assert.deepEqual(
    saved.history[0].scriptDiagnostics,
    result.scriptDiagnostics,
  );
  assert.equal(saved.history[0].scriptStage, "script");
});

test("diagnostics expose only known stages and finite bounded counters", async () => {
  const { scriptFailureDetails } = await import(
    "../src/script-diagnostics.mjs"
  );
  assert.deepEqual(
    scriptFailureDetails({
      scriptStage: "total-deadline",
      lastWorkerStage: "loading-engine",
      elapsedMs: 2001,
      scriptDiagnostics: {
        activityBudgetMs: 250,
        fakerCalls: 0,
        timerCount: 0,
        requestCount: 0,
        input: "private",
        source: "private",
        stack: "/host/path",
      },
    }),
    {
      scriptStage: "total-deadline",
      scriptDiagnostics: {
        activityBudgetMs: 250,
        fakerCalls: 0,
        timerCount: 0,
        requestCount: 0,
        lastWorkerStage: "loading-engine",
        elapsedMs: 2001,
      },
    },
  );
  assert.deepEqual(
    scriptFailureDetails({
      scriptStage: "/private/path",
      scriptScope: "x".repeat(201),
      elapsedMs: Infinity,
      scriptDiagnostics: {
        activityBudgetMs: 251,
        fakerCalls: -1,
        timerCount: NaN,
        requestCount: "1",
        secret: "private",
      },
    }),
    {},
  );
});

test("activity phase measurements remain bounded data and do not replace execution limits", async () => {
  const result = await runScript(
    "await Promise.resolve();pm.test('ok',()=>pm.expect(1).to.equal(1));",
    { request: { url: "http://example.test" } },
  );
  assert(result.tests.every((item) => item.passed));
  assert.deepEqual(
    Object.keys(result.activityMetrics).sort(),
    [
      "compatibilityMs",
      "fakerLoadMs",
      "functionLibraryMs",
      "userScriptMs",
      "microtaskMs",
      "callbackMs",
      "promiseStateMs",
      "serializationMs",
    ].sort(),
  );
  for (const value of Object.values(result.activityMetrics))
    assert(Number.isInteger(value) && value >= 0);
  await assert.rejects(
    runScript(
      "while(true){}",
      { request: { url: "http://example.test" } },
      { activityBudgetMs: 20 },
    ),
    (error) => {
      assert.equal(error.scriptDiagnostics.activityBudgetMs, 20);
      assert.match(error.message, /interrupted|超时/);
      assert(Number.isInteger(error.activityMetrics.compatibilityMs));
      assert(
        [
          "compatibility",
          "function-library",
          "user-script",
          "microtasks",
          "promise-state",
        ].includes(error.activityOperation),
      );
      return true;
    },
  );
  const { scriptFailureDetails } = await import(
    "../src/script-diagnostics.mjs"
  );
  assert.deepEqual(
    scriptFailureDetails({
      scriptDiagnostics: {
        activityOperation: "user-script",
        compatibilityMs: 12,
        userScriptMs: 240,
        microtaskMs: 0,
      },
    }),
    {
      scriptDiagnostics: {
        compatibilityMs: 12,
        userScriptMs: 240,
        microtaskMs: 0,
        activityOperation: "user-script",
      },
    },
  );
  assert.deepEqual(
    scriptFailureDetails({
      scriptDiagnostics: {
        activityOperation: "/private/path",
        compatibilityMs: Infinity,
        userScriptMs: -1,
        microtaskMs: "private",
      },
    }),
    {},
  );
});

test("Faker cold-load timing is a bounded metric, not a new execution allowance", async () => {
  const { scriptFailureDetails } = await import(
    "../src/script-diagnostics.mjs"
  );
  await assert.rejects(
    runScript(
      'pm.variables.replaceIn("{{$randomCountryCode}}");throw Error("fixture");',
      { variables: {} },
    ),
    (error) => {
      assert.match(error.message, /fixture/);
      const details = scriptFailureDetails(error).scriptDiagnostics;
      assert.equal(details.fakerCalls, 1);
      assert(
        Number.isSafeInteger(details.fakerLoadMs) && details.fakerLoadMs >= 0,
      );
      assert.equal(details.activityBudgetMs, 250);
      return true;
    },
  );
  assert.deepEqual(
    scriptFailureDetails({ activityMetrics: { fakerLoadMs: Infinity } }),
    {},
  );
  assert.deepEqual(
    scriptFailureDetails({ activityMetrics: { fakerLoadMs: 60001 } }),
    {},
  );
});

test("sequence failures retain bounded successful-stage timings without input or source", async () => {
  const { runScriptSequence } = await import("../src/scripts.mjs");
  const { scriptFailureDetails } = await import(
    "../src/script-diagnostics.mjs"
  );
  await assert.rejects(
    runScriptSequence(
      [
        {
          name: "a",
          code: 'pm.variables.set("private-name","private-value");',
        },
        { name: "b", code: 'throw Error("stage-failure");' },
      ],
      { variables: {} },
    ),
    (error) => {
      const evidence = scriptFailureDetails(error);
      assert.equal(evidence.sequenceActivity.length, 1);
      const first = evidence.sequenceActivity[0];
      assert.equal(first.stageIndex, 0);
      assert.equal(first.activityBudgetMs, 250);
      assert(first.activityMs >= 0 && first.activityMs <= 250);
      assert(first.elapsedMs >= 0);
      assert(Number.isInteger(first.compatibilityMs));
      assert(!JSON.stringify(evidence).includes("private-"));
      assert.match(error.message, /stage-failure/);
      return true;
    },
  );
  const raw = {
    stageIndex: 0,
    activityBudgetMs: 250,
    activityMs: 12,
    elapsedMs: 300,
    activityMetrics: { compatibilityMs: 8, userScriptMs: 4, source: "private" },
    input: "private",
    code: "private",
  };
  const sanitized = scriptFailureDetails({
    sequenceActivity: Array.from({ length: 40 }, () => raw),
  });
  assert.equal(sanitized.sequenceActivity.length, 34);
  assert(!JSON.stringify(sanitized).includes("private"));
  assert.deepEqual(
    scriptFailureDetails({
      sequenceActivity: [
        { stageIndex: -1 },
        {
          stageIndex: 0,
          activityMs: Infinity,
          elapsedMs: -1,
          activityMetrics: { userScriptMs: 70000 },
        },
      ],
    }).sequenceActivity,
    [{ stageIndex: 0 }],
  );
});
