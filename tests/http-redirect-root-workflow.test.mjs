// Root-only intersections. No VM, scripts, database execution, or external peers.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRequest, Store } from "../src/runtime.mjs";
import {
  normalizeRequest,
  runPlan,
  snapshotPlan,
  restoreProject,
  exportOpenAPI,
} from "../src/core.mjs";
import { snapshotCase } from "../src/cases.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import {
  readResponseHeaderEvidence,
  readResponseCookieEvidence,
} from "../src/response-header-evidence.mjs";
import { projectCookieSession, ProjectCookieJar } from "../src/cookie-jar.mjs";
import { createServiceRequestResolver } from "../src/environments.mjs";
import { MCPActivity } from "../src/mcp-activity.mjs";
import { recordPlanRun } from "../src/plan-evidence.mjs";
import { listExecutionHistory } from "../src/execution-history.mjs";
import { createApp } from "../src/server.mjs";

const redirect = { mode: "same-origin", maxHops: 5 };
async function peer(t, handle) {
  const seen = [],
    errors = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, method: req.method });
    try {
      await handle(req, res);
    } catch (error) {
      errors.push(error);
      res.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
async function storage(t) {
  const root = await mkdtemp(path.join(tmpdir(), "redirect-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new Store(root) };
}
const request = (url, extra = {}) => ({
  id: "api",
  name: "API",
  url,
  redirect,
  ...extra,
});

test("redirect origin rejection inside repeat preserves actual 302 and stops every later occurrence without post effects", async (t) => {
  const forbidden = await peer(t, (_req, res) => res.end("must not arrive"));
  const origin = await peer(t, (_req, res) => {
    res.writeHead(302, {
      location: forbidden.url + "/secret",
      "content-type": "application/json",
    });
    res.end('{"token":"must-not-extract"}');
  });
  const plan = snapshotPlan({
    id: "repeat-plan",
    steps: [
      {
        id: "loop",
        type: "repeat",
        count: 3,
        steps: [
          {
            id: "leaf",
            expectedStatus: 302,
            request: request(origin.url, {
              assertions: [{ target: "status", op: "eq", value: 302 }],
              extract: [{ name: "token", source: "json", path: "$.token" }],
              after: [{ type: "set", name: "late", value: "must-not-run" }],
            }),
          },
        ],
      },
      { id: "later", request: request(origin.url + "/later") },
    ],
  });
  const run = await runPlan(plan, { token: "old" }, executeRequest);
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 1);
  const record = run.results[0];
  assert.equal(record.repeat.iteration, 0);
  assert.equal(record.response.status, 302);
  assert.equal(record.status, "failed");
  assert.equal(record.redirectFailure.reason, "origin");
  assert.equal(record.redirectFailure.retry_safe, false);
  assert.equal(record.redirectFailure.responseComplete, true);
  assert.deepEqual(record.assertions, []);
  assert.deepEqual(record.extracted, {});
  assert.equal(run.variables.token, "old");
  assert.equal(run.variables.late, undefined);
  assert.equal(origin.seen.length, 1);
  assert.equal(forbidden.seen.length, 0);
});

test("redirect final live response alone carries Header/Cookie authority; persisted and restored evidence cannot mint it", async (t) => {
  const origin = await peer(t, (req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, {
        location: "/final",
        "x-intermediate": "not-final",
        "set-cookie": "intermediate=one; Path=/",
      });
      return res.end("intermediate");
    }
    res.writeHead(200, { "x-final": "yes", "set-cookie": "final=two; Path=/" });
    res.end("actual final body");
  });
  const { root, store } = await storage(t);
  const project = await store.create("Authority");
  const result = await executeRequest(request(origin.url + "/start"));
  const header = readResponseHeaderEvidence(result),
    cookie = readResponseCookieEvidence(result);
  assert.equal(result.status, 200);
  assert.equal(result.effectiveUrl, origin.url + "/final");
  assert.equal(header.complete, true);
  assert.equal(header.counts["x-final"], 1);
  assert.equal(header.counts["x-intermediate"], undefined);
  assert.equal(cookie.complete, true);
  assert.deepEqual({ ...cookie.values }, { final: "two" });
  assert.equal(readResponseHeaderEvidence({ ...result }).complete, false);
  assert.equal(
    readResponseCookieEvidence(JSON.parse(JSON.stringify(result))).complete,
    false,
  );
  await store.append(project.id, "history", {
    id: "actual",
    name: "Actual",
    status: "passed",
    response: result,
  });
  const disk = await new Store(root).get(project.id);
  const restored = restoreProject(disk);
  await store.save(restored);
  for (const saved of [disk, await new Store(root).get(restored.id)]) {
    assert.deepEqual(
      saved.history[0].response,
      JSON.parse(JSON.stringify(result)),
    );
    assert.equal(
      readResponseHeaderEvidence(saved.history[0].response).complete,
      false,
    );
    assert.equal(
      readResponseCookieEvidence(saved.history[0].response).complete,
      false,
    );
  }
  assert.equal(
    origin.seen.length,
    2,
    "read, backup and restore never replay HTTP",
  );
});

test("actual case and frozen flow exporters reject enabled redirect while unrelated OpenAPI live definitions remain exportable", () => {
  const live = normalizeRequest({
    id: "api",
    name: "API",
    url: "http://127.0.0.1:12345/live",
  });
  const base = {
    version: 1,
    id: "project",
    name: "Export",
    createdAt: "2026-10-28T00:00:00Z",
    requests: [live],
    environments: [{ id: "env", name: "Environment", variables: {} }],
    settings: {},
    plans: [],
    cases: [],
  };
  const caseOnly = structuredClone(base);
  caseOnly.cases = [
    snapshotCase({
      id: "case",
      name: "API",
      sourceRequestId: "api",
      request: { ...live, redirect },
    }),
  ];
  const clearCase = structuredClone(caseOnly);
  delete clearCase.cases[0].request.redirect;
  assert.doesNotThrow(() => exportApipost(clearCase));
  const caseBefore = structuredClone(caseOnly);
  assert.throws(() => exportApipost(caseOnly), /redirect/);
  assert.throws(() => exportApipostDirectory(caseOnly), /redirect/);
  assert.deepEqual(exportOpenAPI(caseOnly), exportOpenAPI(base));
  assert.deepEqual(caseOnly, caseBefore);
  const flowOnly = structuredClone(base);
  flowOnly.plans = [
    snapshotPlan({
      id: "flow",
      name: "Flow",
      statusPolicy: "strict200",
      environmentId: "env",
      steps: [{ id: "step", name: "API", request: { ...live, redirect } }],
    }),
  ];
  const clearFlow = structuredClone(flowOnly);
  delete clearFlow.plans[0].steps[0].request.redirect;
  assert.doesNotThrow(() => exportApipostDirectory(clearFlow));
  const flowBefore = structuredClone(flowOnly);
  assert.throws(() => exportApipostDirectory(flowOnly), /redirect/);
  assert.deepEqual(exportOpenAPI(flowOnly), exportOpenAPI(base));
  assert.deepEqual(flowOnly, flowBefore);
  const liveEnabled = structuredClone(base);
  liveEnabled.requests[0].redirect = redirect;
  assert.throws(() => exportOpenAPI(liveEnabled), /redirect/);
});

test("genuine progress journal failure after a redirect preserves completed final response and never executes the next repeat", async (t) => {
  const { root, store } = await storage(t);
  const project = await store.create("Progress");
  const activity = await new MCPActivity(root, {
    tool: "localapi_execute_flow",
    projectId: project.id,
  }).start();
  t.after(() => activity.finish(true).catch(() => {}));
  const journal = path.join(root, ".mcp-activities");
  let obstructed = false;
  const origin = await peer(t, async (req, res) => {
    if (req.url === "/start") {
      res.writeHead(307, { location: "/final" });
      return res.end();
    }
    await rename(journal, journal + "-owned-kept");
    await writeFile(journal, "owned progress obstacle");
    obstructed = true;
    res.end("real final response");
  });
  const plan = snapshotPlan({
    id: "progress",
    steps: [
      {
        id: "loop",
        type: "repeat",
        count: 3,
        steps: [{ id: "request", request: request(origin.url + "/start") }],
      },
    ],
  });
  const run = await runPlan(plan, {}, executeRequest, {
    onStep: (record) =>
      activity.update({
        completed: 1,
        total: 3,
        stepId: record.stepId,
        status: record.status,
      }),
  });
  assert.equal(obstructed, true);
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "progress-failure");
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].status, "passed");
  assert.equal(run.results[0].response.status, 200);
  assert.equal(run.results[0].response.body, "real final response");
  assert.equal(run.results[0].progressFailure.retry_safe, false);
  const receipt = await recordPlanRun(store, project.id, run, "mcp");
  assert.equal(receipt.recordSaved, true);
  await rm(journal);
  await rename(journal + "-owned-kept", journal);
  const disk = await new Store(root).get(project.id);
  const restored = restoreProject(disk);
  await store.save(restored);
  for (const saved of [disk, await new Store(root).get(restored.id)]) {
    assert.deepEqual(
      saved.runs[0].results,
      JSON.parse(JSON.stringify(run.results)),
    );
    const summary = JSON.stringify(listExecutionHistory(saved));
    assert(!summary.includes("real final response"));
    assert(!summary.includes(origin.url));
  }
  assert.equal(origin.seen.length, 2);
});

test("real owner history commit uncertainty retains redirected response and recovers by reading without resending", async (t) => {
  const { root } = await storage(t);
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const project = await app.store.create("Owner save");
  const origin = await peer(t, (req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final" });
      return res.end();
    }
    res.end("one completed final response");
  });
  const store = app.store,
    originalSave = store.save,
    originalRead = store.readUnlocked;
  const history = path.join(store.directory(project.id), "history"),
    kept = history + "-owned-kept";
  let attempts = 0,
    obstructed = false;
  store.save = async function (candidate, options) {
    if (candidate.id !== project.id || !options?.activity)
      return originalSave.call(this, candidate, options);
    attempts++;
    this.readUnlocked = async function (...args) {
      const previous = await originalRead.apply(this, args);
      this.readUnlocked = originalRead;
      await rename(history, kept);
      await writeFile(history, "owned history obstacle");
      obstructed = true;
      return previous;
    };
    try {
      return await originalSave.call(this, candidate, options);
    } finally {
      this.readUnlocked = originalRead;
    }
  };
  t.after(() => {
    store.save = originalSave;
    store.readUnlocked = originalRead;
  });
  const response = await fetch(
    app.url + "/api/projects/" + project.id + "/execute",
    {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ request: request(origin.url + "/start") }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 200);
  assert.equal(result.body, "one completed final response");
  assert.equal(result.recordSaved, false);
  assert.equal(result.recordId, null);
  assert.equal(result.persistenceOutcome.code, "PROJECT_COMMIT_UNCERTAIN");
  assert.equal(result.persistenceOutcome.retry_safe, false);
  assert.equal(obstructed, true);
  assert.equal(attempts, 1);
  assert(
    await readFile(
      path.join(store.directory(project.id), ".transaction.json"),
      "utf8",
    ),
  );
  store.save = originalSave;
  await rm(history);
  await rename(kept, history);
  const recovered = await new Store(root).get(project.id);
  assert.equal(recovered.history.length, 1);
  assert.equal(recovered.history[0].id, result.attemptedRecordId);
  assert.equal(
    recovered.history[0].response.effectiveUrl,
    origin.url + "/final",
  );
  assert.equal(recovered.history[0].response.body, result.body);
  assert.equal(origin.seen.length, 2);
});

test("captured service and Cookie environment stay fixed across redirect and later project environment changes", async (t) => {
  const { root, store } = await storage(t);
  const project = await store.create("Captured environment");
  let change = () => {};
  const origin = await peer(t, (req, res) => {
    if (req.url === "/start") {
      change();
      res.writeHead(302, {
        location: "/final",
        "set-cookie": "redirected=first-env; Path=/",
      });
      return res.end();
    }
    res.end("selected original origin");
  });
  const other = await peer(t, (_req, res) => res.end("new environment origin"));
  const firstId = project.environments[0].id;
  project.servers = [{ id: "service", name: "Service" }];
  project.environments[0].serverUrls = { service: origin.url };
  project.environments.push({
    id: "second",
    name: "Second",
    variables: {},
    serverUrls: { service: other.url },
  });
  await store.save(project);
  const resolve = createServiceRequestResolver(project, firstId);
  const firstJar = projectCookieSession(store, project, firstId);
  const secondJar = projectCookieSession(store, project, "second");
  for (const jar of [firstJar, secondJar])
    await jar.configure({
      enabled: true,
      expectedRevision: (await jar.inspect()).revision,
    });
  await firstJar.capture(origin.url, "seed=first-env; Path=/");
  await secondJar.capture(other.url, "seed=second-env; Path=/");
  const untouched = await secondJar.inspect();
  change = () => {
    project.currentEnvironmentId = "second";
    project.environments[0].serverUrls.service = other.url;
  };
  const result = await executeRequest(
    resolve(request("/start", { serviceId: "service" })),
    undefined,
    { cookieSession: firstJar },
  );
  assert.equal(result.status, 200);
  assert.equal(result.effectiveUrl, origin.url + "/final");
  assert.equal(origin.seen.length, 2);
  assert.match(origin.seen[0].cookie, /seed=first-env/);
  assert.match(origin.seen[1].cookie, /seed=first-env/);
  assert.match(origin.seen[1].cookie, /redirected=first-env/);
  assert(!origin.seen[1].cookie.includes("second-env"));
  assert.deepEqual(await secondJar.inspect(), untouched);
  assert.equal(other.seen.length, 0);
  assert.match(
    await new ProjectCookieJar(root, project.id, firstId).header(origin.url),
    /redirected=first-env/,
  );
  assert.equal(
    resolve(request("/next", { serviceId: "service" })).url,
    origin.url + "/next",
  );
});
