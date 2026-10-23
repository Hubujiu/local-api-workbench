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
