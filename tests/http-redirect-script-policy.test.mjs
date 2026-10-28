// Executes the real script worker. CI-only verification for this development
// session: do not include this file in local script-free acceptance batches.
import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
const policy = { mode: "same-origin", maxHops: 2 };
for (const [name, initial, script] of [
  ["enable", undefined, 'request.redirect={mode:"same-origin",maxHops:2};'],
  ["remove", policy, "delete request.redirect;"],
  ["change", policy, "request.redirect.maxHops=3;"],
])
  test(`real before-script cannot ${name} frozen redirect policy`, async () => {
    let sends = 0;
    const request = {
      url: "http://127.0.0.1:1/never",
      beforeScript: script,
      ...(initial ? { redirect: initial } : {}),
    };
    const run = await runPlan(
      snapshotPlan({ steps: [{ request }] }),
      {},
      async () => {
        sends++;
        throw Error("must not send");
      },
    );
    assert.equal(sends, 0);
    assert.equal(run.results[0].status, "failed");
    assert.match(run.results[0].error, /前置脚本不能更改 HTTP 重定向策略/);
    assert.equal(run.results[0].response, undefined);
  });
test("real before-script may retain the identical redirect policy", async () => {
  let sends = 0;
  const run = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            url: "http://127.0.0.1:1/not-networked",
            redirect: policy,
            beforeScript: 'request.redirect={mode:"same-origin",maxHops:2};',
          },
        },
      ],
    }),
    {},
    async (request) => {
      sends++;
      assert.deepEqual(request.redirect, policy);
      return { status: 200, headers: {}, body: "ok" };
    },
  );
  assert.equal(sends, 1);
  assert.equal(run.results[0].status, "passed");
});
