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
  const root = await mkdtemp(path.join(tmpdir(), "plan-if-owner-"));
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
    res.writeHead(200, { "content-type": "application/json" });
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

async function savePlan(f, steps, name = "Frozen IF workflow") {
  const made = await f.call(`projects/${f.project.id}/plans`, {
    name,
    environmentId: f.project.environments[0].id,
    steps,
  });
  assert.equal(made.status, 200, JSON.stringify(made.value));
  return (await f.get(f.project.id)).plans.find(
    (plan) => plan.id === made.value.id,
  );
}
function savedDecision(run, matched) {
  assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
  assert.equal(run.recordId, run.id);
  assert.equal(run.conditionResults.length, 1);
  assert.equal(run.conditionResults[0].groupId, "gate");
  assert.equal(run.conditionResults[0].status, "passed");
  assert.equal(run.conditionResults[0].matched, matched);
  assert.equal(typeof run.conditionResults[0].occurrenceId, "string");
  for (const key of ["left", "right", "operands", "value", "variables"])
    assert.equal(Object.hasOwn(run.conditionResults[0], key), false);
}

test(
  "owner IF frozen plans preserve decisions, history and hashes through full backup, restore and restart with changed initial inputs",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await savePlan(f, [
      leaf("setup", f.project.requests[0]),
      condition("gate", variable("count"), "eq", literal(1), [
        leaf("child", f.project.requests[1]),
      ]),
      leaf("tail", f.project.requests[2]),
    ]);
    const frozen = structuredClone(plan);
    const first = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(first.status, 200, JSON.stringify(first.value));
    const run = first.value;
    assert.equal(run.status, "passed");
    savedDecision(run, true);
    assert.deepEqual(
      f.seen.map((entry) => entry.url),
      ["/setup/1", "/child", "/tail"],
    );
    assert.equal(f.seen[2].token, "child-token");
    assert.deepEqual(
      run.results.map((result) => result.stepId),
      ["setup", "child", "tail"],
    );
    assert.deepEqual(run.snapshot, frozen);
    const recorded = await f.get(f.project.id);
    assert.deepEqual(
      findExecutionResult(recorded, run.id).conditionResults,
      run.conditionResults,
    );
    assert.deepEqual(recorded.runs[0].results, run.results);
    assert.deepEqual(recorded.plans[0], frozen);

    // Editing a live API and initial inputs does not rebind the frozen child.
    recorded.requests[1].url = f.request(
      "edited",
      "/must-not-follow-live-edit",
    ).url;
    recorded.requests[1].headers[2].value = "live-edited";
    recorded.environments[0].variables = {
      initial: 0,
      token: "restored-seed",
      identity: "restored",
    };
    const changed = await f.call(`projects/${recorded.id}`, recorded, "PUT");
    assert.equal(changed.status, 200, JSON.stringify(changed.value));
    assert.deepEqual(changed.value.plans[0], frozen);
    const resaved = await f.call(`projects/${recorded.id}/plans`, frozen);
    assert.equal(resaved.status, 200, JSON.stringify(resaved.value));
    assert.deepEqual((await f.get(recorded.id)).plans[0], frozen);

    const beforeExport = await f.get(recorded.id);
    for (const format of ["apipost", "apipost-directory"]) {
      const refused = await f.call(
        `projects/${recorded.id}/export?format=${format}`,
        undefined,
        "GET",
      );
      assert.equal(refused.status, 400, JSON.stringify(refused.value));
      assert.match(refused.value.error, /plans|HTTP步骤|条件|备份/);
    }
    assert.deepEqual(await f.get(recorded.id), beforeExport);
    assert.equal(f.seen.length, 3);
    const backup = await f.call(
      `projects/${recorded.id}/export`,
      undefined,
      "GET",
    );
    assert.equal(backup.status, 200);
    assert.deepEqual(backup.value.plans[0], frozen);
    assert.deepEqual(
      backup.value.runs[0].conditionResults,
      run.conditionResults,
    );
    const restored = await f.call("restore", { document: backup.value });
    assert.equal(restored.status, 201, JSON.stringify(restored.value));
    assert.notEqual(restored.value.id, recorded.id);
    assert.deepEqual(restored.value.plans[0], frozen);
    assert.deepEqual(
      restored.value.runs[0].conditionResults,
      run.conditionResults,
    );
    assert.deepEqual(restored.value.runs[0].snapshot, run.snapshot);
    assert.equal(restored.value.runs[0].planHash, run.planHash);
    await f.restart();
    const replay = await f.call(`projects/${restored.value.id}/run`, {
      planId: plan.id,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.value));
    assert.equal(replay.value.status, "passed");
    savedDecision(replay.value, false);
    assert.equal(replay.value.planHash, run.planHash);
    assert.deepEqual(replay.value.snapshot, frozen);
    assert.deepEqual(
      replay.value.results.map((result) => result.stepId),
      ["setup", "tail"],
    );
    assert.deepEqual(
      f.seen.map((entry) => entry.url),
      ["/setup/1", "/child", "/tail", "/setup/0", "/tail"],
    );
    assert.ok(
      f.seen
        .slice(3)
        .every(
          (entry) =>
            entry.identity === "restored" && entry.frozen === "original",
        ),
    );
    assert.equal(f.seen.at(-1).token, "restored-seed");
    const reopened = await new Store(f.root).get(restored.value.id);
    assert.deepEqual(reopened.plans[0], frozen);
    assert.deepEqual(
      findExecutionResult(reopened, run.id).conditionResults,
      run.conditionResults,
    );
    assert.deepEqual(
      findExecutionResult(reopened, replay.value.id).conditionResults,
      replay.value.conditionResults,
    );
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);

test(
  "owner IF runtime failure retains the earlier real effect and saved failure decision without dispatching child or sibling",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await savePlan(f, [
      leaf("setup", f.project.requests[0]),
      condition("gate", variable("missing-runtime-value"), "eq", literal(1), [
        leaf("child", f.project.requests[1]),
      ]),
      leaf("tail", f.project.requests[2]),
    ]);
    const response = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    const run = response.value;
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "condition-error");
    assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
    assert.equal(run.recordId, run.id);
    assert.deepEqual(
      f.seen.map((entry) => entry.url),
      ["/setup/1"],
    );
    assert.deepEqual(
      run.results.map((result) => result.stepId),
      ["setup"],
    );
    assert.equal(run.results[0].status, "passed");
    assert.equal(run.conditionResults.length, 1);
    assert.equal(run.conditionResults[0].groupId, "gate");
    assert.equal(run.conditionResults[0].status, "failed");
    assert.equal(run.conditionResults[0].code, "PLAN_CONDITION_INVALID");
    assert.equal(Object.hasOwn(run.conditionResults[0], "matched"), false);
    await f.restart();
    const disk = await f.get(f.project.id);
    assert.deepEqual(
      findExecutionResult(disk, run.id).conditionResults,
      run.conditionResults,
    );
    assert.deepEqual(findExecutionResult(disk, run.id).results, run.results);
    assert.deepEqual(disk.plans[0], plan);
    assert.equal(f.seen.length, 1);
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);

test(
  "owner cancellation inside a true IF saves the held child and decision without starting later children or siblings",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await savePlan(f, [
      leaf("setup", f.project.requests[0]),
      condition("gate", literal(true), "eq", literal(true), [
        leaf("held", f.request("held-api", "/hold")),
        leaf("later-child", f.request("later-api", "/must-not-run")),
      ]),
      leaf("tail", f.project.requests[2]),
    ]);
    const running = f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
      runId: "if-owner-held",
    });
    await f.waitFor("/hold");
    const cancel = await f.call("cancel", { id: "if-owner-held" });
    assert.equal(cancel.status, 200);
    const response = await running;
    assert.equal(response.status, 200, JSON.stringify(response.value));
    const run = response.value;
    assert.equal(run.status, "cancelled");
    savedDecision(run, true);
    assert.deepEqual(
      f.seen.map((entry) => entry.url),
      ["/setup/1", "/hold"],
    );
    assert.deepEqual(
      run.results.map((result) => result.stepId),
      ["setup", "held"],
    );
    assert.equal(run.results[0].status, "passed");
    assert.notEqual(run.results[1].status, "passed");
    const saved = await f.get(f.project.id);
    assert.deepEqual(
      findExecutionResult(saved, run.id).conditionResults,
      run.conditionResults,
    );
    assert.deepEqual(findExecutionResult(saved, run.id).results, run.results);
    await f.restart();
    assert.deepEqual(
      (await f.get(f.project.id)).runs[0].conditionResults,
      run.conditionResults,
    );
    assert.equal(f.seen.length, 2);
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);

test(
  "owner condition edits version the frozen definition without rewriting prior decisions or replaying earlier effects",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await savePlan(f, [
      condition("gate", literal(1), "eq", literal(1), [
        leaf("child", f.project.requests[1]),
      ]),
      leaf("tail", f.project.requests[2]),
    ]);
    const first = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.equal(first.value.status, "passed");
    savedDecision(first.value, true);
    assert.deepEqual(
      f.seen.map((entry) => entry.url),
      ["/child", "/tail"],
    );
    assert.equal(f.seen[1].token, "child-token");

    const edited = structuredClone(plan);
    edited.steps[0].condition.right = literal(2);
    const response = await f.call(`projects/${f.project.id}/plans`, edited);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    assert.equal(f.seen.length, 2);
    const versioned = await f.get(f.project.id);
    assert.equal(versioned.plans.length, 1);
    assert.equal(versioned.plans[0].id, plan.id);
    assert.deepEqual(
      versioned.plans[0].steps[0].condition,
      edited.steps[0].condition,
    );
    assert.equal(versioned.plans[0].provenance.steps.gate, "manual");
    assert.deepEqual(versioned.plans[0].steps[0].steps, plan.steps[0].steps);
    assert.deepEqual(
      findExecutionResult(versioned, first.value.id).snapshot,
      first.value.snapshot,
    );
    assert.deepEqual(
      findExecutionResult(versioned, first.value.id).conditionResults,
      first.value.conditionResults,
    );

    await f.restart();
    const second = await f.call(`projects/${f.project.id}/run`, {
      planId: plan.id,
    });
    assert.equal(second.status, 200, JSON.stringify(second.value));
    assert.equal(second.value.status, "passed");
    savedDecision(second.value, false);
    assert.notEqual(second.value.planHash, first.value.planHash);
    assert.deepEqual(
      second.value.snapshot.steps[0].condition.right,
      literal(2),
    );
    assert.deepEqual(first.value.snapshot.steps[0].condition.right, literal(1));
    assert.deepEqual(
      second.value.results.map((result) => result.stepId),
      ["tail"],
    );
    assert.deepEqual(
      f.seen.map((entry) => entry.url),
      ["/child", "/tail", "/tail"],
    );
    assert.equal(f.seen.at(-1).token, "initial-token");
    const disk = await f.get(f.project.id);
    assert.equal(disk.runs.length, 2);
    assert.deepEqual(
      findExecutionResult(disk, first.value.id).conditionResults,
      first.value.conditionResults,
    );
    assert.deepEqual(
      findExecutionResult(disk, second.value.id).conditionResults,
      second.value.conditionResults,
    );
    assert.deepEqual(await f.get(f.other.id), f.other);
  },
);

for (const failure of [false, true]) {
  test(
    "IF " +
      (failure ? "condition failure" : "completed run") +
      " survives real post-journal uncertainty and restart recovery without replay",
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const plan = await savePlan(f, [
        condition("false", literal(1), "eq", literal(2), [
          leaf("skip", f.request("skip-api", "/never")),
        ]),
        condition("true", literal(1), "eq", literal(1), [
          leaf("child", f.request("child-api", "/child")),
        ]),
        condition(
          "last",
          failure ? variable("missing") : literal(1),
          "eq",
          literal(1),
          [leaf("last-child", f.request("last-api", "/last"))],
        ),
      ]);
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
          await writeFile(history, "private-if-storage-obstacle");
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
      const response = await f.call("projects/" + f.project.id + "/run", {
        planId: plan.id,
      });
      assert.equal(response.status, 200);
      const run = response.value;
      assert.equal(run.status, failure ? "failed" : "passed");
      assert.equal(run.recordSaved, false);
      assert.equal(run.recordId, null);
      assert.equal(run.attemptedRecordId, run.id);
      assert.equal(run.persistenceOutcome.code, "PROJECT_COMMIT_UNCERTAIN");
      assert.equal(run.persistenceOutcome.commit_outcome, "unknown");
      assert.equal(run.persistenceOutcome.retry_safe, false);
      assert.equal(run.persistenceOutcome.project_id, f.project.id);
      assert.equal(attempts, 1);
      assert.equal(blocked, true);
      assert.equal(run.conditionResults.length, 3);
      assert.deepEqual(
        f.seen.map((row) => row.url),
        failure ? ["/child"] : ["/child", "/last"],
      );
      assert.equal(run.results.length, failure ? 1 : 2);
      if (failure) assert.equal(run.stopReason, "condition-error");
      const receipt = JSON.stringify({
        error: run.persistenceError,
        outcome: run.persistenceOutcome,
      });
      assert.ok(!receipt.includes(f.root));
      assert.ok(!receipt.includes("private-if-storage-obstacle"));
      const transaction = JSON.parse(await readFile(journal, "utf8"));
      const pending = transaction.runs.find((row) => row.id === run.id);
      assert.deepEqual(pending.conditionResults, run.conditionResults);
      assert.deepEqual(pending.results, run.results);
      store.save = save;
      store.readUnlocked = read;
      await rm(history);
      await rename(kept, history);
      const recovered = await new Store(f.root).get(f.project.id);
      assert.equal(recovered.runs.filter((row) => row.id === run.id).length, 1);
      const stored = recovered.runs.find((row) => row.id === run.id);
      assert.deepEqual(stored.conditionResults, run.conditionResults);
      assert.deepEqual(stored.results, run.results);
      assert.deepEqual(stored.snapshot, run.snapshot);
      assert.equal(stored.planHash, run.planHash);
      await assert.rejects(readFile(journal), { code: "ENOENT" });
      await f.restart();
      const restarted = await f.get(f.project.id);
      assert.equal(restarted.runs.filter((row) => row.id === run.id).length, 1);
      assert.deepEqual(
        restarted.runs.find((row) => row.id === run.id),
        stored,
      );
      assert.deepEqual(
        f.seen.map((row) => row.url),
        failure ? ["/child"] : ["/child", "/last"],
      );
      assert.deepEqual(await f.get(f.other.id), f.other);
    },
  );
}
