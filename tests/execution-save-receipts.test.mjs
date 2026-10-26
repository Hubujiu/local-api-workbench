import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
import { createMCP } from "../src/mcp.mjs";
import { Store } from "../src/runtime.mjs";

async function fixture(t, status = 200) {
  const root = await mkdtemp(path.join(tmpdir(), "execution-save-receipt-"));
  const app = await createApp({ root, port: 0 });
  let hits = 0,
    beforeRespond = async () => {};
  const peer = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    } // Complete the actual request body once.
    hits++;
    await beforeRespond();
    res.writeHead(status, {
      "content-type": "application/json",
      "x-receipt-marker": "loopback-confirmed",
    });
    res.end(JSON.stringify({ receipt: `receipt-${hits}` }));
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => peer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Execution receipt");
  const request = {
    id: "receipt-request",
    name: "One real POST",
    method: "POST",
    url: `http://127.0.0.1:${peer.address().port}/submit`,
    bodyType: "json",
    body: '{"fixture":true}',
  };
  const post = async (route, value) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  const execute = (overrides = {}, projectId = project.id) =>
    post(`/api/projects/${projectId}/execute`, {
      runId: "execution-receipt-attempt",
      environmentId: project.environments[0].id,
      request: { ...request, ...overrides },
    });
  return {
    root,
    app,
    project,
    request,
    post,
    execute,
    hits: () => hits,
    beforeRespond: (fn) => {
      beforeRespond = fn;
    },
  };
}

// Inject only an owned filesystem obstacle at a real save boundary. Both read
// and save still run their original implementations; no outcome is fabricated.
function obstructActivitySave(t, f) {
  const store = f.app.store;
  const originalSave = store.save;
  const originalRead = store.readUnlocked;
  const directory = store.directory(f.project.id);
  const history = path.join(directory, "history");
  const kept = path.join(directory, "history-owned-backup");
  const journal = path.join(directory, ".transaction.json");
  let attempts = 0,
    failure,
    obstructed = false;
  store.save = async function (project, options) {
    if (project.id !== f.project.id || !options?.activity)
      return originalSave.call(this, project, options);
    attempts++;
    this.readUnlocked = async function (id) {
      const state = await originalRead.call(this, id);
      this.readUnlocked = originalRead;
      await rename(history, kept);
      await writeFile(history, "owned obstacle: private-password-marker");
      obstructed = true;
      return state;
    };
    try {
      return await originalSave.call(this, project, options);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.readUnlocked = originalRead;
    }
  };
  t.after(() => {
    store.save = originalSave;
    store.readUnlocked = originalRead;
  });
  return {
    attempts: () => attempts,
    failure: () => failure,
    journal: async () => JSON.parse(await readFile(journal, "utf8")),
    repair: async () => {
      store.save = originalSave;
      store.readUnlocked = originalRead;
      if (!obstructed) return;
      await rm(history);
      await rename(kept, history);
      obstructed = false;
    },
  };
}

function assertUnconfirmed(value, projectId) {
  assert.equal(value.recordSaved, false);
  assert.equal(value.recordId, null);
  assert.match(value.attemptedRecordId, /^[a-zA-Z0-9-]{1,200}$/);
  assert.deepEqual(value.persistenceOutcome, {
    code: "PROJECT_COMMIT_UNCERTAIN",
    project_id: projectId,
    commit_outcome: "unknown",
    retry_safe: false,
  });
  assert.equal(typeof value.persistenceError, "string");
  assert.ok(
    value.persistenceError.length > 0 && value.persistenceError.length <= 500,
  );
}

function assertPrivateReceipt(value, f) {
  const publicReceipt = JSON.stringify({
    persistenceError: value.persistenceError,
    persistenceOutcome: value.persistenceOutcome,
  });
  for (const hidden of [
    f.root,
    "private-password-marker",
    "EISDIR",
    "ENOTDIR",
    "stack",
    "cause",
  ])
    assert.equal(publicReceipt.includes(hidden), false, hidden);
}

test("manual execution returns a confirmed stable history receipt without changing its actual result", async (t) => {
  const f = await fixture(t);
  const { status, value } = await f.execute();
  assert.equal(status, 200);
  assert.equal(value.status, 200);
  assert.equal(value.outcome, "passed");
  assert.equal(value.body, '{"receipt":"receipt-1"}');
  assert.equal(value.runId, "execution-receipt-attempt");
  assert.equal(value.recordSaved, true);
  assert.equal(value.recordId, value.attemptedRecordId);
  assert.equal(value.persistenceOutcome, undefined);
  assert.equal(value.persistenceError, undefined);
  const restarted = await new Store(f.root).get(f.project.id);
  assert.equal(restarted.history.length, 1);
  assert.equal(restarted.history[0].id, value.recordId);
  assert.equal(restarted.history[0].runId, value.runId);
  assert.equal(restarted.history[0].response.body, value.body);
  assert.equal(f.hits(), 1);
});

for (const scenario of [
  { name: "peer 201", status: 201 },
  { name: "peer 500", status: 500, outcome: "failed" },
  {
    name: "false script assertion",
    status: 200,
    outcome: "failed",
    afterScript:
      'pm.test("false assertion",()=>pm.expect(false).to.equal(true));',
    verify: (value) => {
      assert.equal(value.assertions.length, 1);
      assert.equal(value.assertions[0].passed, false);
    },
  },
  {
    name: "post-script failure diagnostics",
    status: 200,
    outcome: "failed",
    afterScript: 'throw Error("post-script-receipt-marker");',
    verify: (value) => {
      assert.match(value.error, /post-script-receipt-marker/);
      assert.equal(value.scriptStage, "script");
      assert.equal(value.scriptDiagnostics.activityBudgetMs, 250);
      assert.equal(value.scriptDiagnostics.requestCount, 0);
    },
  },
]) {
  test(`manual ${scenario.name} survives a real post-journal save failure and recovers without replay`, async (t) => {
    const f = await fixture(t, scenario.status);
    const obstacle = obstructActivitySave(t, f);
    const { status, value } = await f.execute({
      afterScript: scenario.afterScript || "",
    });
    assert.equal(f.hits(), 1);
    assert.equal(obstacle.attempts(), 1);
    assert.equal(obstacle.failure().code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(status, 200, JSON.stringify(value));
    assert.equal(value.status, scenario.status);
    if (scenario.outcome) assert.equal(value.outcome, scenario.outcome);
    assert.equal(value.body, '{"receipt":"receipt-1"}');
    assert.equal(value.headers["x-receipt-marker"], "loopback-confirmed");
    assert.equal(value.runId, "execution-receipt-attempt");
    assertUnconfirmed(value, f.project.id);
    assertPrivateReceipt(value, f);
    scenario.verify?.(value);
    const journal = await obstacle.journal();
    assert.equal(journal.history.length, 1);
    assert.equal(journal.history[0].id, value.attemptedRecordId);
    assert.equal(journal.history[0].response.body, value.body);
    assert.equal(journal.history[0].status, value.outcome);
    assert.deepEqual(journal.history[0].assertions, value.assertions);
    assert.deepEqual(
      journal.history[0].scriptDiagnostics,
      value.scriptDiagnostics,
    );
    await obstacle.repair();
    const fresh = new Store(f.root);
    const recovered = await fresh.get(f.project.id);
    assert.equal(recovered.history.length, 1);
    assert.equal(recovered.history[0].id, value.attemptedRecordId);
    assert.equal(recovered.history[0].response.body, value.body);
    assert.deepEqual(
      (await fresh.get(f.project.id)).history,
      recovered.history,
    );
    assert.equal(f.hits(), 1);
    await assert.rejects(
      readFile(
        path.join(f.app.store.directory(f.project.id), ".transaction.json"),
      ),
      /ENOENT/,
    );
  });
}

test("confirmed post-script scope writes and another project remain isolated from history commit uncertainty", async (t) => {
  const f = await fixture(t);
  const other = await f.app.store.create("Unaffected project");
  f.project.environments.push({
    id: "other-env",
    name: "Other",
    variables: {},
  });
  await f.app.store.save(f.project);
  const obstacle = obstructActivitySave(t, f);
  const { status, value } = await f.execute({
    afterScript:
      'pm.environment.set("durableReceipt","scope-committed"); pm.variables.set("requestOnly","ephemeral");',
  });
  assert.equal(status, 200);
  assert.equal(value.status, 200);
  assert.equal(value.outcome, "passed");
  assert.equal(value.variableWrites.commits, 1);
  assert.equal(
    value.variableWrites.environmentId,
    f.project.environments[0].id,
  );
  assert.equal(value.variableWrites.changes[0].after.value, "scope-committed");
  assertUnconfirmed(value, f.project.id);
  assert.equal(f.hits(), 1);
  const separate = await f.post(`/api/projects/${other.id}/execute`, {
    request: f.request,
    runId: "other-project",
  });
  assert.equal(separate.status, 200);
  assert.equal(separate.value.recordSaved, true);
  assert.equal(separate.value.variableWrites.commits, 0);
  assert.equal(separate.value.extracted.durableReceipt, undefined);
  await obstacle.repair();
  const restarted = new Store(f.root);
  const recovered = await restarted.get(f.project.id);
  assert.equal(
    recovered.environments[0].variables.durableReceipt,
    "scope-committed",
  );
  assert.equal(recovered.environments[0].variables.requestOnly, undefined);
  assert.equal(recovered.environments[1].variables.durableReceipt, undefined);
  assert.equal(recovered.history[0].id, value.attemptedRecordId);
  assert.equal(
    (await restarted.get(other.id)).history[0].id,
    separate.value.recordId,
  );
  assert.equal(f.hits(), 2);
});

test("real pre-journal malformed-history read failure preserves the response without inventing an unknown commit", async (t) => {
  const f = await fixture(t);
  const directory = f.app.store.directory(f.project.id);
  const history = path.join(directory, "history", "requests.json");
  const before = await readFile(history, "utf8");
  const corrupt = '{"private-password-marker":';
  // No Store method is replaced. Corrupt only a test-owned JSON file after the
  // peer receives the POST. Its real JSON.parse failure must precede journaling
  // on every OS. A directory replaced with a file is not equivalent: Windows
  // may report ENOENT for child paths, which optional history reads accept.
  f.beforeRespond(async () => {
    await writeFile(history, corrupt);
  });
  const { status, value } = await f.execute();
  assert.equal(status, 200);
  assert.equal(value.status, 200);
  assert.equal(value.outcome, "passed");
  assert.equal(value.body, '{"receipt":"receipt-1"}');
  assert.equal(value.recordSaved, false);
  assert.equal(value.recordId, null);
  assert.equal(typeof value.attemptedRecordId, "string");
  assert.deepEqual(value.persistenceOutcome, {
    code: "RECORD_SAVE_FAILED",
    retry_safe: false,
  });
  assertPrivateReceipt(value, f);
  assert.equal(await readFile(history, "utf8"), corrupt);
  await assert.rejects(f.app.store.get(f.project.id), SyntaxError);
  await assert.rejects(readFile(path.join(directory, ".transaction.json")), {
    code: "ENOENT",
  });
  assert.equal(f.hits(), 1);
  await writeFile(history, before);
  const repaired = await new Store(f.root).get(f.project.id);
  assert.equal(repaired.history.length, 0);
  assert.equal(repaired.revision, f.project.revision);
  assert.equal(await readFile(history, "utf8"), before);
  assert.equal(f.hits(), 1);
});

test("HTTP plan retains completed execution and a typed recoverable record receipt", async (t) => {
  const f = await fixture(t);
  const plan = await f.post(`/api/projects/${f.project.id}/plans`, {
    name: "Once-only plan",
    steps: [{ request: f.request }],
  });
  assert.equal(plan.status, 200);
  const obstacle = obstructActivitySave(t, f);
  const { status, value } = await f.post(`/api/projects/${f.project.id}/run`, {
    planId: plan.value.id,
  });
  assert.equal(status, 200);
  assert.equal(value.status, "passed");
  assert.equal(value.results[0].response.status, 200);
  assert.equal(value.results[0].response.body, '{"receipt":"receipt-1"}');
  assertUnconfirmed(value, f.project.id);
  assert.equal(value.attemptedRecordId, value.id);
  assertPrivateReceipt(value, f);
  assert.equal(obstacle.attempts(), 1);
  await obstacle.repair();
  const recovered = await new Store(f.root).get(f.project.id);
  assert.equal(recovered.runs.length, 1);
  assert.equal(recovered.runs[0].id, value.attemptedRecordId);
  assert.deepEqual(recovered.runs[0].results, value.results);
  assert.equal(f.hits(), 1);
});

test("MCP single API execution retains its complete run after a real history journal failure", async (t) => {
  const f = await fixture(t);
  f.project.requests = [f.request];
  await f.app.store.save(f.project);
  const mcp = createMCP({
    store: f.app.store,
    projects: [f.project.id],
    write: true,
    execute: true,
  });
  const obstacle = obstructActivitySave(t, f);
  const response = await mcp({
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_execute_api",
      arguments: { projectId: f.project.id, apiId: f.request.id },
    },
  });
  assert.notEqual(response.result.isError, true);
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.status, "passed");
  assert.equal(value.results[0].response.status, 200);
  assert.equal(value.results[0].response.body, '{"receipt":"receipt-1"}');
  assertUnconfirmed(value, f.project.id);
  assert.equal(value.attemptedRecordId, value.id);
  assertPrivateReceipt(value, f);
  assert.equal(obstacle.attempts(), 1);
  await obstacle.repair();
  const recovered = await new Store(f.root).get(f.project.id);
  assert.equal(recovered.history.length, 1);
  assert.equal(recovered.history[0].id, value.attemptedRecordId);
  assert.equal(
    recovered.history[0].response.body,
    value.results[0].response.body,
  );
  assert.equal(f.hits(), 1);
});

test(
  "cancelling a real in-flight POST retains its failed execution evidence when history acknowledgement is uncertain",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.beforeRespond(async () => {
      started.resolve();
      await release.promise;
    });
    t.after(() => release.resolve());
    const obstacle = obstructActivitySave(t, f);
    const pending = f.execute();
    await started.promise;
    const cancellation = await f.post("/api/cancel", {
      id: "execution-receipt-attempt",
    });
    assert.equal(cancellation.status, 200);
    const { status, value } = await pending;
    release.resolve();
    assert.equal(status, 200);
    assert.equal(value.status, undefined);
    assert.equal(value.outcome, "failed");
    assert.equal(typeof value.error, "string");
    assert.ok(value.error.length > 0);
    assertUnconfirmed(value, f.project.id);
    assert.equal(obstacle.attempts(), 1);
    assert.equal(f.hits(), 1);
    await obstacle.repair();
    const recovered = await new Store(f.root).get(f.project.id);
    assert.equal(recovered.history.length, 1);
    assert.equal(recovered.history[0].id, value.attemptedRecordId);
    assert.equal(recovered.history[0].response, undefined);
    assert.equal(recovered.history[0].error, value.error);
    assert.equal(recovered.history[0].status, value.outcome);
    assert.equal(f.hits(), 1);
  },
);
