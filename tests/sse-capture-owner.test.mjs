import assert from "node:assert/strict";
import test from "node:test";
import {
  createSSECaptureOwner,
  sseCaptureView,
} from "../public/sse-capture-owner.js";
import { selectedSSEWorkbench } from "../public/sse-workbench.js";

const url = "http://127.0.0.1:1/events";
const owner = { projectId: "a", definitionId: "one", definitionUrl: url };
const other = { ...owner, definitionId: "two" };
const run = (id = "run-a") => ({ runId: id, url });
const receipt = (overrides = {}) => ({
  runId: "run-a",
  recordSaved: true,
  attemptedRecordId: "record-a",
  recordId: "record-a",
  status: 200,
  events: [{ data: "<only A>" }],
  ...overrides,
});
const row = (overrides = {}) => ({
  id: "record-a",
  runId: "run-a",
  type: "sse",
  definition: { type: "sse", url },
  status: "cancelled",
  result: null,
  ...overrides,
});

test("a late successful response is isolated by project and selected definition", () => {
  const calls = createSSECaptureOwner();
  const a = calls.start(owner, run());
  assert.equal(sseCaptureView(calls.current(owner)).canCancel, true);
  assert.equal(calls.start(other, run("run-b")), null);
  calls.settle(a, receipt());
  for (const wrong of [other, { ...owner, projectId: "b" }]) {
    assert.equal(calls.current(wrong), undefined);
    assert.equal(sseCaptureView(calls.current(wrong)).canCancel, false);
  }
  assert.equal(sseCaptureView(calls.current({ ...owner })).canCancel, false);
  const content = selectedSSEWorkbench(
    { type: "sse", name: "test", url },
    { session: {}, busy: false, capture: calls.current(owner) },
  );
  assert.match(content, /采集完成.*本机记录已保存/);
  assert.match(content, /&lt;only A&gt;/);
  assert.doesNotMatch(content, /<only A>/);
});

test("a cancel acknowledgement does not confirm stop; ownership and exactly one record are required", () => {
  const calls = createSSECaptureOwner();
  const a = calls.start(owner, run());
  assert.equal(calls.cancel(calls.current(other)), false);
  assert.equal(calls.cancel(a), true);
  assert.equal(calls.cancel(a), false);
  assert.match(sseCaptureView(a).notice, /已请求断开/);
  calls.settle(a, receipt({ error: "This operation was aborted" }));
  assert.equal(a.phase, "unknown");
  assert.equal(sseCaptureView(a).blocksStart, true);
  assert.equal(calls.start(owner, run("new-attempt")), null);
  for (const records of [
    [],
    [row(), row()],
    [row({ id: "wrong" })],
    [row({ runId: "other" })],
    [row({ definition: { type: "sse", url: url + "/old" } })],
    [row({ status: "running" })],
  ]) {
    assert.equal(calls.check(a, records), false);
    assert.equal(a.phase, "unknown");
  }
  a.reconciliationMissed = true;
  assert.match(sseCaptureView(a).notice, /未核对到.*请勿重发/);
  assert.doesNotMatch(sseCaptureView(calls.current(other)).notice, /未核对到/);
  a.checking = true;
  assert.doesNotMatch(sseCaptureView(a).notice, /未核对到/);
  a.checking = false;
  assert.equal(calls.check(a, [row()]), true);
  assert.match(sseCaptureView(a).notice, /已取消/);
  assert.doesNotMatch(sseCaptureView(a).notice, /未核对到/);
  assert.equal(calls.check(a, [row({ status: "completed" })]), false);
  assert.equal(calls.current(other), undefined);
});

test("a failed save, missing or mismatched reply remains unknown; abandonment never performs execution", () => {
  for (const response of [
    undefined,
    receipt({ runId: "other" }),
    receipt({ recordSaved: false, recordId: null }),
  ]) {
    const calls = createSSECaptureOwner();
    const a = calls.start(owner, run());
    calls.settle(a, response);
    assert.equal(a.phase, "unknown");
    assert.doesNotMatch(sseCaptureView(a).result, /only A/);
    a.checking = true;
    assert.equal(calls.abandon(a), false);
    a.checking = false;
    assert.equal(calls.abandon(a), true);
    assert.equal(calls.current(owner), undefined);
    const newer = calls.start(owner, run("new"));
    calls.settle(a, receipt());
    assert.equal(newer.phase, "running");
  }
});

test("known completion is evictable, unresolved attempts are not silently evicted", () => {
  const calls = createSSECaptureOwner();
  const identities = [
    owner,
    other,
    { ...owner, definitionId: "three" },
    { ...owner, definitionId: "four" },
  ];
  for (const item of identities)
    calls.settle(calls.start(item, run()), undefined);
  assert.equal(calls.start({ ...owner, definitionId: "five" }, run()), null);
  assert.equal(calls.check(calls.current(owner), [row()]), true);
  assert.ok(calls.start({ ...owner, definitionId: "five" }, run()));
  assert.equal(calls.current(owner), undefined);
  assert.equal(calls.current(other).phase, "unknown");
});

test("a save to a new target keeps unknown and terminal state under the same definition, not its prior URL", () => {
  const calls = createSSECaptureOwner();
  const original = url + "?marker=old-fixture";
  const scope = { ...owner, definitionUrl: original };
  const newerUrl = url + "/new";
  const dispatched = { runId: "run-a", url: original };
  const a = calls.start(scope, dispatched);
  calls.settle(a, undefined);
  scope.definitionUrl = newerUrl;
  dispatched.url = newerUrl;
  assert.equal(calls.current(scope), a);
  assert.equal(calls.start(scope, { runId: "never", url: newerUrl }), null);
  assert.equal(a.dispatch.url, original);
  assert.equal(a.owner.definitionUrl, original);
  assert.equal(sseCaptureView(a, newerUrl).blocksStart, true);
  assert.match(sseCaptureView(a, newerUrl).targetNote, /不代表当前地址已执行/);
  assert.equal(
    calls.check(a, [row({ definition: { type: "sse", url: newerUrl } })]),
    false,
  );
  assert.equal(
    calls.check(a, [
      row({
        definition: { type: "sse", url: original },
        status: "completed",
        result: { events: [{ data: "old-fixture" }] },
      }),
    ]),
    true,
  );
  assert.equal(calls.current(scope), a);
  const view = sseCaptureView(a, newerUrl);
  assert.match(view.notice, /采集完成/);
  assert.match(view.targetNote, /之前的采集/);
  assert.doesNotMatch(JSON.stringify(view), /old-fixture/);
  assert.equal(view.result, "");
  assert.equal(view.blocksStart, false);
  assert.match(sseCaptureView(a, original).result, /old-fixture/);
});

test("an unsaved override keeps its real response visible until the saved target changes to a third value", () => {
  const calls = createSSECaptureOwner();
  const target = url + "/one-time";
  const a = calls.start(owner, { runId: "run-a", url: target });
  calls.settle(a, receipt());
  for (const matches of [owner.definitionUrl, target]) {
    assert.equal(sseCaptureView(a, matches).targetNote, "");
    assert.match(sseCaptureView(a, matches).result, /only A/);
  }
  assert.equal(sseCaptureView(a, target + "-new").result, "");
});
