import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/runtime.mjs";
import {
  buildLoadSchedule,
  prepareStagedLoad,
  runStagedLoad,
} from "../src/staged-load-plan.mjs";

const options = {
  initialVUs: 2,
  stages: [
    { durationSeconds: 10, targetVUs: 4 },
    { durationSeconds: 3, targetVUs: 1 },
  ],
  maxIterations: 5,
};
test("ramp schedule uses cumulative stage time and supports graceful downscale", () => {
  assert.deepEqual(buildLoadSchedule(options), {
    initialVUs: 2,
    maxIterations: 5,
    reportIntervalSeconds: 1,
    durationMs: 13000,
    changes: [
      { atMs: 5000, vus: 3 },
      { atMs: 10000, vus: 4 },
      { atMs: 11000, vus: 3 },
      { atMs: 12000, vus: 2 },
      { atMs: 13000, vus: 1 },
    ],
  });
  assert.throws(
    () => buildLoadSchedule({ ...options, initialVUs: 11 }),
    /0–10/,
  );
  assert.throws(
    () =>
      buildLoadSchedule({
        ...options,
        stages: [{ durationSeconds: 61, targetVUs: 1 }],
      }),
    /60/,
  );
  assert.throws(
    () =>
      buildLoadSchedule({
        ...options,
        initialVUs: 0,
        stages: [{ durationSeconds: 1, targetVUs: 0 }],
      }),
    /至少/,
  );
});

async function fixture(t, handler) {
  const peer = createServer(handler);
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "staged-load-"));
  const store = new Store(root);
  await store.init();
  const project = await store.create("load");
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { project, url: `http://127.0.0.1:${peer.address().port}` };
}
const input = {
  initialVUs: 2,
  stages: [{ durationSeconds: 2, targetVUs: 2 }],
  maxIterations: 2,
};

test("real two-step plans run within the aggregate limit and report per-step statistics", async (t) => {
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    res.end("ok");
  });
  const plan = {
    id: "plan",
    steps: [
      { id: "a", request: { url: url + "/a" } },
      { id: "b", request: { url: url + "/b" } },
    ],
  };
  const prepared = prepareStagedLoad(project, plan, input);
  const result = await runStagedLoad(project, prepared);
  assert.equal(result.stopReason, "iteration-limit");
  assert.equal(result.started, 2);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.mainRequests, 4);
  assert.deepEqual(
    result.steps.map(({ stepId, count, failed }) => ({
      stepId,
      count,
      failed,
    })),
    [
      { stepId: "a", count: 2, failed: 0 },
      { stepId: "b", count: 2, failed: 0 },
    ],
  );
  for (const stats of result.steps) {
    assert.equal(stats.timingSamples, 2);
    assert.equal(stats.receivedBytes, 4);
    assert(stats.p50Ms >= 0 && stats.p99Ms >= stats.p50Ms);
  }
  assert.equal(seen.filter((x) => x === "/a").length, 2);
  assert.equal(seen.filter((x) => x === "/b").length, 2);
  assert.throws(
    () => prepareStagedLoad(project, plan, { ...input, maxIterations: 51 }),
    /100/,
  );
  assert.throws(() =>
    prepareStagedLoad(project, { steps: [{ type: "grpc" }] }, input),
  );
});

test("cancellation interrupts an admitted last iteration instead of being masked by the count limit", async (t) => {
  let begin, close;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const { project, url } = await fixture(t, (_req, res) => {
    begin();
    res.once("close", close);
  });
  const prepared = prepareStagedLoad(
    project,
    { steps: [{ id: "a", request: { url } }] },
    {
      initialVUs: 1,
      stages: [{ durationSeconds: 3, targetVUs: 1 }],
      maxIterations: 1,
    },
  );
  const controller = new AbortController();
  const pending = runStagedLoad(project, prepared, {
    signal: controller.signal,
  });
  await started;
  controller.abort();
  const result = await pending;
  await closed;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.started, 1);
});

test("overall deadline remains active after the iteration cap was reached", async (t) => {
  let begin, close;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const { project, url } = await fixture(t, (_req, res) => {
    begin();
    res.once("close", close);
  });
  const prepared = prepareStagedLoad(
    project,
    { steps: [{ id: "a", request: { url } }] },
    {
      initialVUs: 1,
      stages: [{ durationSeconds: 1, targetVUs: 1 }],
      maxIterations: 1,
    },
  );
  const pending = runStagedLoad(project, prepared);
  await started;
  const result = await pending;
  await closed;
  assert.equal(result.stopReason, "duration");
  assert.equal(result.cancelled, false);
});

test(
  "HTTP event stream runs a saved two-step plan and emits bounded progress and terminal events",
  { timeout: 10000 },
  async (t) => {
    const { createApp } = await import("../src/server.mjs");
    const { versionPlan } = await import("../src/plan-version.mjs");
    const seen = [];
    const peer = createServer((req, res) => {
      seen.push(req.url);
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "staged-http-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("staged");
    const base = `http://127.0.0.1:${peer.address().port}`;
    const plan = versionPlan(
      undefined,
      {
        id: "p1",
        name: "plan",
        steps: [
          { id: "a", request: { url: base + "/a" } },
          { id: "b", request: { url: base + "/b" } },
        ],
      },
      "manual",
      p,
    );
    p.plans.push(plan);
    await app.store.save(p);
    const before = await app.store.get(p.id);
    const response = await fetch(
      `${app.url}/api/projects/${p.id}/staged-load`,
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          planId: "p1",
          schedule: input,
          runId: "stream",
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = (await response.text())
      .trim()
      .split("\n\n")
      .map((event) => {
        const [name, data] = event.split("\n");
        return { name: name.slice(7), value: JSON.parse(data.slice(6)) };
      });
    assert.equal(events[0].name, "start");
    assert.equal(events.at(-2).name, "reportEnd");
    assert.equal(events.at(-1).name, "complete");
    assert.equal(events.at(-2).value.mainRequests, 4);
    assert.equal(events.at(-1).value.stopReason, "iteration-limit");
    assert.equal(seen.length, 4);
    assert.deepEqual(await app.store.get(p.id), before);
  },
);

test(
  "cancellation during cookie preflight produces a terminal event without sending a request",
  { timeout: 10000 },
  async (t) => {
    const { createApp } = await import("../src/server.mjs");
    const { versionPlan } = await import("../src/plan-version.mjs");
    const { ProjectCookieJar } = await import("../src/cookie-jar.mjs");
    let count = 0,
      begin,
      release;
    const entered = new Promise((resolve) => {
      begin = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const peer = createServer((_req, res) => {
      count++;
      res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "staged-cancel-preflight-"));
    const app = await createApp({ root, port: 0 });
    const original = ProjectCookieJar.prototype.inspect;
    t.after(async () => {
      ProjectCookieJar.prototype.inspect = original;
      release();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("staged");
    p.plans.push(
      versionPlan(
        undefined,
        {
          id: "p1",
          steps: [
            {
              id: "a",
              request: { url: `http://127.0.0.1:${peer.address().port}/` },
            },
          ],
        },
        "manual",
        p,
      ),
    );
    await app.store.save(p);
    ProjectCookieJar.prototype.inspect = async function () {
      begin();
      await gate;
      return original.call(this);
    };
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const pending = fetch(`${app.url}/api/projects/${p.id}/staged-load`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        planId: "p1",
        schedule: input,
        runId: "preflight",
      }),
    });
    await entered;
    const cancel = await fetch(`${app.url}/api/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "preflight" }),
    });
    assert.equal(cancel.status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: reportEnd\ndata: .*"stopReason":"cancelled"/);
    assert.match(body, /event: complete/);
    assert.equal(count, 0);
  },
);

test(
  "running VUs ramp down and back up without exceeding the configured limit",
  { timeout: 10000 },
  async (t) => {
    let inFlight = 0,
      peak = 0;
    const { project, url } = await fixture(t, (_req, res) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight--;
        res.end("ok");
      }, 250);
    });
    const prepared = prepareStagedLoad(
      project,
      { steps: [{ id: "a", request: { url } }] },
      {
        initialVUs: 2,
        stages: [
          { durationSeconds: 1, targetVUs: 0 },
          { durationSeconds: 1, targetVUs: 2 },
          { durationSeconds: 1, targetVUs: 2 },
        ],
        maxIterations: 50,
      },
    );
    const counts = [];
    const result = await runStagedLoad(project, prepared, {
      onProgress: (report) => counts.push(report.activeVUs),
    });
    assert.equal(result.stopReason, "duration");
    assert(counts.includes(0) && counts.includes(1) && counts.includes(2));
    assert(peak <= 2 && peak >= 2);
    assert.equal(result.runningIterations, 0);
  },
);

test(
  "explicit cancellation terminates an active SSE load and reports its cancelled outcome",
  { timeout: 10000 },
  async (t) => {
    const { createApp } = await import("../src/server.mjs");
    const { versionPlan } = await import("../src/plan-version.mjs");
    let begin, close;
    const started = new Promise((resolve) => {
      begin = resolve;
    });
    const closed = new Promise((resolve) => {
      close = resolve;
    });
    const peer = createServer((_req, res) => {
      begin();
      res.once("close", close);
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "staged-cancel-active-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("staged");
    p.plans.push(
      versionPlan(
        undefined,
        {
          id: "p1",
          steps: [
            {
              id: "a",
              request: { url: `http://127.0.0.1:${peer.address().port}/` },
            },
          ],
        },
        "manual",
        p,
      ),
    );
    await app.store.save(p);
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const response = await fetch(
      `${app.url}/api/projects/${p.id}/staged-load`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: "p1",
          schedule: {
            initialVUs: 1,
            stages: [{ durationSeconds: 5, targetVUs: 1 }],
            maxIterations: 2,
          },
          runId: "active",
        }),
      },
    );
    assert.equal(response.status, 200);
    await started;
    assert.equal(
      (
        await fetch(`${app.url}/api/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "active" }),
        })
      ).status,
      200,
    );
    const text = await response.text();
    await closed;
    assert.match(text, /event: reportEnd\ndata: .*"stopReason":"cancelled"/);
    assert.match(text, /event: complete\ndata: .*"stopReason":"cancelled"/);
  },
);

test("steps share variables within one iteration while concurrent iterations stay isolated", async (t) => {
  const tokens = [];
  const { project, url } = await fixture(t, (req, res) => {
    if (req.url === "/b") tokens.push(req.headers["x-sequence"]);
    res.end("ok");
  });
  const plan = {
    steps: [
      {
        id: "a",
        request: {
          url: url + "/a",
          beforeScript:
            "pm.environment.set('seq',(pm.environment.get('seq')||0)+1);",
        },
      },
      {
        id: "b",
        request: {
          url: url + "/b",
          headers: [{ key: "x-sequence", value: "{{seq}}" }],
        },
      },
    ],
  };
  const result = await runStagedLoad(
    project,
    prepareStagedLoad(project, plan, input),
  );
  assert.equal(result.failed, 0);
  assert.deepEqual(tokens, ["1", "1"]);
  assert.equal(project.environments[0].variables.seq, undefined);
});

test(
  "disconnecting the SSE client aborts in-flight work and releases its run ID",
  { timeout: 10000 },
  async (t) => {
    const { createApp } = await import("../src/server.mjs");
    const { versionPlan } = await import("../src/plan-version.mjs");
    let begin,
      close,
      calls = 0;
    const started = new Promise((resolve) => {
      begin = resolve;
    });
    const closed = new Promise((resolve) => {
      close = resolve;
    });
    const peer = createServer((req, res) => {
      calls++;
      if (req.url === "/hold") {
        begin();
        res.once("close", close);
      } else res.end("ok");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const root = await mkdtemp(join(tmpdir(), "staged-disconnect-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("staged");
    const base = `http://127.0.0.1:${peer.address().port}`;
    p.plans.push(
      versionPlan(
        undefined,
        { id: "hold", steps: [{ id: "a", request: { url: base + "/hold" } }] },
        "manual",
        p,
      ),
    );
    p.plans.push(
      versionPlan(
        undefined,
        { id: "ok", steps: [{ id: "a", request: { url: base + "/ok" } }] },
        "manual",
        p,
      ),
    );
    await app.store.save(p);
    const endpoint = `${app.url}/api/projects/${p.id}/staged-load`;
    const headers = {
      "x-local-token": app.token,
      "content-type": "application/json",
    };
    const schedule = {
      initialVUs: 1,
      stages: [{ durationSeconds: 5, targetVUs: 1 }],
      maxIterations: 2,
    };
    const controller = new AbortController();
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ planId: "hold", schedule, runId: "drop" }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    await started;
    controller.abort();
    await closed;
    const deadline = Date.now() + 3000;
    let again;
    do {
      again = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: "ok",
          schedule: { ...schedule, maxIterations: 1 },
          runId: "drop",
        }),
      });
      if (again.status === 200) break;
      assert(Date.now() < deadline, "run ID did not release after disconnect");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
    assert.match(await again.text(), /event: complete/);
    assert.equal(calls, 2);
  },
);

test(
  "long-running requests continue to produce periodic progress",
  { timeout: 10000 },
  async (t) => {
    const { project, url } = await fixture(t, (_req, res) => {
      res.on("close", () => {});
    });
    const prepared = prepareStagedLoad(
      project,
      { steps: [{ id: "a", request: { url } }] },
      {
        initialVUs: 1,
        stages: [{ durationSeconds: 5, targetVUs: 1 }],
        maxIterations: 2,
        reportIntervalSeconds: 1,
      },
    );
    const controller = new AbortController();
    let ticks = 0;
    const result = await runStagedLoad(project, prepared, {
      signal: controller.signal,
      onProgress: (report) => {
        if (
          report.elapsedMs > 500 &&
          report.runningIterations === 1 &&
          ++ticks === 2
        )
          controller.abort();
      },
    });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(ticks, 2);
  },
);
