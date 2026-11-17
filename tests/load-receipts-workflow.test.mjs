import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { versionPlan } from "../src/plan-version.mjs";

const secret = "PRIVATE_LOAD_RECEIPT_SENTINEL_69871";
const schedule = {
  initialVUs: 1,
  stages: [{ durationSeconds: 10, targetVUs: 1 }],
  maxIterations: 1,
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn) {
  for (let i = 0; i < 100; i++) {
    const result = await fn();
    if (result) return result;
    await pause(20);
  }
  assert.fail("receipt did not reach expected state");
}
async function fixture(t) {
  let releaseHold;
  const held = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const seen = [];
  const peer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.url.startsWith("/hold")) return releaseHold();
    res.setHeader("x-private", secret);
    res.end(secret);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "load-receipts-"));
  let app = await createApp({ root, port: 0 });
  const project = await app.store.create("private project " + secret);
  t.after(async () => {
    await close(app.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  });
  const route = `/api/projects/${project.id}`;
  const owner = (url, method = "GET", body, signal) =>
    fetch(app.url + url, {
      method,
      signal,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const request = (hold = false) => ({
    method: "POST",
    name: secret,
    url: `http://127.0.0.1:${peer.address().port}/${hold ? "hold" : "ok"}?private=${secret}`,
    headers: [{ key: "x-private", value: secret }],
    bodyType: "raw",
    body: secret,
  });
  async function prepare(kind, req = request()) {
    if (kind === "one-shot") return { request: req, count: 1, concurrency: 1 };
    const p = await app.store.get(project.id);
    p.plans = [
      versionPlan(
        undefined,
        {
          id: "receipt-plan",
          name: secret,
          steps: [{ id: "receipt-step", name: secret, request: req }],
        },
        "manual",
        p,
      ),
    ];
    await app.store.save(p);
    return { planId: "receipt-plan", schedule };
  }
  const endpoint = (kind) =>
    route + (kind === "one-shot" ? "/load" : "/staged-load");
  async function finish(response, kind) {
    assert.equal(response.status, 200);
    if (kind === "one-shot") return response.json();
    const rows = (await response.text())
      .trim()
      .split("\n\n")
      .map((row) => {
        const lines = row.split("\n");
        return {
          event: lines[0].slice(7),
          data: JSON.parse(lines[1].slice(6)),
        };
      });
    assert.equal(rows.at(-1).event, "complete");
    const result = rows.find((row) => row.event === "reportEnd").data;
    if (result.recordSaved)
      assert.equal(
        rows.find((row) => row.event === "start").data.recordId,
        result.recordId,
      );
    return result;
  }
  async function list() {
    const r = await owner(route + "/load-reports");
    assert.equal(r.status, 200);
    return (await r.json()).records;
  }
  async function single(id) {
    const r = await owner(route + "/load-reports/" + id);
    assert.equal(r.status, 200);
    return r.json();
  }
  return {
    get app() {
      return app;
    },
    project,
    route,
    owner,
    prepare,
    endpoint,
    finish,
    list,
    single,
    request,
    held,
    seen,
    restart: async () => {
      await close(app.server);
      app = await createApp({ root, port: 0 });
    },
  };
}
function privacy(record) {
  const allowed = [
    "version",
    "id",
    "kind",
    "state",
    "startedAt",
    "finishedAt",
    "summary",
  ];
  for (const key of Object.keys(record))
    assert.ok(allowed.includes(key), `unexpected record field ${key}`);
  assert.equal(record.version, 1);
  assert.match(
    record.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  const summaryFields = [
    "reportSemantics",
    "failureCounts",
    "count",
    "requested",
    "concurrency",
    "elapsed",
    "passed",
    "timingSamples",
    "p50",
    "p95",
    "mainRequests",
    "scriptRequests",
    "dataRows",
    "elapsedMs",
    "activeVUs",
    "runningIterations",
    "started",
    "completed",
    "failed",
    "stepCompletionsPerSecond",
    "iterationsCompletedPerSecond",
    "stopReason",
    "cancelled",
    "networkBudget",
  ];
  for (const key of Object.keys(record.summary ?? {}))
    assert.ok(summaryFields.includes(key), `unexpected summary field ${key}`);
  const encoded = JSON.stringify(record);
  assert.equal(
    encoded.includes(secret),
    false,
    "receipt must not persist private request/response text",
  );
  assert.equal(
    encoded.includes("127.0.0.1"),
    false,
    "receipt must not persist request URLs",
  );
  for (const forbidden of [
    "results",
    "responsePreview",
    "request",
    "headers",
    "body",
    "variables",
    "error",
    "assertionFailures",
  ])
    assert.equal(
      Object.hasOwn(record.summary ?? {}, forbidden),
      false,
      forbidden,
    );
}
for (const kind of ["one-shot", "staged"]) {
  test(`${kind} load receipts are opt-in, bounded private summaries, queryable after restart`, async (t) => {
    const f = await fixture(t);
    const body = await f.prepare(kind);
    const ordinary = await f.finish(
      await f.owner(f.endpoint(kind), "POST", body),
      kind,
    );
    for (const key of ["recordSaved", "recordId", "attemptedRecordId"])
      assert.equal(Object.hasOwn(ordinary, key), false);
    assert.deepEqual(await f.list(), []);
    assert.equal(
      (await f.app.store.get(f.project.id)).loadRuns?.length ?? 0,
      0,
    );
    const result = await f.finish(
      await f.owner(f.endpoint(kind), "POST", { ...body, persistReport: true }),
      kind,
    );
    assert.equal(result.recordSaved, true);
    assert.equal(typeof result.recordId, "string");
    assert.ok(result.recordId);
    const records = await f.list();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.id, result.recordId);
    assert.equal(record.state, "completed");
    assert.equal(record.summary.mainRequests, 1);
    assert.deepEqual(record.summary.reportSemantics, result.reportSemantics);
    assert.deepEqual(record.summary.failureCounts, result.failureCounts);
    privacy(record);
    assert.equal(f.seen.length, 2);
    assert.equal(f.seen[1].headers["x-private"], secret);
    assert.equal(f.seen[1].body, secret);
    assert.deepEqual((await f.app.store.get(f.project.id)).loadRuns, records);
    await f.restart();
    assert.deepEqual(await f.list(), records);
    assert.deepEqual(await f.single(result.recordId), record);
  });
  for (const disconnect of [false, true]) {
    test(`${kind} ${disconnect ? "disconnect" : "explicit cancel"} finalizes the pending receipt without exposing payloads`, async (t) => {
      const f = await fixture(t);
      const body = await f.prepare(kind, f.request(true));
      const runId = `receipt-${kind}-${disconnect}`;
      const controller = new AbortController();
      const running = f
        .owner(
          f.endpoint(kind),
          "POST",
          { ...body, runId, persistReport: true },
          controller.signal,
        )
        .then((response) => f.finish(response, kind));
      // Attach immediately so disconnect cannot create an unhandled rejection.
      const settled = running.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await f.held;
      const pending = await f.list();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].state, "pending");
      privacy(pending[0]);
      if (disconnect) controller.abort();
      else
        assert.equal(
          (await f.owner("/api/cancel", "POST", { id: runId })).status,
          200,
        );
      const outcome = await settled;
      if (disconnect) assert.ok(outcome.error);
      else {
        assert.equal(outcome.value.cancelled, true);
        assert.equal(outcome.value.recordSaved, true);
        assert.equal(outcome.value.recordId, pending[0].id);
      }
      const record = await eventually(async () => {
        const rows = await f.list();
        return rows[0]?.state === "cancelled" && rows[0];
      });
      assert.equal(record.id, pending[0].id);
      privacy(record);
      assert.equal(f.seen.length, 1);
      await f.restart();
      assert.deepEqual(await f.single(record.id), record);
    });
  }
}

for (const kind of ["one-shot", "staged"]) {
  test(`${kind} preflight failure settles its receipt without storing diagnostic strings`, async (t) => {
    const f = await fixture(t);
    const req = {
      ...f.request(),
      redirect: { mode: "same-origin", maxHops: 1 },
      beforeScript: `throw new Error('${secret}')`,
    };
    const body = await f.prepare(kind, req);
    const response = await f.owner(f.endpoint(kind), "POST", {
      ...body,
      persistReport: true,
    });
    assert.equal(response.status, 400);
    await response.text();
    const rows = await f.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "failed");
    assert.equal(Object.hasOwn(rows[0], "summary"), false);
    assert.ok(rows[0].finishedAt);
    privacy(rows[0]);
    assert.equal(f.seen.length, 0);
  });
}

for (const kind of ["one-shot", "staged"]) {
  for (const uncertain of [false, true]) {
    test(`${kind} pending ${uncertain ? "commit uncertainty" : "save failure"} returns 503 without executing or replaying`, async (t) => {
      const f = await fixture(t);
      const body = await f.prepare(kind);
      const original = f.app.store.writeLoadReport.bind(f.app.store);
      let writes = 0;
      f.app.store.writeLoadReport = async (projectId, record) => {
        writes++;
        assert.equal(record.state, "pending");
        if (uncertain) {
          await original(projectId, record);
          throw new ProjectCommitUncertain(projectId, new Error(secret));
        }
        throw new Error(secret);
      };
      const response = await f.owner(f.endpoint(kind), "POST", {
        ...body,
        persistReport: true,
      });
      assert.equal(response.status, 503);
      const result = await response.json();
      assert.equal(result.recordSaved, false);
      assert.equal(result.recordId, null);
      assert.equal(typeof result.attemptedRecordId, "string");
      assert.equal(
        result.persistenceOutcome.code,
        uncertain ? "PROJECT_COMMIT_UNCERTAIN" : "RECORD_SAVE_FAILED",
      );
      assert.equal(result.persistenceOutcome.retry_safe, false);
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(writes, 1);
      assert.equal(f.seen.length, 0);
      const rows = await f.list();
      assert.equal(rows.length, uncertain ? 1 : 0);
      if (uncertain) {
        assert.equal(rows[0].id, result.attemptedRecordId);
        assert.equal(rows[0].state, "pending");
        assert.deepEqual(await f.single(result.attemptedRecordId), rows[0]);
        privacy(rows[0]);
      }
    });
  }
  test(`${kind} terminal commit uncertainty preserves the execution result and queryable evidence without replay`, async (t) => {
    const f = await fixture(t);
    const body = await f.prepare(kind);
    const original = f.app.store.writeLoadReport.bind(f.app.store);
    const states = [];
    f.app.store.writeLoadReport = async (projectId, record) => {
      states.push(record.state);
      const result = await original(projectId, record);
      if (record.state !== "pending")
        throw new ProjectCommitUncertain(projectId, new Error(secret));
      return result;
    };
    const result = await f.finish(
      await f.owner(f.endpoint(kind), "POST", { ...body, persistReport: true }),
      kind,
    );
    assert.equal(result.mainRequests, 1);
    assert.equal(result[kind === "one-shot" ? "passed" : "completed"], 1);
    assert.equal(result.recordSaved, false);
    assert.equal(result.recordId, null);
    assert.equal(result.persistenceOutcome.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(result.persistenceOutcome.retry_safe, false);
    assert.deepEqual(states, ["pending", "completed"]);
    assert.equal(f.seen.length, 1);
    const rows = await f.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, result.attemptedRecordId);
    assert.equal(rows[0].state, "completed");
    assert.deepEqual(await f.single(result.attemptedRecordId), rows[0]);
    privacy(rows[0]);
    await f.restart();
    assert.deepEqual(await f.single(result.attemptedRecordId), rows[0]);
    assert.equal(f.seen.length, 1);
  });
  test(`${kind} cancellation during pending save produces one zero-work cancelled receipt`, async (t) => {
    const f = await fixture(t);
    const body = await f.prepare(kind);
    const original = f.app.store.writeLoadReport.bind(f.app.store);
    let entered, release;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const states = [];
    f.app.store.writeLoadReport = async (projectId, record) => {
      states.push(record.state);
      const result = await original(projectId, record);
      if (record.state === "pending") {
        entered();
        await gate;
      }
      return result;
    };
    const runId = `zero-work-${kind}`;
    const running = f
      .owner(f.endpoint(kind), "POST", { ...body, persistReport: true, runId })
      .then((r) => f.finish(r, kind));
    await pending;
    const before = await f.list();
    assert.equal(before.length, 1);
    assert.equal(before[0].state, "pending");
    assert.equal(
      (await f.owner("/api/cancel", "POST", { id: runId })).status,
      200,
    );
    release();
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.mainRequests, 0);
    assert.equal(result[kind === "one-shot" ? "count" : "started"], 0);
    assert.equal(result.recordSaved, true);
    assert.equal(result.recordId, before[0].id);
    assert.deepEqual(states, ["pending", "cancelled"]);
    assert.equal(f.seen.length, 0);
    const after = await f.list();
    assert.equal(after.length, 1);
    assert.equal(after[0].state, "cancelled");
    assert.equal(after[0].id, before[0].id);
    assert.equal(after[0].summary.mainRequests, 0);
    privacy(after[0]);
  });
}

test("owner report reads require token and stay within project identity", async (t) => {
  const f = await fixture(t);
  const result = await f.finish(
    await f.owner(f.endpoint("one-shot"), "POST", {
      ...(await f.prepare("one-shot")),
      persistReport: true,
    }),
    "one-shot",
  );
  const withoutToken = await fetch(f.app.url + f.route + "/load-reports");
  assert.equal(withoutToken.status, 403);
  const other = await f.app.store.create("other");
  assert.equal(
    (await f.owner(`/api/projects/${other.id}/load-reports/${result.recordId}`))
      .status,
    404,
  );
  assert.equal(
    (await f.owner(f.route + "/load-reports/" + result.recordId, "DELETE"))
      .status,
    400,
  );
  assert.equal((await f.owner(f.route + "/load-reports?extra=1")).status, 400);
  assert.equal((await f.single(result.recordId)).state, "completed");
  assert.equal(f.seen.length, 1);
});

for (const kind of ["one-shot", "staged"]) {
  test(`${kind} ten concurrent owner loads retain ten unique terminal receipts across restart`, async (t) => {
    const f = await fixture(t);
    const body = await f.prepare(kind);
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        f
          .owner(f.endpoint(kind), "POST", {
            ...body,
            persistReport: true,
            runId: `concurrent-${kind}-${index}`,
          })
          .then((response) => f.finish(response, kind)),
      ),
    );
    const rejected = settled.filter((item) => item.status === "rejected");
    assert.deepEqual(
      rejected.map((item) => String(item.reason)),
      [],
      "all ten HTTP executions must complete successfully",
    );
    const results = settled.map((item) => item.value);
    assert.equal(f.seen.length, 10, "each admitted run executes exactly once");
    for (const result of results) {
      assert.equal(result.mainRequests, 1);
      assert.equal(result[kind === "one-shot" ? "passed" : "completed"], 1);
      assert.equal(
        result.recordSaved,
        true,
        JSON.stringify(result.persistenceOutcome),
      );
      assert.equal(typeof result.recordId, "string");
    }
    const ids = results.map((result) => result.recordId);
    assert.equal(new Set(ids).size, 10);
    const rows = await f.list();
    assert.equal(rows.length, 10);
    assert.deepEqual(rows.map((record) => record.id).sort(), [...ids].sort());
    for (const record of rows) {
      assert.equal(record.state, "completed");
      assert.equal(record.summary.mainRequests, 1);
      privacy(record);
    }
    await f.restart();
    assert.deepEqual(await f.list(), rows);
    for (const record of rows)
      assert.deepEqual(await f.single(record.id), record);
    assert.equal(
      f.seen.length,
      10,
      "reading persisted evidence must not replay network",
    );
  });
}
