import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runLoad } from "../src/load-runner.mjs";
import { prepareStagedLoad, runStagedLoad } from "../src/staged-load-plan.mjs";

const project = {
  environments: [{ id: "default", name: "Default", variables: {} }],
  settings: {},
};
const redirect = { mode: "same-origin", maxHops: 1 };
const stagedInput = (count, concurrency = 1) => ({
  initialVUs: concurrency,
  stages: [{ durationSeconds: 10, targetVUs: concurrency }],
  maxIterations: count,
});
function prepare(request, count, concurrency = 1) {
  return prepareStagedLoad(
    project,
    { id: "redirect-load", steps: [{ id: "http", request }] },
    stagedInput(count, concurrency),
  );
}
function run(kind, request, count = 1, options = {}) {
  const { concurrency = 1, ...rest } = options;
  return kind === "one-shot"
    ? runLoad(project, request, { count, concurrency, ...rest })
    : runStagedLoad(project, prepare(request, count, concurrency), rest);
}
function completed(result, kind, count) {
  if (kind === "one-shot") {
    assert.equal(result.count, count);
    assert.equal(result.passed, count, JSON.stringify(result));
  } else {
    assert.equal(result.started, count);
    assert.equal(result.completed, count);
    assert.equal(result.failed, 0, JSON.stringify(result));
  }
  assert.equal(result.mainRequests, count);
  assert.equal(result.cancelled, false);
}
async function fixture(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = {
      path: req.url,
      method: req.method,
      body: Buffer.concat(chunks).toString(),
      cookie: req.headers.cookie,
      contentType: req.headers["content-type"],
    };
    seen.push(entry);
    handler(req, res, entry, seen);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { seen, url: "http://127.0.0.1:" + server.address().port };
}

for (const kind of ["one-shot", "staged"]) {
  test(
    `${kind} redirect load rejects 51x2 before network and admits exactly 50x2 with one shared budget`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, (req, res) => {
        if (req.url === "/start") res.writeHead(302, { location: "/final" });
        res.end("ok");
      });
      const request = { url: f.url + "/start", redirect };
      if (kind === "one-shot")
        await assert.rejects(run(kind, request, 51), /100|预算|上限/);
      else assert.throws(() => prepare(request, 51), /100|预算|上限/);
      assert.equal(f.seen.length, 0);
      const result = await run(kind, request, 50, { concurrency: 5 });
      completed(result, kind, 50);
      assert.equal(f.seen.length, 100);
      assert.equal(f.seen.filter((r) => r.path === "/start").length, 50);
      assert.equal(f.seen.filter((r) => r.path === "/final").length, 50);
      assert.deepEqual(result.networkBudget, {
        limit: 100,
        reservations: 100,
        started: 100,
        redirectHops: 50,
      });
    },
  );

  test(`${kind} redirect load refuses cross-origin before any target hit`, async (t) => {
    const other = await fixture(t, (_req, res) => res.end("must not arrive"));
    const f = await fixture(t, (_req, res) => {
      res.writeHead(302, { location: other.url + "/forbidden" });
      res.end("blocked");
    });
    const result = await run(kind, { url: f.url, redirect });
    assert.equal(f.seen.length, 1);
    assert.equal(other.seen.length, 0);
    assertFailureSummary(result, kind, "origin");
    if (kind === "one-shot") assert.equal(result.passed, 0);
    else assert.equal(result.failed, 1);
    assert.deepEqual(result.networkBudget, {
      limit: 100,
      reservations: 1,
      started: 1,
      redirectHops: 0,
    });
  });

  test(`${kind} redirect load preserves the complete supported status/method matrix`, async (t) => {
    const f = await fixture(t, (req, res) => {
      if (req.url.startsWith("/start/"))
        res.writeHead(Number(req.url.split("/").at(-1)), {
          location: "/final",
        });
      res.end("ok");
    });
    for (const [status, method, nextMethod] of [
      [301, "POST", "GET"],
      [302, "POST", "GET"],
      [303, "POST", "GET"],
      [307, "POST", "POST"],
      [308, "POST", "POST"],
      [303, "HEAD", "HEAD"],
      [301, "PUT", "PUT"],
    ]) {
      f.seen.length = 0;
      const hasBody = method !== "HEAD";
      const dropped =
        status === 303 || (method === "POST" && [301, 302].includes(status));
      const result = await run(kind, {
        url: f.url + "/start/" + status,
        method,
        bodyType: hasBody ? "raw" : "none",
        body: hasBody ? "exact=payload&next=two" : "",
        headers: [{ key: "Content-Type", value: "text/plain" }],
        redirect,
      });
      completed(result, kind, 1);
      assert.equal(f.seen.length, 2);
      assert.equal(f.seen[0].method, method);
      assert.equal(f.seen[0].body, hasBody ? "exact=payload&next=two" : "");
      assert.equal(f.seen[1].path, "/final");
      assert.equal(f.seen[1].method, nextMethod);
      assert.equal(
        f.seen[1].body,
        hasBody && !dropped ? "exact=payload&next=two" : "",
      );
      assert.equal(f.seen[1].contentType, dropped ? undefined : "text/plain");
      assert.deepEqual(result.networkBudget, {
        limit: 100,
        reservations: 2,
        started: 2,
        redirectHops: 1,
      });
    }
  });

  test(
    `${kind} redirect load cancellation interrupts the second hop and starts no later iteration`,
    { timeout: 10000 },
    async (t) => {
      let entered;
      const secondHop = new Promise((resolve) => {
        entered = resolve;
      });
      const f = await fixture(t, (req, res) => {
        if (req.url === "/start") {
          res.writeHead(302, { location: "/slow" });
          res.end();
        } else entered();
      });
      const controller = new AbortController();
      const pending = run(kind, { url: f.url + "/start", redirect }, 3, {
        signal: controller.signal,
      });
      await secondHop;
      controller.abort();
      const result = await pending;
      assert.equal(result.cancelled, true);
      assert.equal(result.stopReason, "cancelled");
      assert.equal(result.mainRequests, 1);
      assert.deepEqual(
        f.seen.map((r) => r.path),
        ["/start", "/slow"],
      );
      assert.deepEqual(result.networkBudget, {
        limit: 100,
        reservations: 2,
        started: 2,
        redirectHops: 1,
      });
    },
  );

  test(`${kind} redirect load shares cookies only within an iteration and never mutates its seed`, async (t) => {
    let index = 0;
    const f = await fixture(t, (req, res) => {
      if (req.url === "/start") {
        const id = ++index;
        res.writeHead(302, {
          location: "/final/" + id,
          "set-cookie": "session=" + id + "; Path=/",
        });
      }
      res.end("ok");
    });
    const cookieState = { enabled: true, cookies: [] },
      seed = structuredClone(cookieState);
    const result = await run(kind, { url: f.url + "/start", redirect }, 3, {
      cookieState,
    });
    completed(result, kind, 3);
    assert.deepEqual(cookieState, seed);
    assert.equal(f.seen.length, 6);
    for (const row of f.seen) {
      assert.equal(
        row.cookie,
        row.path === "/start"
          ? undefined
          : "session=" + row.path.split("/").at(-1),
      );
    }
    assert.deepEqual(result.networkBudget, {
      limit: 100,
      reservations: 6,
      started: 6,
      redirectHops: 3,
    });
    f.seen.length = 0;
    const manual = await run(kind, {
      url: f.url + "/start",
      headers: [{ key: "Cookie", value: "manual=first" }],
      redirect,
    });
    completed(manual, kind, 1);
    assert.equal(f.seen[0].cookie, "manual=first");
    assert.equal(f.seen[1].cookie, undefined);
  });
}

for (const kind of ["one-shot", "staged"]) {
  test(`${kind} redirect load rejects script and native-task definitions before network or VM execution`, async (t) => {
    const f = await fixture(t, (_req, res) => res.end("must not arrive"));
    const patches = [
      { beforeScript: "throw Error('must not execute');" },
      { afterScript: "throw Error('must not execute');" },
      {
        sharedBeforeScripts: [
          { name: "shared", code: "throw Error('must not execute');" },
        ],
      },
      {
        sharedAfterScripts: [
          { name: "shared", code: "throw Error('must not execute');" },
        ],
      },
      {
        nativeTasks: {
          version: 1,
          before: [
            {
              type: "customScript",
              enabled: 1,
              data: "throw Error('must not execute');",
            },
          ],
          after: [],
        },
      },
      {
        nativeTasks: {
          version: 1,
          before: [],
          after: [{ type: "wait", enabled: 1, data: 0 }],
        },
      },
    ];
    for (const patch of patches) {
      const request = {
        url: f.url,
        redirect,
        ...(patch.nativeTasks ? { inheritSharedScripts: false } : {}),
        ...patch,
      };
      if (kind === "one-shot")
        await assert.rejects(
          run(kind, request),
          /重定向压测暂不支持脚本或前后置任务/,
        );
      else
        assert.throws(
          () => prepare(request, 1),
          /重定向压测暂不支持脚本或前后置任务/,
        );
      assert.equal(f.seen.length, 0);
    }
  });
}

function assertFailureSummary(result, kind, reason) {
  if (kind === "one-shot") {
    const failure = result.results[0].redirectFailure;
    assert.equal(failure.reason, reason);
    assert.equal(failure.retry_safe, false);
    assert.deepEqual(
      Object.keys(failure).sort(),
      [
        "code",
        "reason",
        "requestStarted",
        "responseComplete",
        "retry_safe",
      ].sort(),
    );
    assert.doesNotMatch(
      JSON.stringify(failure),
      /https?:|127\.0\.0\.1|\/start|\/slow/,
    );
  } else {
    assert.deepEqual(result.steps[0].redirectFailures, { [reason]: 1 });
    assert.doesNotMatch(
      JSON.stringify(result.steps[0].redirectFailures),
      /https?:|127\.0\.0\.1|\/start|\/slow/,
    );
  }
}
for (const kind of ["one-shot", "staged"]) {
  test(
    `${kind} redirect load timeout on an incomplete second response never starts its advertised next hop`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t, (req, res) => {
        if (req.url === "/start") {
          res.writeHead(302, { location: "/slow" });
          res.end();
        } else if (req.url === "/slow") {
          res.writeHead(302, { location: "/never" });
          res.write("incomplete");
        } else res.end("must not arrive");
      });
      const result = await run(kind, {
        url: f.url + "/start",
        redirect: { mode: "same-origin", maxHops: 2 },
        timeout: 150,
      });
      assert.equal(result.cancelled, false);
      assert.equal(result.mainRequests, 1);
      if (kind === "one-shot") assert.equal(result.passed, 0);
      else assert.equal(result.failed, 1);
      assert.deepEqual(
        f.seen.map((row) => row.path),
        ["/start", "/slow"],
      );
      assert.deepEqual(result.networkBudget, {
        limit: 100,
        reservations: 2,
        started: 2,
        redirectHops: 1,
      });
      assertFailureSummary(result, kind, "timeout");
    },
  );
}

test("staged mixed redirect and ordinary leaves count logical requests separately from shared network hops", async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/start") res.writeHead(302, { location: "/final" });
    res.end("ok");
  });
  const prepared = prepareStagedLoad(
    project,
    {
      steps: [
        { id: "redirect", request: { url: f.url + "/start", redirect } },
        { id: "ordinary", request: { url: f.url + "/ordinary" } },
      ],
    },
    stagedInput(3, 2),
  );
  const result = await runStagedLoad(project, prepared);
  assert.equal(result.started, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.mainRequests, 6);
  assert.deepEqual(result.networkBudget, {
    limit: 100,
    reservations: 9,
    started: 9,
    redirectHops: 3,
  });
  assert.equal(f.seen.length, 9);
  for (const pathname of ["/start", "/final", "/ordinary"])
    assert.equal(f.seen.filter((row) => row.path === pathname).length, 3);
  assert.deepEqual(
    result.steps.map(({ stepId, count, failed, redirectFailures }) => ({
      stepId,
      count,
      failed,
      redirectFailures,
    })),
    [
      { stepId: "redirect", count: 3, failed: 0, redirectFailures: {} },
      { stepId: "ordinary", count: 3, failed: 0, redirectFailures: {} },
    ],
  );
});

test(
  "staged progress reports share a monotonic network budget across a VU stage transition",
  { timeout: 10000 },
  async (t) => {
    const timers = new Set();
    t.after(() => {
      for (const timer of timers) clearTimeout(timer);
    });
    const f = await fixture(t, (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
      } else {
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.end("ok");
        }, 250);
        timers.add(timer);
      }
    });
    const prepared = prepareStagedLoad(
      project,
      { steps: [{ id: "http", request: { url: f.url + "/start", redirect } }] },
      {
        initialVUs: 1,
        stages: [
          { durationSeconds: 1, targetVUs: 2 },
          { durationSeconds: 3, targetVUs: 2 },
        ],
        maxIterations: 12,
        reportIntervalSeconds: 1,
      },
    );
    const reports = [];
    const result = await runStagedLoad(project, prepared, {
      onProgress: (report) => {
        reports.push(structuredClone(report));
      },
    });
    completed(result, "staged", 12);
    assert.equal(f.seen.length, 24);
    assert.deepEqual(result.networkBudget, {
      limit: 100,
      reservations: 24,
      started: 24,
      redirectHops: 12,
    });
    assert(
      reports.some(
        (report) => report.elapsedMs < 1000 && report.networkBudget.started > 0,
      ),
      "report must observe work in the initial stage",
    );
    assert(
      reports.some(
        (report) => report.elapsedMs >= 1000 && report.activeVUs >= 2,
      ),
      "report must observe the second stage",
    );
    const all = [...reports, result];
    for (let index = 0; index < all.length; index++) {
      const budget = all[index].networkBudget;
      assert.equal(budget.limit, 100);
      for (const key of ["reservations", "started", "redirectHops"]) {
        assert(
          budget[key] >= (all[index - 1]?.networkBudget[key] ?? 0),
          `${key} must not reset across stages`,
        );
        assert(budget[key] <= result.networkBudget[key]);
      }
      for (const step of all[index].steps)
        assert.deepEqual(step.redirectFailures, {});
    }
  },
);
