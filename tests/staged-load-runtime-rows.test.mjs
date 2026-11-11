import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/runtime.mjs";
import { prepareStagedLoad, runStagedLoad } from "../src/staged-load-plan.mjs";

const schedule = {
  initialVUs: 2,
  stages: [{ durationSeconds: 5, targetVUs: 2 }],
  maxIterations: 2,
};
const rows = (request, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps: [{ id: "body", request }],
  ...extra,
});
const producer = (url) => ({
  id: "producer",
  request: {
    url: url + "/producer",
    beforeScript: "pm.environment.set('outer',pm.info.iteration);",
    headers: [{ key: "x-iteration", value: "{{outer}}", enabled: true }],
    extract: [{ name: "items", source: "json", path: "$.items" }],
  },
});
async function fixture(t, handler) {
  const peer = createServer(handler);
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(join(tmpdir(), "staged-runtime-rows-"));
  const store = new Store(root);
  await store.init();
  const project = await store.create("rows");
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((r) => peer.close(r));
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    root,
    project,
    url: `http://127.0.0.1:${peer.address().port}`,
  };
}

test("two VUs freeze distinct rows, isolate cookies/scopes, restore outer iteration, and do not persist", async (t) => {
  const seen = [],
    pending = [];
  const { project, store, url } = await fixture(t, (req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie });
    if (req.url === "/producer") {
      assert.equal(req.headers.cookie, undefined);
      const n = req.headers["x-iteration"];
      pending.push(() => {
        res.setHeader("Set-Cookie", `vu=${n}; Path=/`);
        res.end(JSON.stringify({ items: [{ name: `private-${n}` }] }));
      });
      if (pending.length === 2) pending.reverse().forEach((reply) => reply());
    } else res.end(JSON.stringify({ items: [{ name: "changed" }] }));
  });
  const plan = {
    steps: [
      producer(url),
      rows({
        url: url + "/{{name}}/{{index}}/{{count}}",
        beforeScript:
          "pm.environment.set('name',pm.iterationData.get('name'));pm.environment.set('index',pm.info.iteration);pm.environment.set('count',pm.info.iterationCount);",
        // A producer overwrite must not alter the already frozen frame.
        extract: [{ name: "items", source: "json", path: "$.items" }],
      }),
      {
        id: "tail",
        request: {
          url: url + "/tail/{{index}}/{{count}}",
          beforeScript:
            "pm.environment.set('index',pm.info.iteration);pm.environment.set('count',pm.info.iterationCount);",
        },
      },
    ],
  };
  const before = await store.get(project.id);
  const progress = [];
  const prepared = prepareStagedLoad(project, plan, schedule);
  const result = await runStagedLoad(project, prepared, {
    cookieState: { enabled: true, cookies: [] },
    onProgress: (p) => progress.push(p),
  });
  assert.equal(result.mainRequests, 6);
  assert.equal(result.failed, 0);
  assert.equal(result.iterationOutcomes.passed, 2);
  for (const n of [0, 1]) {
    assert(
      seen.some(
        (s) => s.path === `/private-${n}/0/1` && s.cookie === `vu=${n}`,
      ),
      JSON.stringify(seen),
    );
    assert(
      seen.some((s) => s.path === `/tail/${n}/2` && s.cookie === `vu=${n}`),
      JSON.stringify(seen),
    );
  }
  assert.equal(seen.filter((s) => s.path === "/producer").length, 2);
  assert.deepEqual(await store.get(project.id), before);
  assert.equal(JSON.stringify([progress, result]).includes("private-"), false);
  assert.equal(JSON.stringify([progress, result]).includes(url), false);
});

for (const [label, value, expected] of [
  ["empty", [], "passed"],
  ["invalid later row", [{ name: "secret" }, null], "runtimeRowsInvalid"],
  ["over maxRows", [{}, {}, {}, {}], "runtimeRowsInvalid"],
  ["not array", "private-error-value", "runtimeRowsInvalid"],
])
  test(`runtime source ${label} preserves producer counts without replay or partial body`, async (t) => {
    const seen = [];
    const { project, url } = await fixture(t, (req, res) => {
      seen.push(req.url);
      res.end(JSON.stringify({ items: value }));
    });
    const plan = {
      steps: [
        producer(url),
        rows({ url: url + "/body" }),
        { id: "tail", request: { url: url + "/tail" } },
      ],
    };
    const result = await runStagedLoad(
      project,
      prepareStagedLoad(project, plan, {
        ...schedule,
        initialVUs: 1,
        maxIterations: 1,
      }),
    );
    assert.deepEqual(
      seen,
      expected === "passed" ? ["/producer", "/tail"] : ["/producer"],
    );
    assertOutcomeAccounting(result);
    assert.equal(result.iterationOutcomes[expected], 1);
    assert.equal(result.steps.find((s) => s.stepId === "producer").count, 1);
    assert.equal(result.steps.find((s) => s.stepId === "body").count, 0);
    assert.equal(result.mainRequests, seen.length);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("private-error-value"), false);
  });

test("missing runtime source fails without interpreting environment data as rows", async (t) => {
  const { project, url } = await fixture(t, () =>
    assert.fail("transport must not run"),
  );
  project.environments[0].variables = { items: [{ name: "environment-only" }] };
  const result = await runStagedLoad(
    project,
    prepareStagedLoad(
      project,
      { steps: [rows({ url })] },
      { ...schedule, maxIterations: 1 },
    ),
  );
  assert.equal(result.mainRequests, 0);
  assert.equal(result.iterationOutcomes.runtimeRowsInvalid, 1);
});

test("prepare and direct run enforce worst-case budgets, model validity, frozen references and HTTP-only requirements", async (t) => {
  const { project, url } = await fixture(t, () =>
    assert.fail("admission invoked transport"),
  );
  const plan = { steps: [producer(url), rows({ url }, { maxRows: 9 })] };
  const prepared = prepareStagedLoad(project, plan, {
    ...schedule,
    maxIterations: 10,
  });
  assert.throws(
    () => prepareStagedLoad(project, plan, { ...schedule, maxIterations: 11 }),
    /100/,
  );
  assert.throws(
    () =>
      prepareStagedLoad(
        project,
        { steps: [producer(url), rows({ url }, { maxRows: 10 })] },
        schedule,
      ),
    /10/,
  );
  for (const mutate of [
    (p) => {
      p.snapshot.steps[1].maxRows = 10;
    },
    (p) => {
      p.schedule.maxIterations = 11;
    },
    (p) => {
      p.schedule.durationMs = Infinity;
    },
    (p) => {
      p.snapshot.steps[1].maxRows = 0;
    },
    (p) => {
      p.snapshot.steps[1].steps[0].liveRequestId = "not-frozen";
    },
    (p) => {
      p.snapshot.steps[1].steps[0].request.before = [
        { type: "database", connectionId: "db", query: "SELECT 1" },
      ];
    },
    (p) => {
      p.snapshot.steps[1].steps[0].request.redirect = { enabled: true };
    },
  ]) {
    const forged = structuredClone(prepared);
    mutate(forged);
    const noRead = new Proxy(
      {},
      {
        get() {
          assert.fail("read project before static admission");
        },
      },
    );
    await assert.rejects(runStagedLoad(noRead, forged));
  }
  // Runtime-row byte/expansion budgets remain independent of the HTTP cap.
  assert.throws(
    () =>
      prepareStagedLoad(
        project,
        { steps: [rows({ url }, { maxRows: 8, maxRowBytes: 512 * 1024 })] },
        { ...schedule, maxIterations: 1 },
      ),
    /4MiB/,
  );
  assert.throws(
    () =>
      prepareStagedLoad(
        project,
        {
          steps: [
            producer(url),
            rows(
              { url },
              { enabled: false, maxRows: 10, maxRowBytes: 512 * 1024 },
            ),
          ],
        },
        { ...schedule, maxIterations: 1 },
      ),
    /4MiB/,
  );
  // False conditions cannot shrink maxRows admission.
  assert.throws(
    () =>
      prepareStagedLoad(
        project,
        {
          steps: [
            producer(url),
            {
              id: "if",
              type: "if",
              condition: {
                op: "eq",
                left: { literal: 0 },
                right: { literal: 1 },
              },
              steps: [rows({ url }, { maxRows: 10 })],
            },
          ],
        },
        schedule,
      ),
    /10/,
  );
});

test("cancellation during a row preserves producer completion and prevents tail/replacement iterations", async (t) => {
  let entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    if (req.url === "/producer") res.end(JSON.stringify({ items: [{}, {}] }));
    else entered();
  });
  const controller = new AbortController();
  const pending = runStagedLoad(
    project,
    prepareStagedLoad(
      project,
      {
        steps: [
          producer(url),
          rows({ url: url + "/body" }),
          { id: "tail", request: { url: url + "/tail" } },
        ],
      },
      { ...schedule, initialVUs: 1 },
    ),
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  const result = await pending;
  assertOutcomeAccounting(result);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.started, 1);
  assert.equal(result.iterationOutcomes.cancelled, 1);
  assert.deepEqual(seen, ["/producer", "/body"]);
  assert.equal(result.steps.find((s) => s.stepId === "producer").count, 1);
  assert.equal(result.steps.find((s) => s.stepId === "tail").count, 0);
});

test("staged SSE freezes live runtime-row references once and reports transient sanitized outcomes", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "staged-live-runtime-rows-"));
  const app = await createApp({ root, port: 0 });
  const project = await app.store.create("live rows");
  const seen = [];
  let changed = false,
    expectedStored;
  const peer = createServer(async (req, res) => {
    seen.push(req.url);
    if (!changed) {
      changed = true;
      const current = await app.store.get(project.id);
      current.requests[0].url = base + "/changed";
      await app.store.save(current);
      expectedStored = await app.store.get(project.id);
    }
    res.end(JSON.stringify({ items: [{ name: "private-row" }] }));
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${peer.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => peer.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  project.requests = [{ id: "live", url: base + "/frozen/{{name}}" }];
  await app.store.save(project);
  const call = (route, body) =>
    fetch(`${app.url}/api/projects/${project.id}/${route}`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const group = rows({
    url: base + "/stale",
    beforeScript: "pm.environment.set('name',pm.iterationData.get('name'));",
  });
  group.steps[0].liveRequestId = "live";
  const created = await call("plans", {
    name: "live",
    steps: [producer(base), group],
  });
  assert.equal(created.status, 200);
  const plan = await created.json();
  const before = await app.store.get(project.id);
  const response = await call("staged-load", {
    planId: plan.id,
    schedule: { ...schedule, initialVUs: 1 },
    runId: "staged-rows",
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text
    .trim()
    .split("\n\n")
    .map((chunk) => {
      const [name, data] = chunk.split("\n");
      return { name: name.slice(7), data: JSON.parse(data.slice(6)) };
    });
  assert.equal(events[0].name, "start");
  assert.equal(events.at(-2).name, "reportEnd");
  assert.equal(events.at(-1).name, "complete");
  const result = events.at(-2).data;
  assert.equal(result.mainRequests, 4);
  assert.equal(result.iterationOutcomes.passed, 2);
  assert.deepEqual(seen, [
    "/producer",
    "/frozen/private-row",
    "/producer",
    "/frozen/private-row",
  ]);
  for (const secret of [
    "private-row",
    base,
    "rowsFrom",
    "variables",
    "response",
    "recordSaved",
  ])
    assert.equal(text.includes(secret), false);
  const after = await app.store.get(project.id);
  // Only our concurrent request edit persists. Staged execution remains transient.
  assert.deepEqual(after, expectedStored);
  assert.deepEqual(after.runs, before.runs);
});

test("observers cannot mutate the admitted snapshot, schedule, or retained outcome counters", async (t) => {
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    res.end(JSON.stringify({ items: [{}] }));
  });
  const prepared = prepareStagedLoad(
    project,
    { steps: [producer(url), rows({ url: url + "/body" })] },
    { ...schedule, initialVUs: 1 },
  );
  const result = await runStagedLoad(project, prepared, {
    onProgress(report) {
      prepared.schedule.maxIterations = 100;
      prepared.snapshot.steps[1].steps[0].request.url = url + "/unexpected";
      report.iterationOutcomes.passed = 999;
      report.steps[0].count = 999;
    },
  });
  assert.equal(result.started, 2);
  assert.equal(result.iterationOutcomes.passed, 2);
  assert.equal(result.steps[0].count, 2);
  assert.deepEqual(seen, ["/producer", "/body", "/producer", "/body"]);
});

test("row conditions skip only the current row and restore the tail context", async (t) => {
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    res.end(
      JSON.stringify({
        items: [{ enabled: true }, { enabled: false }, { enabled: true }],
      }),
    );
  });
  const info =
    "pm.environment.set('index',pm.info.iteration);pm.environment.set('count',pm.info.iterationCount);";
  const group = rows({});
  group.steps = [
    {
      id: "if",
      type: "if",
      condition: {
        op: "eq",
        left: { scope: "iterationData", name: "enabled" },
        right: { literal: true },
      },
      steps: [
        {
          id: "body",
          request: {
            url: url + "/body/{{index}}/{{count}}",
            beforeScript: info,
          },
        },
      ],
    },
  ];
  const result = await runStagedLoad(
    project,
    prepareStagedLoad(
      project,
      {
        steps: [
          producer(url),
          group,
          {
            id: "tail",
            request: {
              url: url + "/tail/{{index}}/{{count}}",
              beforeScript: info,
            },
          },
        ],
      },
      { ...schedule, initialVUs: 1, maxIterations: 1 },
    ),
  );
  assert.equal(result.failed, 0);
  assert.deepEqual(seen, ["/producer", "/body/0/3", "/body/2/3", "/tail/0/1"]);
});

test("deadline cooperatively aborts active row after the iteration limit is reached", async (t) => {
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    if (req.url === "/producer") res.end(JSON.stringify({ items: [{}, {}] }));
  });
  const result = await runStagedLoad(
    project,
    prepareStagedLoad(
      project,
      { steps: [producer(url), rows({ url: url + "/body" })] },
      {
        initialVUs: 1,
        stages: [{ durationSeconds: 1, targetVUs: 1 }],
        maxIterations: 1,
      },
    ),
  );
  assertOutcomeAccounting(result);
  assert.equal(result.stopReason, "duration");
  assert.equal(result.iterationOutcomes.cancelled, 1);
  assert.equal(result.steps[0].count, 1);
  assert.deepEqual(seen, ["/producer", "/body"]);
});

test("staged runtime opt-in preserves legacy linear metadata admission", async (t) => {
  const { project, url } = await fixture(t, (_req, res) => res.end("ok"));
  let deep = { type: "string" };
  for (let i = 0; i < 34; i++) deep = { properties: { child: deep } };
  for (const metadata of [deep, new Date("2026-01-01"), NaN]) {
    const prepared = prepareStagedLoad(
      project,
      { steps: [{ id: "leaf", request: { url, unusedMetadata: metadata } }] },
      { ...schedule, maxIterations: 1 },
    );
    const result = await runStagedLoad(project, prepared);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(Object.hasOwn(result, "iterationOutcomes"), false);
  }
});

test("legacy plans retain runner-time database failure while active rows reject before producers", async (t) => {
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    res.end("{}");
  });
  const request = {
    url: url + "/database",
    before: [
      {
        type: "database",
        connectionId: "db",
        query: "SELECT 1",
        name: "items",
      },
    ],
  };
  const legacy = {
    steps: [
      { id: "producer", request: { url: url + "/producer" } },
      { id: "db", request },
    ],
  };
  const prepared = prepareStagedLoad(project, legacy, {
    ...schedule,
    maxIterations: 1,
  });
  const result = await runStagedLoad(project, prepared);
  assert.equal(result.failed, 1);
  assert.equal(result.steps[0].count, 1);
  assert.deepEqual(seen, ["/producer"]);
  assert.throws(
    () =>
      prepareStagedLoad(
        project,
        { steps: [producer(url), rows(request)] },
        schedule,
      ),
    /数据库/,
  );
});

function assertOutcomeAccounting(report) {
  assert.deepEqual(Object.keys(report.iterationOutcomes).sort(), [
    "cancelled",
    "executionError",
    "failed",
    "passed",
    "runtimeRowsInvalid",
  ]);
  assert.equal(
    Object.values(report.iterationOutcomes).reduce(
      (sum, count) => sum + count,
      0,
    ),
    report.completed,
  );
  // The historical `failed` aggregate includes every non-passed iteration,
  // including cooperative cancellation. Outcome classes are mutually exclusive.
  assert.equal(
    report.iterationOutcomes.passed,
    report.completed - report.failed,
  );
  for (const count of Object.values(report.iterationOutcomes)) {
    assert(Number.isInteger(count) && count >= 0 && count <= report.completed);
  }
}

test("HTTP assertion and script failures use the bounded failed outcome with consistent accounting", async (t) => {
  const seen = [];
  const { project, url } = await fixture(t, (req, res) => {
    seen.push(req.url);
    res.end(JSON.stringify({ items: [{}] }));
  });
  for (const extra of [
    { assertions: [{ target: "status", op: "eq", value: 201 }] },
    { beforeScript: "throw new Error('private-script-error');" },
  ]) {
    const prepared = prepareStagedLoad(
      project,
      { steps: [producer(url), rows({ url: url + "/body", ...extra })] },
      schedule,
    );
    const result = await runStagedLoad(project, prepared, {
      onProgress: assertOutcomeAccounting,
    });
    assertOutcomeAccounting(result);
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 2);
    assert.equal(result.iterationOutcomes.failed, 2);
    assert.equal(result.iterationOutcomes.executionError, 0);
    assert.equal(result.steps[0].count, 2);
    assert.equal(
      JSON.stringify(result).includes("private-script-error"),
      false,
    );
  }
  assert.equal(seen.filter((path) => path === "/producer").length, 4);
  assert.equal(seen.filter((path) => path === "/body").length, 2);
});

test("core input rejection after staged admission uses executionError without transport or error details", async (t) => {
  const { project, url } = await fixture(t, () =>
    assert.fail("core rejected before transport"),
  );
  const prepared = prepareStagedLoad(
    project,
    { steps: [producer(url), rows({ url })] },
    schedule,
  );
  // Static admission intentionally does not inspect variables. Core validates
  // the invocation's condition/runtime input after each iteration is admitted.
  const result = await runStagedLoad(project, prepared, {
    variables: { privateInvalidNumber: NaN },
    onProgress: assertOutcomeAccounting,
  });
  assertOutcomeAccounting(result);
  assert.equal(result.started, 2);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.iterationOutcomes.executionError, 2);
  assert.equal(result.iterationOutcomes.failed, 0);
  assert.equal(result.mainRequests, 0);
  assert(result.steps.every((step) => step.count === 0));
  assert.equal(JSON.stringify(result).includes("privateInvalidNumber"), false);
});

test("direct prepared schedule rejects changing getters and Proxy containers without invoking hooks", async (t) => {
  const { project, url } = await fixture(t, () =>
    assert.fail("invalid schedule invoked transport"),
  );
  const prepared = prepareStagedLoad(
    project,
    { steps: [producer(url), rows({ url })] },
    schedule,
  );
  let calls = 0;
  const trap = () => {
    calls++;
    return calls === 1 ? 2 : 1000;
  };
  const proxy = (value) =>
    new Proxy(value, {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
  for (const mutate of [
    (value) => proxy(value),
    (value) => {
      Object.defineProperty(value, "maxIterations", {
        enumerable: true,
        get: trap,
      });
      return value;
    },
    (value) => {
      Object.defineProperty(value, "durationMs", {
        enumerable: true,
        get: trap,
      });
      return value;
    },
    (value) => {
      value.changes = proxy([]);
      return value;
    },
    (value) => {
      value.changes = [proxy({ atMs: 100, vus: 2 })];
      return value;
    },
    (value) => {
      value.changes = [{ atMs: 100, vus: 2 }];
      Object.defineProperty(value.changes, "0", {
        enumerable: true,
        get: trap,
      });
      return value;
    },
    (value) => {
      const change = { atMs: 100, vus: 2 };
      Object.defineProperty(change, "vus", { enumerable: true, get: trap });
      value.changes = [change];
      return value;
    },
    (value) => {
      Object.setPrototypeOf(value, {
        get initialVUs() {
          return trap();
        },
      });
      return value;
    },
    (value) => {
      value.changes = new Array(1);
      return value;
    },
  ]) {
    const forged = {
      ...prepared,
      schedule: mutate(structuredClone(prepared.schedule)),
    };
    await assert.rejects(runStagedLoad(project, forged), /调度/);
    assert.equal(calls, 0);
  }
});

test("prepared schedule copies retain legal limits and reject numerical boundary violations", async (t) => {
  const { project, url } = await fixture(t, () =>
    assert.fail("cancelled or invalid schedule invoked transport"),
  );
  const prepared = prepareStagedLoad(
    project,
    { steps: [{ id: "http", request: { url } }] },
    {
      initialVUs: 10,
      maxIterations: 100,
      reportIntervalSeconds: 10,
      stages: [{ durationSeconds: 60, targetVUs: 0 }],
    },
  );
  const signal = AbortSignal.abort();
  const result = await runStagedLoad(project, prepared, { signal });
  assert.equal(result.stopReason, "cancelled");
  assert.equal(Object.hasOwn(result, "iterationOutcomes"), false);
  // Also accept ordinary all-zero-change schedules and null-prototype records.
  const simple = prepareStagedLoad(
    project,
    { steps: [{ id: "http", request: { url } }] },
    {
      initialVUs: 1,
      maxIterations: 1,
      stages: [{ durationSeconds: 1, targetVUs: 1 }],
    },
  );
  Object.setPrototypeOf(simple.schedule, null);
  assert.equal(
    (await runStagedLoad(project, simple, { signal })).stopReason,
    "cancelled",
  );
  for (const [key, value] of [
    ["initialVUs", 11],
    ["maxIterations", 101],
    ["maxIterations", 0],
    ["reportIntervalSeconds", 11],
    ["durationMs", 60001],
    ["durationMs", 999],
  ]) {
    const invalid = structuredClone(prepared);
    invalid.schedule[key] = value;
    await assert.rejects(runStagedLoad(project, invalid, { signal }), /调度/);
  }
  for (const changes of [
    [{ atMs: 60001, vus: 1 }],
    [{ atMs: -1, vus: 1 }],
    [{ atMs: 1, vus: 11 }],
    [
      { atMs: 2, vus: 1 },
      { atMs: 1, vus: 2 },
    ],
    Array.from({ length: 101 }, () => ({ atMs: 1, vus: 1 })),
  ]) {
    const invalid = structuredClone(prepared);
    invalid.schedule.changes = changes;
    await assert.rejects(runStagedLoad(project, invalid, { signal }), /调度/);
  }
});

test("legacy and disabled-runtime-row plans add only versioned report metadata", async (t) => {
  const { project, url } = await fixture(t, (_req, res) => res.end("ok"));
  for (const extra of [
    [],
    [rows({ url }, { enabled: false })],
    [
      {
        id: "fixed",
        type: "repeat",
        count: 1,
        steps: [{ id: "fixed-http", request: { url } }],
      },
    ],
  ]) {
    const prepared = prepareStagedLoad(
      project,
      { steps: [{ id: "http", request: { url } }, ...extra] },
      { ...schedule, maxIterations: 1 },
    );
    const reports = [];
    const result = await runStagedLoad(project, prepared, {
      onProgress: (report) => reports.push(report),
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(Object.hasOwn(result, "iterationOutcomes"), false);
    assert(reports.length > 0);
    for (const report of reports) {
      assert.equal(Object.hasOwn(report, "iterationOutcomes"), false);
      assert.deepEqual(report.reportSemantics, {
        version: 1,
        statusPolicy: "plan",
      });
      assert.deepEqual(report.failureCounts, {
        "http-status-policy": 0,
        assertion: 0,
        execution: 0,
        cancelled: 0,
        redirect: 0,
      });
      assert.deepEqual(
        Object.keys(report).sort(),
        [
          "reportSemantics",
          "failureCounts",
          "elapsedMs",
          "activeVUs",
          "runningIterations",
          "started",
          "completed",
          "failed",
          "mainRequests",
          "stepCompletionsPerSecond",
          "iterationsCompletedPerSecond",
          "steps",
        ].sort(),
      );
    }
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        ...Object.keys(reports[0]),
        "stopReason",
        "cancelled",
        "variableIsolation",
      ].sort(),
    );
  }
});
