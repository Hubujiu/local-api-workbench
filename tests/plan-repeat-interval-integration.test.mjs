// Uses real transports, persistence and owner revocation; never mocks execution.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { planOccurrences } from "../src/plan-repeat.mjs";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { prepareStagedLoad, runStagedLoad } from "../src/staged-load-plan.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const leaf = (id, url = "http://example.test/" + id) => ({
  id,
  request: { url },
});
const repeat = (id, steps, intervalMs = 1) => ({
  id,
  type: "repeat",
  count: 2,
  intervalMs,
  steps,
});
async function until(read, predicate, label) {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    const v = await read();
    if (predicate(v)) return v;
    await delay(10);
  }
  throw Error(label);
}
async function bounded(p, label) {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise(
        (_, reject) => (timer = setTimeout(() => reject(Error(label)), 5000)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("nested interval evidence stop skips wait in next and remaining", async () => {
  const p = snapshotPlan({
    steps: [repeat("outer", [repeat("inner", [leaf("a")]), leaf("b")])],
  });
  assert.deepEqual(
    planOccurrences(p.steps, { controls: true }).map((x) =>
      x.wait ? "wait" : x.step.id,
    ),
    ["a", "wait", "a", "b", "wait", "a", "wait", "a", "b"],
  );
  let calls = 0;
  const v = await runPlan(p, {}, async () => {
    calls++;
    return { status: 200, headers: {}, body: "x".repeat(9 * 1024 * 1024) };
  });
  assert.equal(calls, 1);
  assert.equal(v.stopReason, "evidence-limit");
  assert.equal(v.results.length, 1);
  assert.equal(v.evidenceBudget.remaining, 5);
  assert.equal(
    v.evidenceBudget.next.repeat.occurrenceId,
    '[[["outer",0],["inner",1]],"a"]',
  );
  assert.equal(
    v.evidenceBudget.last.repeat.occurrenceId,
    '[[["outer",0],["inner",0]],"a"]',
  );
});

test(
  "staged deadline aborts repeat wait after saved interval roundtrip",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "interval-staged-review-"));
    let hits = 0;
    const peer = http.createServer((req, res) => {
      hits++;
      res.end("ok");
    });
    t.after(async () => {
      peer.closeAllConnections();
      await new Promise((r) => peer.close(r));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise((r) => peer.listen(0, "127.0.0.1", r));
    const store = new Store(directory);
    await store.init();
    const p = await store.create("interval review");
    p.plans = [
      snapshotPlan({
        steps: [
          repeat(
            "group",
            [leaf("leaf", `http://127.0.0.1:${peer.address().port}/`)],
            10000,
          ),
        ],
      }),
    ];
    await store.save(p);
    const saved = await store.get(p.id);
    assert.equal(saved.plans[0].steps[0].intervalMs, 10000);
    const prepared = prepareStagedLoad(saved, saved.plans[0], {
      initialVUs: 1,
      stages: [{ durationSeconds: 1, targetVUs: 1 }],
      maxIterations: 1,
    });
    const result = await bounded(
      runStagedLoad(saved, prepared),
      "deadline did not interrupt wait",
    );
    assert.equal(hits, 1);
    assert.equal(result.stopReason, "duration");
    assert.equal(result.mainRequests, 1);
    assert.equal(result.steps[0].count, 1);
    assert.equal(result.steps[0].failed, 0);
    assert.equal(result.runningIterations, 0);
  },
);

test(
  "official SDK owner revoke during repeat wait saves only completed occurrence",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "interval-revoke-review-"));
    let hits = 0,
      app,
      client,
      call,
      appendDone = false;
    const appended = Promise.withResolvers();
    const peer = http.createServer((req, res) => {
      hits++;
      res.end("ok");
    });
    t.after(async () => {
      const closing = app
        ? new Promise((r) => {
            app.server.close(r);
            app.server.closeIdleConnections();
          })
        : Promise.resolve();
      await client?.close();
      if (call) await bounded(call, "client cleanup");
      await bounded(closing, "app cleanup");
      if (call && !appendDone)
        await bounded(appended.promise, "server append cleanup");
      peer.closeAllConnections();
      await new Promise((r) => peer.close(r));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise((r) => peer.listen(0, "127.0.0.1", r));
    app = await createApp({ root: directory, port: 0 });
    const a = await app.store.create("revoked interval"),
      b = await app.store.create("retained project");
    a.plans = [
      snapshotPlan({
        id: "interval",
        steps: [
          repeat(
            "group",
            [leaf("leaf", `http://127.0.0.1:${peer.address().port}/`)],
            10000,
          ),
        ],
      }),
    ];
    await app.store.save(a);
    const owner = async (config) => {
      const res = await fetch(app.url + "/api/mcp/config", {
        method: config ? "POST" : "GET",
        signal: AbortSignal.timeout(5000),
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        ...(config ? { body: JSON.stringify(config) } : {}),
      });
      const value = await res.json();
      assert.equal(res.status, 200, JSON.stringify(value));
      return value;
    };
    const policy = {
      enabled: true,
      remember: true,
      write: true,
      execute: true,
      projects: [a.id, b.id],
    };
    const config = await owner(policy);
    const append = app.store.append;
    app.store.append = async function (projectId, field, ...args) {
      try {
        return await append.call(this, projectId, field, ...args);
      } finally {
        if (projectId === a.id && field === "runs") {
          appendDone = true;
          appended.resolve();
        }
      }
    };
    client = new Client({
      name: "repeat-interval-revocation-review",
      version: "1",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
      { timeout: 5000 },
    );
    call = client
      .callTool(
        {
          name: "localapi_run_plan",
          arguments: { projectId: a.id, planId: "interval" },
        },
        undefined,
        { timeout: 15000 },
      )
      .then(
        (value) => ({ kind: "resolved", value }),
        (error) => ({ kind: "rejected", error }),
      );
    await until(
      () => owner(),
      (s) =>
        s.activities.some(
          (x) =>
            x.projectId === a.id &&
            x.tool === "localapi_run_plan" &&
            x.status === "running" &&
            x.completed === 1,
        ),
      "first completed occurrence activity not received",
    );
    assert.equal(hits, 1);
    await owner({ ...policy, projects: [b.id] });
    const terminal = await bounded(call, "revoked wait did not settle");
    assert.equal(terminal.kind, "rejected");
    assert.match(terminal.error.message, /MCP authorization changed/);
    await bounded(appended.promise, "cancelled run append not settled");
    const state = await until(
      () => owner(),
      (s) =>
        s.activities.some(
          (x) =>
            x.projectId === a.id &&
            x.tool === "localapi_run_plan" &&
            x.status !== "running",
        ),
      "terminal activity absent",
    );
    const activity = state.activities.find(
      (x) => x.projectId === a.id && x.tool === "localapi_run_plan",
    );
    assert.equal(activity.recordSaved, true);
    assert.equal(activity.status, "cancelled");
    const saved = await app.store.get(a.id);
    assert.equal(saved.runs.length, 1);
    const run = saved.runs[0];
    assert.equal(run.status, "cancelled");
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "passed");
    assert.equal(run.results[0].repeat.iteration, 0);
    assert.equal(run.snapshot.steps[0].intervalMs, 10000);
    assert.equal(hits, 1);
    const fresh = await new Store(directory).get(a.id);
    assert.deepEqual(fresh.runs, saved.runs);
    assert.equal(hits, 1);
  },
);
