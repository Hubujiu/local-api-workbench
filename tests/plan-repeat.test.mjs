import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";

async function fixture(t) {
  const seen = [];
  let serial = 0;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers["x-token"] });
    if (req.url === "/failure") res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: `token-${++serial}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}
const leaf = (id, url, extract = []) => ({
  id,
  request: {
    method: "GET",
    url,
    headers: [{ key: "x-token", value: "{{token}}" }],
    extract,
  },
});
const token = { name: "token", source: "json", path: "$.token" };

test("saved repeat intent executes login, ordered shared-scope iterations and trailing HTTP with stable identities", async (t) => {
  const f = await fixture(t);
  const plan = snapshotPlan({
    name: "login and repeat",
    steps: [
      leaf("login", f.url + "/login", [token]),
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: [
          leaf("refresh", f.url + "/refresh", [token]),
          leaf("consume", f.url + "/consume"),
        ],
      },
      leaf("after", f.url + "/after"),
    ],
  });
  const frozen = structuredClone(plan);
  assert.equal(plan.steps[1].type, "repeat");
  const run = await runPlan(plan, { token: "initial" }, executeRequest);
  assert.equal(run.status, "passed");
  assert.deepEqual(f.seen, [
    { url: "/login", token: "initial" },
    { url: "/refresh", token: "token-1" },
    { url: "/consume", token: "token-2" },
    { url: "/refresh", token: "token-2" },
    { url: "/consume", token: "token-4" },
    { url: "/after", token: "token-4" },
  ]);
  assert.deepEqual(run.snapshot, frozen);
  assert.deepEqual(plan, frozen);
  assert.deepEqual(
    run.results
      .slice(1, 5)
      .map((r) => [
        r.stepId,
        r.repeat.groupId,
        r.repeat.childId,
        r.repeat.iteration,
      ]),
    [
      ["refresh", "group", "refresh", 0],
      ["consume", "group", "consume", 0],
      ["refresh", "group", "refresh", 1],
      ["consume", "group", "consume", 1],
    ],
  );
  assert.equal(
    new Set(run.results.slice(1, 5).map((r) => r.repeat.occurrenceId)).size,
    4,
  );
});

test("repeat graph is completely preflighted before any earlier HTTP, including disabled nodes", async (t) => {
  const f = await fixture(t);
  for (const count of [0, -1, 1.5, "2", 101]) {
    const input = {
      steps: [
        leaf("first", f.url),
        {
          type: "repeat",
          id: "bad",
          enabled: false,
          count,
          steps: [leaf("child", f.url)],
        },
      ],
    };
    assert.throws(() => snapshotPlan(input), /循环|重复|repeat/i);
    await assert.rejects(
      runPlan(input, {}, executeRequest),
      /循环|重复|repeat/i,
    );
  }
  assert.deepEqual(f.seen, []);
});

test("repeat graph identity, shape and potential-work caps reject atomically while disabled valid leaves remain inert", async (t) => {
  const f = await fixture(t);
  const source = () => ({
    steps: [
      leaf("first", f.url),
      {
        type: "repeat",
        id: "group",
        enabled: false,
        count: 2,
        steps: [leaf("child", f.url)],
      },
    ],
  });
  const changes = [
    (p) => {
      p.steps[1].steps = [];
    },
    (p) => {
      p.steps[1].steps[0].id = "first";
    },
    (p) => {
      p.steps[1].id = "child";
    },
    (p) => {
      p.steps[1].steps[0].type = "grpc";
    },
    (p) => {
      p.steps[1].steps[0].type = "repeat";
    },
    (p) => {
      p.steps[1].steps[0].request = null;
    },
    (p) => {
      p.steps[1].steps[0].request.url = "";
    },
    (p) => {
      p.steps[1].count = 100;
      p.steps[1].steps.push(leaf("second-child", f.url));
    },
    (p) => {
      p.steps[1].unknown = "ignored";
    },
    (p) => {
      p.steps[1].steps[0].extra = "ignored";
    },
    (p) => {
      p.steps[1].enabled = 0;
    },
  ];
  for (const mutate of changes) {
    const input = source();
    mutate(input);
    assert.throws(() => snapshotPlan(input), /循环/);
    await assert.rejects(runPlan(input, {}, executeRequest), /循环/);
  }
  assert.equal(f.seen.length, 0);
  const amplified = source();
  amplified.steps[1].count = 100;
  amplified.steps[1].steps[0].request.bodyType = "raw";
  amplified.steps[1].steps[0].request.body = "x".repeat(50 * 1024);
  assert.throws(() => snapshotPlan(amplified), /逻辑展开配置最多4MiB/);
  await assert.rejects(
    runPlan(amplified, {}, executeRequest),
    /逻辑展开配置最多4MiB/,
  );
  assert.equal(f.seen.length, 0);
  const cap = source();
  cap.steps.shift();
  cap.steps[0].count = 100;
  cap.steps[0].steps.push(leaf("second-child", f.url));
  assert.equal(snapshotPlan(cap).steps[0].count, 100);
  const plan = snapshotPlan(source());
  const run = await runPlan(plan, { token: "original" }, executeRequest);
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((r) => r.stepId),
    ["first"],
  );
  assert.equal(run.results[0].repeat, undefined);
  assert.equal(f.seen.length, 1);
});

test("ordinary failures continue across iterations without partial extraction, and cancellation starts no later occurrence", async (t) => {
  const f = await fixture(t);
  const plan = snapshotPlan({
    steps: [
      {
        type: "repeat",
        id: "group",
        count: 2,
        steps: [
          leaf("failed", f.url + "/failure", [
            token,
            { ...token, name: "missing", path: "$.absent" },
          ]),
          leaf("consumer", f.url + "/consume"),
        ],
      },
      leaf("after", f.url + "/after"),
    ],
  });
  const run = await runPlan(plan, { token: "old" }, executeRequest);
  assert.equal(run.status, "failed");
  assert.equal(run.results.length, 5);
  assert.deepEqual(
    run.results.map((r) => r.status),
    ["failed", "passed", "failed", "passed", "passed"],
  );
  assert.deepEqual(run.results[0].extracted, {});
  assert.deepEqual(run.results[2].extracted, {});
  assert.equal(run.results[0].response.status, 500);
  assert.ok(f.seen.every((r) => r.token === "old"));
  const controller = new AbortController();
  f.seen.length = 0;
  const cancelled = await runPlan(plan, { token: "old" }, executeRequest, {
    signal: controller.signal,
    onStep: () => controller.abort(),
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.results.length, 1);
  assert.equal(f.seen.length, 1);
  const before = f.seen.length;
  const preaborted = await runPlan(plan, {}, executeRequest, {
    signal: controller.signal,
  });
  assert.equal(preaborted.status, "cancelled");
  assert.equal(preaborted.results.length, 0);
  assert.equal(f.seen.length, before);
});
