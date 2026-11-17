import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, rename, readFile, writeFile } from "node:fs/promises";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { findExecutionResult } from "../src/execution-history.mjs";

const literal = (value) => ({ literal: value });
const variable = (name, scope = "runtime") => ({ scope, name });
const condition = (id, left, op, right, steps) => ({
  id,
  type: "if",
  condition: { left, op, right },
  steps,
});
const leaf = (id, request) => ({ id, request });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-failure-policy-owner-"));
  let app = await createApp({ root, port: 0 });
  const seen = [],
    waiters = new Map();
  const peer = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      token: req.headers["x-token"],
      identity: req.headers["x-identity"],
      frozen: req.headers["x-frozen"],
    });
    waiters.get(req.url)?.();
    if (req.url === "/hold") return;
    res.writeHead(req.url === "/failure" ? 401 : 200, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        count: req.url.startsWith("/setup/")
          ? Number(req.url.split("/").at(-1))
          : 0,
        token: "child-token",
      }),
    );
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    peer.closeAllConnections();
    await close();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const get = async (id) => {
    const response = await call(`projects/${id}`, undefined, "GET");
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  const made = await call("projects", { name: "owner IF" });
  assert.equal(made.status, 201);
  const project = made.value;
  project.environments[0].variables = {
    initial: 1,
    token: "initial-token",
    identity: "owner",
  };
  const url = `http://127.0.0.1:${peer.address().port}`;
  const request = (id, target, extract = []) => ({
    id,
    name: id,
    method: "GET",
    url: url + target,
    headers: [
      { key: "X-Token", value: "{{token}}" },
      { key: "X-Identity", value: "{{identity}}" },
      { key: "X-Frozen", value: "original" },
    ],
    extract,
  });
  project.requests = [
    request("setup-api", "/setup/{{initial}}", [
      { name: "count", source: "json", path: "$.count" },
    ]),
    request("child-api", "/child", [
      { name: "token", source: "json", path: "$.token" },
    ]),
    request("tail-api", "/tail"),
  ];
  const configured = await call(`projects/${project.id}`, project, "PUT");
  assert.equal(configured.status, 200, JSON.stringify(configured.value));
  const other = await call("projects", { name: "unrelated IF project" });
  assert.equal(other.status, 201);
  return {
    root,
    seen,
    call,
    get,
    request,
    project: configured.value,
    other: await get(other.value.id),
    get app() {
      return app;
    },
    async restart() {
      await close();
      app = await createApp({ root, port: 0 });
    },
    async waitFor(target) {
      if (seen.some((entry) => entry.url === target)) return;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error("owned IF peer did not receive " + target)),
            4000,
          );
          waiters.set(target, resolve);
        });
      } finally {
        clearTimeout(timer);
        waiters.delete(target);
      }
    },
  };
}

async function savePlan(f, steps, options = {}) {
  const made = await f.call(`projects/${f.project.id}/plans`, {
    name: "Frozen failure policy",
    failurePolicy: "stop",
    ...options,
    environmentId: f.project.environments[0].id,
    steps,
  });
  assert.equal(made.status, 200, JSON.stringify(made.value));
  return (await f.get(f.project.id)).plans.find(
    (plan) => plan.id === made.value.id,
  );
}
function checkStop(run, ids = ["setup", "failed"]) {
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "step-failure");
  assert.equal(run.snapshot.failurePolicy, "stop");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ids,
  );
  assert.equal(run.results.at(-1).status, "failed");
  assert.equal(run.results.at(-1).response.status, 401);
  assert.deepEqual(run.failureStop, {
    stepId: "failed",
    ...(run.results.at(-1).repeat ? { repeat: run.results.at(-1).repeat } : {}),
  });
}
const steps = (f) => [
  leaf("setup", f.project.requests[0]),
  {
    id: "outer",
    type: "repeat",
    count: 2,
    steps: [
      condition("gate", literal(true), "eq", literal(true), [
        {
          id: "inner",
          type: "repeat",
          count: 2,
          steps: [
            leaf("failed", f.request("failure-api", "/failure")),
            leaf("inside-tail", f.request("inside-api", "/never-inside")),
          ],
        },
      ]),
    ],
  },
  leaf("tail", f.project.requests[2]),
];

test(
  "owner stop retains frozen nested failure evidence through backup restore restart and policy edits without rewriting old runs",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await savePlan(f, steps(f));
    assert.equal(plan.failurePolicy, "stop");
    const first = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(first.status, 200, JSON.stringify(first.value));
    const run = first.value;
    checkStop(run);
    assert.equal(run.recordSaved, true);
    assert.equal(run.recordId, run.id);
    assert.deepEqual(run.results.at(-1).repeat.path, [
      { groupId: "outer", iteration: 0 },
      { groupId: "inner", iteration: 0 },
    ]);
    assert.equal(typeof run.failureStop.repeat.occurrenceId, "string");
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/setup/1", "/failure"],
    );
    const recorded = await f.get(f.project.id);
    const oldRecord = structuredClone(findExecutionResult(recorded, run.id));
    recorded.requests[0].url = f.request("edited", "/must-not-rebind").url;
    assert.equal(
      (await f.call(`projects/${recorded.id}`, recorded, "PUT")).status,
      200,
    );
    assert.deepEqual((await f.get(recorded.id)).plans[0], plan);
    const omitted = structuredClone(plan);
    delete omitted.failurePolicy;
    assert.equal(
      (await f.call(`projects/${recorded.id}/plans`, omitted)).status,
      200,
    );
    assert.equal((await f.get(recorded.id)).plans[0].failurePolicy, "stop");
    const beforeExport = await f.get(recorded.id);
    for (const format of ["apipost", "apipost-directory"]) {
      const rejected = await f.call(
        `projects/${recorded.id}/export?format=${format}`,
        undefined,
        "GET",
      );
      assert.equal(rejected.status, 400, JSON.stringify(rejected.value));
    }
    assert.deepEqual(await f.get(recorded.id), beforeExport);
    const backup = await f.call(
      `projects/${recorded.id}/export`,
      undefined,
      "GET",
    );
    assert.equal(backup.status, 200);
    assert.deepEqual(backup.value.runs[0].failureStop, run.failureStop);
    const restored = await f.call("restore", { document: backup.value });
    assert.equal(restored.status, 201, JSON.stringify(restored.value));
    assert.notEqual(restored.value.id, recorded.id);
    await f.restart();
    const second = await f.call(`projects/${restored.value.id}/run`, {
      planId: plan.id,
    });
    assert.equal(second.status, 200);
    checkStop(second.value);
    assert.equal(second.value.planHash, run.planHash);
    assert.deepEqual(second.value.snapshot, run.snapshot);
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/setup/1", "/failure", "/setup/1", "/failure"],
    );
    const reset = await f.call(`projects/${recorded.id}/plans`, {
      ...plan,
      failurePolicy: "continue",
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.value));
    const current = await f.get(recorded.id);
    assert.equal(Object.hasOwn(current.plans[0], "failurePolicy"), false);
    assert.deepEqual(findExecutionResult(current, run.id), oldRecord);
    const continued = await f.call(`projects/${recorded.id}/run`, {
      planId: plan.id,
    });
    assert.equal(continued.status, 200);
    assert.equal(continued.value.status, "failed");
    assert.equal(continued.value.stopReason, undefined);
    assert.equal(continued.value.results.length, 10);
    assert.notEqual(continued.value.planHash, run.planHash);
    assert.deepEqual(
      findExecutionResult(await new Store(f.root).get(recorded.id), run.id),
      oldRecord,
    );
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);

test(
  "owner explicit expected 401 passes under assertions status policy and reaches tail with stop enabled",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await savePlan(
      f,
      [
        {
          ...leaf("expected", f.request("expected-api", "/failure")),
          expectedStatus: 401,
        },
        leaf("tail", f.project.requests[2]),
      ],
      { statusPolicy: "assertions" },
    );
    const response = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    assert.equal(response.value.status, "passed");
    assert.equal(response.value.results[0].response.status, 401);
    assert.equal(response.value.stopReason, undefined);
    assert.equal(response.value.failureStop, undefined);
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/failure", "/tail"],
    );
  },
);

test(
  "owner stopped failure survives genuine post-journal unknown commit and recovery exactly once without replay",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      plan = await savePlan(f, steps(f));
    const store = f.app.store,
      save = store.save,
      read = store.readUnlocked;
    const directory = store.directory(f.project.id);
    const history = path.join(directory, "history"),
      kept = path.join(directory, "owned-history-backup");
    const journal = path.join(directory, ".transaction.json");
    let attempts = 0,
      blocked = false;
    store.save = async function (project, options) {
      if (project.id !== f.project.id || !options?.activity)
        return save.call(this, project, options);
      attempts++;
      this.readUnlocked = async function (id) {
        const state = await read.call(this, id);
        this.readUnlocked = read;
        await rename(history, kept);
        await writeFile(history, "private-failure-policy-storage-obstacle");
        blocked = true;
        return state;
      };
      try {
        return await save.call(this, project, options);
      } finally {
        this.readUnlocked = read;
      }
    };
    t.after(() => {
      store.save = save;
      store.readUnlocked = read;
    });
    const response = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(response.status, 200);
    const run = response.value;
    checkStop(run);
    assert.equal(run.recordSaved, false);
    assert.equal(run.recordId, null);
    assert.equal(run.attemptedRecordId, run.id);
    assert.equal(run.persistenceOutcome.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(run.persistenceOutcome.commit_outcome, "unknown");
    assert.equal(run.persistenceOutcome.retry_safe, false);
    assert.equal(attempts, 1);
    assert.equal(blocked, true);
    const receipt = JSON.stringify({
      error: run.persistenceError,
      outcome: run.persistenceOutcome,
    });
    assert.equal(receipt.includes(f.root), false);
    assert.equal(
      receipt.includes("private-failure-policy-storage-obstacle"),
      false,
    );
    const transaction = JSON.parse(await readFile(journal, "utf8"));
    const pending = transaction.runs.find((r) => r.id === run.id);
    assert.deepEqual(pending.failureStop, run.failureStop);
    assert.deepEqual(pending.results, run.results);
    assert.equal(pending.stopReason, "step-failure");
    store.save = save;
    store.readUnlocked = read;
    await rm(history);
    await rename(kept, history);
    const recovered = await new Store(f.root).get(f.project.id);
    assert.equal(recovered.runs.filter((r) => r.id === run.id).length, 1);
    const stored = findExecutionResult(recovered, run.id);
    assert.deepEqual(stored.failureStop, run.failureStop);
    assert.deepEqual(stored.results, run.results);
    assert.deepEqual(stored.snapshot, run.snapshot);
    assert.equal(stored.planHash, run.planHash);
    await assert.rejects(readFile(journal), { code: "ENOENT" });
    await f.restart();
    assert.deepEqual(
      findExecutionResult(await f.get(f.project.id), run.id),
      stored,
    );
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/setup/1", "/failure"],
    );
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);

test(
  "owner stop preserves genuine unknown scope commit priority instead of relabeling it an ordinary leaf failure",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const request = f.request("scope-api", "/scope-effect");
    request.afterScript =
      'pm.environment.set("scopeMarker", "committed-on-recovery");';
    const plan = await savePlan(f, [
      leaf("scope", request),
      leaf("tail", f.project.requests[2]),
    ]);
    const store = f.app.store,
      save = store.save,
      read = store.readUnlocked;
    const directory = store.directory(f.project.id);
    const history = path.join(directory, "history"),
      kept = path.join(directory, "owned-scope-history-backup");
    let attempts = 0,
      journalEvidence;
    store.save = async function (project, options) {
      if (project.id !== f.project.id || options?.activity || attempts)
        return save.call(this, project, options);
      attempts++;
      this.readUnlocked = async function (id) {
        const state = await read.call(this, id);
        this.readUnlocked = read;
        await rename(history, kept);
        await writeFile(history, "owned-scope-obstacle");
        return state;
      };
      try {
        return await save.call(this, project, options);
      } finally {
        this.readUnlocked = read;
        journalEvidence = JSON.parse(
          await readFile(path.join(directory, ".transaction.json"), "utf8"),
        );
        await rm(history);
        await rename(kept, history);
      }
    };
    t.after(() => {
      store.save = save;
      store.readUnlocked = read;
    });
    const response = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    const run = response.value;
    assert.equal(attempts, 1);
    assert.ok(journalEvidence);
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(Object.hasOwn(run, "failureStop"), false);
    assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/scope-effect"],
    );
    store.save = save;
    await f.restart();
    const recovered = await f.get(f.project.id);
    assert.equal(
      recovered.environments[0].variables.scopeMarker,
      "committed-on-recovery",
    );
    assert.equal(
      findExecutionResult(recovered, run.id).stopReason,
      "scope-commit-unknown",
    );
    assert.deepEqual(
      findExecutionResult(recovered, run.id).results,
      run.results,
    );
    assert.deepEqual(
      f.seen.map((r) => r.url),
      ["/scope-effect"],
    );
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);
