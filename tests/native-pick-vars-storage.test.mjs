import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

test("native extraction reports a real journaled scope commit as unknown, stops later HTTP, and recovers without replay", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pick-journal-"));
  const app = await createApp({ root, port: 0 });
  const originalSave = app.store.save,
    originalRead = app.store.readUnlocked,
    seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end('{"token":"fresh-fixture-token"}');
  });
  t.after(async () => {
    app.store.save = originalSave;
    app.store.readUnlocked = originalRead;
    app.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + upstream.address().port;
  const project = await app.store.create("Native extraction journal boundary");
  const environmentId = project.environments[0].id;
  project.environments[0].variables.token = "stale-fixture-token";
  await app.store.save(project);
  const post = async (action, body) => {
    const response = await fetch(
      `${app.url}/api/projects/${project.id}/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const plan = await post("plans", {
    steps: [
      {
        request: {
          name: "Login once",
          method: "GET",
          url: base + "/login",
          inheritSharedScripts: false,
          nativeTasks: {
            version: 1,
            before: [],
            after: [
              {
                type: "pickVars",
                enabled: 1,
                data: {
                  source: "responseJson",
                  variables: [
                    { name: "token", expression: "$.token", type: "envVars" },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        request: {
          name: "Must not run after uncertain persistence",
          method: "GET",
          url: base + "/later",
          auth: { type: "bearer", token: "{{token}}" },
        },
      },
    ],
  });
  const before = await app.store.get(project.id),
    directory = app.store.directory(project.id),
    history = path.join(directory, "history"),
    keptHistory = path.join(directory, "history-kept"),
    journalFile = path.join(directory, ".transaction.json");
  let saveAttempts = 0,
    readBarriers = 0,
    observedError;

  // Boundary orchestration only: the real scope callback and Store validation,
  // locking, read, journal publication, apply, and error classification all run.
  // Waiting until the original save's read has completed avoids a mere read
  // preflight failure. A test-owned ordinary file then obstructs a later apply
  // directory on every OS; no symlinks, fabricated Store errors, or fake results.
  app.store.save = async function (value, options) {
    if (
      value.id !== project.id ||
      options?.activity ||
      value.environments.find((env) => env.id === environmentId)?.variables
        .token !== "fresh-fixture-token"
    )
      return originalSave.call(this, value, options);
    saveAttempts++;
    this.readUnlocked = async function (id) {
      const state = await originalRead.call(this, id);
      readBarriers++;
      assert.equal(id, project.id);
      assert.equal(state.revision, before.revision);
      assert.equal(
        state.environments[0].variables.token,
        "stale-fixture-token",
      );
      await rename(history, keptHistory);
      await writeFile(history, "test-owned ordinary file blocks history apply");
      return state;
    };
    try {
      return await originalSave.call(this, value, options);
    } catch (error) {
      observedError = error;
      throw error;
    } finally {
      this.readUnlocked = originalRead;
    }
  };

  const run = await post("run", { planId: plan.id, environmentId });
  app.store.save = originalSave;
  assert.equal(saveAttempts, 1);
  assert.equal(readBarriers, 1);
  assert(observedError instanceof ProjectCommitUncertain);
  assert.equal(observedError.code, "PROJECT_COMMIT_UNCERTAIN");
  assert.equal(observedError.projectId, project.id);
  assert(observedError.cause instanceof Error);
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, false);
  assert.equal(run.results.length, 1);
  const result = run.results[0];
  assert.equal(result.response.status, 200);
  assert.deepEqual(JSON.parse(result.response.body), {
    token: "fresh-fixture-token",
  });
  assert.deepEqual(result.scopeCommit, {
    outcome: "unknown",
    retrySafe: false,
  });
  assert.equal(
    result.error,
    "变量持久化提交未确认；请重新读取项目，勿自动重试已完成请求",
  );
  assert.equal(run.variables.token, "stale-fixture-token");
  const serialized = JSON.stringify(run);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(JSON.stringify(root).slice(1, -1)), false);
  assert.equal(serialized.includes('"cause"'), false);
  assert.equal(serialized.includes("ENOTDIR"), false);
  assert.deepEqual(seen, [{ path: "/login", authorization: undefined }]);

  // Prove this was after journal publication and partial apply, not the earlier
  // portable read-error fixture: env is new, final metadata is still old.
  assert.equal((await stat(history)).isFile(), true);
  const journal = JSON.parse(await readFile(journalFile, "utf8"));
  assert.equal(journal.id, project.id);
  assert.equal(journal.revision, before.revision + 1);
  assert.equal(journal.environments[0].variables.token, "fresh-fixture-token");
  assert.match(environmentId, /^[a-f0-9-]{36}$/i);
  const appliedEnvironment = JSON.parse(
    await readFile(
      path.join(directory, "envs", environmentId + ".json"),
      "utf8",
    ),
  );
  assert.equal(appliedEnvironment.variables.token, "fresh-fixture-token");
  const metadata = JSON.parse(
    await readFile(path.join(directory, "project.json"), "utf8"),
  );
  assert.equal(metadata.revision, before.revision);
  await assert.rejects(new Store(root).get(project.id), (error) => {
    assert(error instanceof ProjectCommitUncertain);
    assert.equal(error.code, "PROJECT_COMMIT_UNCERTAIN");
    return true;
  });

  // Repair only this fixture's obstacle. Fresh Store recovery applies the same
  // transaction; neither recovery nor rereading is permission to replay login.
  await rm(history);
  await rename(keptHistory, history);
  const recovered = await new Store(root).get(project.id);
  assert.equal(
    recovered.environments[0].variables.token,
    "fresh-fixture-token",
  );
  assert.equal(recovered.revision, journal.revision);
  assert.equal(recovered.configRevision, journal.configRevision);
  assert.deepEqual(recovered.plans, before.plans);
  assert.deepEqual(recovered.runs, before.runs);
  assert.deepEqual(recovered.history, before.history);
  assert.equal(
    recovered.runs.some((saved) => saved.id === run.id),
    false,
  );
  await assert.rejects(readFile(journalFile), { code: "ENOENT" });
  assert.deepEqual(await new Store(root).get(project.id), recovered);
  assert.equal(saveAttempts, 1);
  assert.deepEqual(seen, [{ path: "/login", authorization: undefined }]);
});
