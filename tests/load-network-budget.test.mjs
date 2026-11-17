import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createLoadNetworkBudget,
  loadNetworkBudget,
  isLoadNetworkBudgetFailure,
} from "../src/load-network-budget.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { readHttpRedirectFailure } from "../src/http-redirect.mjs";

test("shared capability never refunds reservations; untrusted JSON is not authority", () => {
  let stopped = 0;
  const b = createLoadNetworkBudget(() => stopped++);
  for (let i = 0; i < 100; i++) b.reserve();
  assert.throws(() => b.reserve(), isLoadNetworkBudgetFailure);
  assert.equal(stopped, 1);
  assert.deepEqual(b.snapshot(), {
    limit: 100,
    reservations: 100,
    started: 0,
    redirectHops: 0,
  });
  assert.throws(() => loadNetworkBudget(JSON.parse(JSON.stringify(b))));
  assert.equal(loadNetworkBudget(b), b);
});

test("exhaustion rejects before the next connection and retains actual response", async (t) => {
  let hits = 0,
    stopped = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(302, { location: "/final" });
    res.end("first");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const budget = createLoadNetworkBudget(() => stopped++);
  for (let i = 0; i < 99; i++) budget.reserve();
  let failure;
  try {
    await executeRequest(
      {
        url: `http://127.0.0.1:${server.address().port}/start`,
        redirect: { mode: "same-origin", maxHops: 1 },
      },
      undefined,
      { networkBudget: budget },
    );
  } catch (e) {
    failure = readHttpRedirectFailure(e);
  }
  assert.equal(hits, 1);
  assert.equal(stopped, 1);
  assert.equal(failure.failure.reason, "wire-budget");
  assert.equal(failure.failure.requestStarted, false);
  assert.equal(failure.response.status, 302);
  assert.equal(failure.failure.retry_safe, false);
  assert.deepEqual(budget.snapshot(), {
    limit: 100,
    reservations: 100,
    started: 1,
    redirectHops: 0,
  });
});
