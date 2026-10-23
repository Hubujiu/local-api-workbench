import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runLoad } from "../src/load-runner.mjs";

const project = {
  environments: [{ id: "default", name: "Default", variables: {} }],
  settings: {},
};
async function fixture(t) {
  const seen = [];
  let notify;
  const arrived = new Promise((resolve) => {
    notify = resolve;
  });
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    notify();
    if (req.url !== "/slow") res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { seen, arrived, url: "http://127.0.0.1:" + server.address().port };
}
test("duration load aborts in-flight primary HTTP and reports deadline rather than cancellation", async (t) => {
  const f = await fixture(t);
  const result = await runLoad(
    project,
    { url: f.url + "/slow" },
    { mode: "duration", durationSeconds: 1, count: 3, concurrency: 2 },
  );
  assert.equal(result.stopReason, "duration");
  assert.equal(result.cancelled, false);
  assert.equal(result.durationSeconds, 1);
  assert.equal(result.count, 2);
  assert.equal(result.mainRequests, 2);
  assert.equal(result.passed, 0);
  assert.equal(result.timingSamples, 0);
  assert(result.results.every((r) => r.interrupted && r.error));
  assert(result.elapsed >= 950);
  assert.equal(f.seen.length, 2);
});
test("duration load preserves cap, completed failures and CSV evidence instead of claiming full duration", async (t) => {
  const f = await fixture(t);
  const result = await runLoad(
    project,
    {
      url: f.url,
      afterScript: 'pm.test("failed",()=>pm.expect(1).to.equal(2));',
    },
    {
      mode: "duration",
      durationSeconds: 60,
      count: 2,
      concurrency: 1,
      dataCSV: "id\n1\n2",
    },
  );
  assert.equal(result.stopReason, "count-limit");
  assert.equal(result.passed, 0);
  assert.equal(result.count, 2);
  assert(
    result.results.every(
      (r) => !r.interrupted && r.assertionFailureCount === 1,
    ),
  );
  assert.deepEqual(
    result.results.map((r) => r.dataRow),
    [1, 2],
  );
  assert.equal(f.seen.length, 2);
});
test("manual cancellation wins over a future duration deadline and cancels script child HTTP", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const pending = runLoad(
    project,
    {
      url: f.url + "/main",
      beforeScript: `await pm.sendRequest(${JSON.stringify(f.url + "/slow")});`,
    },
    {
      mode: "duration",
      durationSeconds: 60,
      count: 2,
      signal: controller.signal,
    },
  );
  await f.arrived;
  controller.abort();
  const result = await pending;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.mainRequests, 0);
  assert.equal(result.passed, 0);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].interrupted, true);
  assert.deepEqual(f.seen, ["/slow"]);
});
test("invalid duration settings reject before network, count mode remains default", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { mode: "unknown" },
    ...[undefined, null, 0, -1, 1.1, 61, "1", true].map((durationSeconds) => ({
      mode: "duration",
      durationSeconds,
    })),
  ])
    await assert.rejects(runLoad(project, { url: f.url }, options), /压测/);
  assert.equal(f.seen.length, 0);
  const result = await runLoad(project, { url: f.url }, { count: 1 });
  assert.equal(result.mode, "count");
  assert.equal(result.stopReason, "count");
  assert.equal(result.count, 1);
});

test("duration expiration interrupts a pending script subrequest without sending primary HTTP", async (t) => {
  const f = await fixture(t);
  const result = await runLoad(
    project,
    {
      url: f.url + "/main",
      beforeScript: `await pm.sendRequest(${JSON.stringify(f.url + "/slow")});`,
    },
    { mode: "duration", durationSeconds: 1, count: 2 },
  );
  assert.equal(result.stopReason, "duration");
  assert.equal(result.cancelled, false);
  assert.equal(result.mainRequests, 0);
  assert.equal(result.passed, 0);
  assert.equal(result.results[0].interrupted, true);
  assert(result.results[0].error);
  assert.deepEqual(f.seen, ["/slow"]);
});

test("already cancelled duration run starts no request", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  const result = await runLoad(
    project,
    { url: f.url },
    {
      mode: "duration",
      durationSeconds: 1,
      count: 2,
      signal: controller.signal,
    },
  );
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.count, 0);
  assert.equal(result.mainRequests, 0);
  assert.deepEqual(f.seen, []);
});
