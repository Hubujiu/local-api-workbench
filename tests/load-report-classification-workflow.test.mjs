import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { versionPlan } from "../src/plan-version.mjs";

const categories = [
  "http-status-policy",
  "assertion",
  "execution",
  "cancelled",
  "redirect",
];
const counts = (values = {}) =>
  Object.fromEntries(categories.map((key) => [key, values[key] ?? 0]));
const schedule = {
  initialVUs: 1,
  stages: [{ durationSeconds: 10, targetVUs: 1 }],
  maxIterations: 1,
};
const expectedSemantics = (kind) => ({
  version: 1,
  statusPolicy: kind === "one-shot" ? "2xx-and-assertions" : "plan",
});
function events(text) {
  return text
    .trim()
    .split("\n\n")
    .map((entry) => {
      const lines = entry.split("\n");
      return { name: lines[0].slice(7), value: JSON.parse(lines[1].slice(6)) };
    });
}
async function fixture(t) {
  let onHold;
  const held = new Promise((resolve) => {
    onHold = resolve;
  });
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/hold") return onHold();
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/forbidden" });
      return res.end("blocked");
    }
    res.statusCode = req.url === "/404" ? 404 : req.url === "/204" ? 204 : 200;
    res.end("body");
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(
    path.join(tmpdir(), "load-report-classification-"),
  );
  const app = await createApp({ root, port: 0 });
  const project = await app.store.create("report classification");
  t.after(async () => {
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all(
      [app.server, peer].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  const route = `/api/projects/${project.id}`;
  const owner = (url, method = "GET", body) =>
    fetch(app.url + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const save = async (requests, statusPolicy = "assertions") => {
    const p = await app.store.get(project.id);
    p.plans = [
      versionPlan(
        undefined,
        {
          id: "plan",
          statusPolicy,
          steps: requests.map((request, index) => ({
            id: "step-" + index,
            request,
          })),
        },
        "manual",
        p,
      ),
    ];
    await app.store.save(p);
  };
  return {
    app,
    project,
    seen,
    held,
    owner,
    route,
    save,
    base: "http://127.0.0.1:" + peer.address().port,
    async run(kind, requests, extra = {}) {
      let response;
      if (kind === "one-shot")
        response = await owner(route + "/load", "POST", {
          request: requests[0],
          count: 1,
          concurrency: 1,
          ...extra,
        });
      else {
        await save(requests);
        response = await owner(route + "/staged-load", "POST", {
          planId: "plan",
          schedule,
          ...extra,
        });
      }
      assert.equal(response.status, 200);
      if (kind === "one-shot") return response.json();
      const records = events(await response.text());
      assert.equal(records.at(-1).name, "complete");
      assert.equal(records.at(-2).name, "reportEnd");
      for (const record of records.filter((r) =>
        ["report", "reportEnd"].includes(r.name),
      )) {
        assert.deepEqual(record.value.reportSemantics, expectedSemantics(kind));
        assert.deepEqual(
          Object.keys(record.value.failureCounts).sort(),
          [...categories].sort(),
        );
        for (const step of record.value.steps)
          assert.deepEqual(
            Object.keys(step.failureCounts).sort(),
            [...categories].sort(),
          );
      }
      return records.at(-2).value;
    },
  };
}
function classified(result, kind, failures) {
  assert.deepEqual(result.reportSemantics, expectedSemantics(kind));
  assert.deepEqual(
    result.failureCounts,
    counts(Object.fromEntries(failures.map((key) => [key, 1]))),
  );
  if (kind === "one-shot") {
    assert.deepEqual(
      [...result.results[0].failureReasons].sort(),
      [...failures].sort(),
    );
    assert.equal(
      new Set(result.results[0].failureReasons).size,
      failures.length,
    );
  } else assert.deepEqual(result.steps[0].failureCounts, result.failureCounts);
}

for (const kind of ["one-shot", "staged"]) {
  test(`${kind} owner report states its legacy policy without changing 404 positive assertions or ordinary 2xx`, async (t) => {
    const f = await fixture(t);
    const notFound = await f.run(kind, [
      {
        url: f.base + "/404",
        assertions: [{ target: "status", op: "eq", value: 404 }],
      },
    ]);
    classified(
      notFound,
      kind,
      kind === "one-shot" ? ["http-status-policy"] : [],
    );
    assertLegacy404Projection(notFound, kind);
    if (kind === "one-shot") {
      assert.equal(notFound.passed, 0);
      assert.equal(notFound.results[0].assertionFailureCount, 0);
    } else {
      assert.equal(notFound.failed, 0);
      assert.equal(notFound.completed, 1);
    }
    const ok = await f.run(kind, [{ url: f.base + "/ok" }]);
    classified(ok, kind, []);
    if (kind === "one-shot") assert.equal(ok.passed, 1);
    else assert.equal(ok.failed, 0);
    const noContent = await f.run(kind, [{ url: f.base + "/204" }]);
    classified(noContent, kind, []);
    if (kind === "one-shot") assert.equal(noContent.passed, 1);
    else assert.equal(noContent.failed, 0);
    assert.deepEqual(f.seen, ["/404", "/ok", "/204"]);
  });

  test(`${kind} owner report separates assertion and execution failures without VM scripts`, async (t) => {
    const f = await fixture(t);
    const assertion = await f.run(kind, [
      {
        url: f.base + "/404",
        assertions: [{ target: "status", op: "eq", value: 200 }],
      },
    ]);
    classified(
      assertion,
      kind,
      kind === "one-shot" ? ["http-status-policy", "assertion"] : ["assertion"],
    );
    const before = f.seen.length;
    const execution = await f.run(kind, [{ url: f.base + "/{{missing}}" }]);
    classified(execution, kind, ["execution"]);
    assert.equal(f.seen.length, before);
  });
}

test("staged owner SSE counts each failure class once per iteration while retaining each failed step", async (t) => {
  const f = await fixture(t);
  const request = {
    url: f.base + "/ok",
    assertions: [{ target: "status", op: "eq", value: 404 }],
  };
  const result = await f.run("staged", [request, request], {
    schedule: { ...schedule, maxIterations: 2 },
  });
  assert.equal(result.failed, 2);
  assert.equal(result.completed, 2);
  assert.equal(result.mainRequests, 4);
  assert.deepEqual(result.failureCounts, counts({ assertion: 2 }));
  assert.equal(result.steps.length, 2);
  for (const step of result.steps) {
    assert.equal(step.failed, 2);
    assert.deepEqual(step.failureCounts, counts({ assertion: 2 }));
  }
  assert.equal(f.seen.length, 4);
});

for (const kind of ["one-shot", "staged"]) {
  test(`${kind} owner report classifies redirect refusal without treating an intermediate 302 as terminal status failure`, async (t) => {
    const f = await fixture(t);
    const result = await f.run(kind, [
      {
        url: f.base + "/redirect",
        redirect: { mode: "same-origin", maxHops: 1 },
      },
    ]);
    classified(result, kind, ["redirect"]);
    assert.deepEqual(f.seen, ["/redirect"]);
    assert.deepEqual(result.networkBudget, {
      limit: 100,
      reservations: 1,
      started: 1,
      redirectHops: 0,
    });
    if (kind === "one-shot") {
      assert.equal(result.passed, 0);
      assert.equal(result.results[0].redirectFailure.reason, "origin");
    } else {
      assert.equal(result.failed, 1);
      assert.deepEqual(result.steps[0].redirectFailures, { origin: 1 });
    }
  });

  test(
    `${kind} explicit owner cancellation returns a terminal cancellation class rather than execution failure`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const id = "classification-cancel-" + kind;
      const pending = f.run(kind, [{ url: f.base + "/hold" }], { runId: id });
      await f.held;
      const cancellation = await f.owner("/api/cancel", "POST", { id });
      assert.equal(cancellation.status, 200);
      const result = await pending;
      assert.equal(result.cancelled, true);
      assert.equal(result.stopReason, "cancelled");
      classified(result, kind, ["cancelled"]);
      assert.deepEqual(f.seen, ["/hold"]);
      assert.equal(result.mainRequests, 1);
    },
  );
}

// Inspect real returned reports as a legacy consumer would: discard only the
// additive classification fields and assert the previous policy/count contract.
function legacyProjection(report) {
  const copy = structuredClone(report);
  delete copy.reportSemantics;
  delete copy.failureCounts;
  for (const row of copy.results || []) delete row.failureReasons;
  for (const step of copy.steps || []) delete step.failureCounts;
  return copy;
}
function assertLegacy404Projection(report, kind) {
  const old = legacyProjection(report);
  assert.equal(Object.hasOwn(old, "reportSemantics"), false);
  assert.equal(Object.hasOwn(old, "failureCounts"), false);
  assert.equal(old.mainRequests, 1);
  assert.equal(old.cancelled, false);
  if (kind === "one-shot") {
    assert.deepEqual(
      {
        count: old.count,
        requested: old.requested,
        concurrency: old.concurrency,
        passed: old.passed,
        timingSamples: old.timingSamples,
        scriptRequests: old.scriptRequests,
        stopReason: old.stopReason,
        variableIsolation: old.variableIsolation,
      },
      {
        count: 1,
        requested: 1,
        concurrency: 1,
        passed: 0,
        timingSamples: 1,
        scriptRequests: 0,
        stopReason: "count",
        variableIsolation: "per-request",
      },
    );
    assert.equal(old.results.length, 1);
    const row = old.results[0];
    assert.deepEqual(
      {
        index: row.index,
        status: row.status,
        passed: row.passed,
        interrupted: row.interrupted,
        assertionFailureCount: row.assertionFailureCount,
        assertionFailures: row.assertionFailures,
        subrequests: row.subrequests,
        responsePreview: row.responsePreview,
      },
      {
        index: 0,
        status: 404,
        passed: false,
        interrupted: false,
        assertionFailureCount: 0,
        assertionFailures: [],
        subrequests: [],
        responsePreview: "body",
      },
    );
    assert.equal(Object.hasOwn(row, "failureReasons"), false);
    assert.equal(Object.hasOwn(row, "error"), false);
  } else {
    assert.deepEqual(
      {
        started: old.started,
        completed: old.completed,
        failed: old.failed,
        stopReason: old.stopReason,
      },
      { started: 1, completed: 1, failed: 0, stopReason: "iteration-limit" },
    );
    assert.equal(old.steps.length, 1);
    const step = old.steps[0];
    assert.deepEqual(
      {
        stepId: step.stepId,
        count: step.count,
        failed: step.failed,
        timingSamples: step.timingSamples,
        receivedBytes: step.receivedBytes,
      },
      {
        stepId: "step-0",
        count: 1,
        failed: 0,
        timingSamples: 1,
        receivedBytes: 4,
      },
    );
    assert.equal(Object.hasOwn(step, "failureCounts"), false);
  }
}

test("new load report classification does not rewrite pre-existing owner run history or label it version 1", async (t) => {
  const f = await fixture(t);
  await f.save([{ url: f.base + "/ok" }]);
  const executed = await f.owner(f.route + "/run", "POST", { planId: "plan" });
  assert.equal(executed.status, 200);
  assert.equal((await executed.json()).status, "passed");
  const before = await f.app.store.get(f.project.id);
  assert(
    before.runs.length > 0,
    "the history must really be persisted before the new reports",
  );
  for (const run of before.runs)
    assert.equal(Object.hasOwn(run, "reportSemantics"), false);
  const history = structuredClone({
    runs: before.runs,
    history: before.history,
  });
  const one = await f.run("one-shot", [{ url: f.base + "/404" }]);
  assert.deepEqual(one.reportSemantics, expectedSemantics("one-shot"));
  const stagedResponse = await f.owner(f.route + "/staged-load", "POST", {
    planId: "plan",
    schedule,
  });
  assert.equal(stagedResponse.status, 200);
  const terminal = events(await stagedResponse.text()).find(
    (event) => event.name === "reportEnd",
  ).value;
  assert.deepEqual(terminal.reportSemantics, expectedSemantics("staged"));
  const response = await f.owner(f.route);
  assert.equal(response.status, 200);
  const after = await response.json();
  assert.deepEqual({ runs: after.runs, history: after.history }, history);
  for (const run of after.runs) {
    assert.equal(Object.hasOwn(run, "reportSemantics"), false);
    assert.equal(Object.hasOwn(run, "failureCounts"), false);
  }
});
