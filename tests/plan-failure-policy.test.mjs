import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { versionPlan } from "../src/plan-version.mjs";
const leaf = (id, url, extra = {}) => ({
  id,
  request: { id: "request-" + id, method: "GET", url, ...extra },
});
const group = (steps) => ({
  type: "if",
  id: "if",
  condition: { op: "eq", left: { literal: true }, right: { literal: true } },
  steps,
});
async function fixture(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.statusCode = req.url === "/login" ? 401 : 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}
for (const kind of ["linear", "repeat", "if", "assertion", "script"])
  test(
    `stop failure policy retains completed ${kind} evidence and starts no later HTTP`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const first = leaf(
        "first",
        f.url + (kind === "assertion" || kind === "script" ? "/ok" : "/login"),
        kind === "assertion"
          ? { assertions: [{ target: "status", op: "eq", value: 201 }] }
          : kind === "script"
            ? {
                afterScript:
                  'pm.test("must fail", () => { throw Error("controlled failure"); });',
              }
            : {},
      );
      let steps = [first, leaf("inside", f.url + "/inside")];
      if (kind === "repeat")
        steps = [
          { type: "repeat", id: "repeat", count: 2, steps: [group(steps)] },
        ];
      if (kind === "if")
        steps = [group([{ type: "repeat", id: "repeat", count: 2, steps }])];
      steps.push(leaf("tail", f.url + "/tail"));
      const plan = snapshotPlan({ id: "plan", failurePolicy: "stop", steps });
      const run = await runPlan(plan, {}, executeRequest);
      assert.equal(run.status, "failed");
      assert.deepEqual(f.seen, [
        kind === "assertion" || kind === "script" ? "/ok" : "/login",
      ]);
      assert.equal(run.results.length, 1);
      assert.equal(run.results[0].status, "failed");
      assert.ok(run.results[0].response);
      assert.equal(run.stopReason, "step-failure");
      assert.equal(run.failureStop.stepId, "first");
      if (kind === "repeat" || kind === "if")
        assert.deepEqual(run.failureStop.repeat, run.results[0].repeat);
      assert.equal(run.snapshot.failurePolicy, "stop");
    },
  );
test(
  "default and explicit continue retain legacy snapshot bytes; explicit expected error remains passed",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const input = {
      id: "p",
      name: "p",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      steps: [leaf("first", f.url + "/login"), leaf("tail", f.url + "/tail")],
    };
    const old = snapshotPlan(input);
    assert.deepEqual(
      snapshotPlan({ ...input, failurePolicy: "continue" }),
      old,
    );
    const run = await runPlan(old, {}, executeRequest);
    assert.equal(run.results.length, 2);
    assert.equal(run.stopReason, undefined);
    f.seen.length = 0;
    const allowed = snapshotPlan({
      ...input,
      failurePolicy: "stop",
      steps: [{ ...input.steps[0], expectedStatus: 401 }, input.steps[1]],
    });
    const passed = await runPlan(allowed, {}, executeRequest);
    assert.equal(passed.status, "passed");
    assert.deepEqual(f.seen, ["/login", "/tail"]);
    assert.equal(passed.stopReason, undefined);
  },
);
test("failure policy is closed, versioned, preserved on omission and explicitly removable", () => {
  const initial = versionPlan(null, {
    id: "p",
    steps: [leaf("a", "http://127.0.0.1:1/never")],
  });
  const stopped = versionPlan(initial, { ...initial, failurePolicy: "stop" });
  assert.equal(stopped.failurePolicy, "stop");
  assert.equal(stopped.provenance.fields.failurePolicy, "manual");
  assert.equal(
    versionPlan(stopped, { ...initial, name: "renamed" }).failurePolicy,
    "stop",
  );
  assert.equal(
    Object.hasOwn(
      versionPlan(stopped, { ...stopped, failurePolicy: "continue" }),
      "failurePolicy",
    ),
    false,
  );
  for (const failurePolicy of [null, false, 0, "STOP", "ignore", {}, []])
    assert.throws(
      () => snapshotPlan({ ...initial, failurePolicy }),
      /failurePolicy|失败策略/,
    );
});

test(
  "stop before-script failure starts neither primary nor trailing HTTP",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const plan = snapshotPlan({
      id: "before",
      failurePolicy: "stop",
      steps: [
        leaf("a", f.url + "/primary", {
          beforeScript: 'throw Error("controlled before failure");',
        }),
        leaf("b", f.url + "/tail"),
      ],
    });
    const run = await runPlan(plan, {}, executeRequest);
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "step-failure");
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].response, undefined);
    assert.match(run.results[0].error, /controlled before failure/);
    assert.deepEqual(f.seen, []);
  },
);

test(
  "external cancellation during held real HTTP wins over failure policy and sends no tail",
  { timeout: 15000 },
  async (t) => {
    let entered;
    const held = new Promise((resolve) => {
      entered = resolve;
    });
    const seen = [];
    const peer = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url === "/hold") {
        entered();
        return;
      }
      res.end("unexpected");
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    t.after(async () => {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
    });
    const url = `http://127.0.0.1:${peer.address().port}`;
    const controller = new AbortController();
    const pending = runPlan(
      snapshotPlan({
        id: "cancel",
        failurePolicy: "stop",
        steps: [leaf("a", url + "/hold"), leaf("b", url + "/tail")],
      }),
      {},
      executeRequest,
      { signal: controller.signal },
    );
    await Promise.race([
      held,
      pending.then(() => {
        throw Error("run ended before held request");
      }),
    ]);
    controller.abort();
    const run = await pending;
    assert.equal(run.status, "cancelled");
    assert.equal(run.results.length, 1);
    assert.equal(run.stopReason, undefined);
    assert.equal(run.failureStop, undefined);
    assert.deepEqual(seen, ["/hold"]);
  },
);
