import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequest,
  snapshotPlan,
  restoreProject,
  exportOpenAPI,
  toCurl,
  runPlan,
} from "../src/core.mjs";
import { httpRedirectFailure } from "../src/http-redirect.mjs";
import { snapshotCase } from "../src/cases.mjs";
import { runLoad } from "../src/load-runner.mjs";

const enabled = { mode: "same-origin", maxHops: 3 };
const request = (extra = {}) => ({
  id: "api-one",
  name: "Redirect fixture",
  url: "http://127.0.0.1:1/start",
  ...extra,
});
const project = () => ({
  version: 1,
  id: "project-one",
  name: "Redirect definitions",
  requests: [],
  environments: [{ id: "environment-one", name: "Default", variables: {} }],
  plans: [],
  cases: [],
});

test("redirect definitions preserve default-off shape and normalize only explicit opt-in", () => {
  const ordinary = normalizeRequest(request());
  assert.equal(Object.hasOwn(ordinary, "redirect"), false);
  const source = request({ redirect: { mode: "same-origin" } });
  const normalized = normalizeRequest(source);
  assert.deepEqual(normalized.redirect, { mode: "same-origin", maxHops: 5 });
  assert.deepEqual(source.redirect, { mode: "same-origin" });
  for (const redirect of [
    null,
    false,
    true,
    "same-origin",
    {},
    { mode: "all" },
    { mode: "same-origin", maxHops: 0 },
    { mode: "same-origin", maxHops: 6 },
    { mode: "same-origin", maxHops: "3" },
    { mode: "same-origin", surprise: true },
  ]) {
    assert.throws(() => normalizeRequest(request({ redirect })));
  }
});

test("case, plan and backup round-trip keep frozen redirect policies without aliasing live definitions", () => {
  const live = request({ redirect: { ...enabled } });
  const frozenCase = snapshotCase({
    name: "Frozen case",
    sourceRequestId: live.id,
    request: live,
  });
  const frozenPlan = snapshotPlan({
    name: "Frozen plan",
    steps: [{ request: live }],
  });
  live.redirect.maxHops = 1;
  assert.deepEqual(frozenCase.request.redirect, enabled);
  assert.deepEqual(frozenPlan.steps[0].request.redirect, enabled);
  const backup = {
    ...project(),
    requests: [live],
    cases: [frozenCase],
    plans: [frozenPlan],
  };
  const restored = restoreProject(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(restored.requests[0].redirect, {
    mode: "same-origin",
    maxHops: 1,
  });
  assert.deepEqual(restored.cases[0].request.redirect, enabled);
  assert.deepEqual(restored.plans[0].steps[0].request.redirect, enabled);
  assert.deepEqual(backup.plans[0].steps[0].request.redirect, enabled);
});

test("lossy exports reject only policies on definitions they actually export", () => {
  assert.throws(
    () => toCurl(request({ redirect: enabled })),
    /重定向|redirect/i,
  );
  assert.match(toCurl(request()), /curl/);
  const input = { ...project(), requests: [request({ redirect: enabled })] };
  const before = JSON.stringify(input);
  assert.throws(() => exportOpenAPI(input), /重定向|redirect/i);
  assert.equal(JSON.stringify(input), before);
  for (const extra of [
    { cases: [{ request: request({ redirect: enabled }) }] },
    { plans: [{ steps: [{ request: request({ redirect: enabled }) }] }] },
    { history: [{ request: request({ redirect: enabled }) }] },
    {
      requests: [
        request({ redirect: enabled, deletedAt: "2026-10-28T00:00:00Z" }),
      ],
    },
  ]) {
    assert.equal(exportOpenAPI({ ...project(), ...extra }).openapi, "3.0.3");
  }
});

test("load runner rejects enabled redirect policy before environment lookup or traffic", async () => {
  let reads = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        reads++;
        throw Error("must not inspect project");
      },
    },
  );
  await assert.rejects(
    runLoad(hostile, request({ redirect: enabled })),
    /重定向/,
  );
  assert.equal(reads, 0);
});

test("trusted redirect failure preserves actual 302 and skips accepted-status postwork and subsequent steps", async () => {
  const actual = {
    status: 302,
    headers: { location: "/blocked" },
    body: '{"value":"must-not-extract"}',
    size: 28,
  };
  const first = request({
    redirect: enabled,
    assertions: [{ target: "status", operator: "equals", expected: 302 }],
    extract: [{ name: "leak", path: "$.value", type: "jsonpath" }],
    after: [{ type: "set", name: "afterLeak", value: "bad" }],
  });
  const plan = snapshotPlan({
    name: "Stop on redirect",
    steps: [
      { request: first, expectedStatus: 302 },
      { request: request({ id: "second" }) },
    ],
  });
  let calls = 0;
  const run = await runPlan(plan, {}, async () => {
    calls++;
    throw httpRedirectFailure(
      actual,
      "origin",
      [],
      "http://127.0.0.1:2/blocked",
      false,
      true,
    );
  });
  assert.equal(calls, 1);
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 1);
  const record = run.results[0];
  assert.equal(record.status, "failed");
  assert.equal(record.response, actual);
  assert.equal(record.response.status, 302);
  assert.equal(record.redirectFailure.reason, "origin");
  assert.equal(record.redirectFailure.retry_safe, false);
  assert.deepEqual(record.assertions, []);
  assert.deepEqual(record.extracted, {});
  assert.equal(run.variables.leak, undefined);
  assert.equal(run.variables.afterLeak, undefined);
});

test("untrusted error response fields cannot fabricate redirect evidence", async () => {
  const plan = snapshotPlan({ steps: [{ request: request() }] });
  const error = Object.assign(Error("Untrusted"), {
    response: { status: 200 },
    redirectFailure: { reason: "origin" },
  });
  const run = await runPlan(plan, {}, async () => {
    throw error;
  });
  assert.equal(run.results[0].response, undefined);
  assert.equal(run.results[0].redirectFailure, undefined);
  assert.equal(run.results[0].status, "failed");
});
