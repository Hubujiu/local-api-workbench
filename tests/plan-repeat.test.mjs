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
