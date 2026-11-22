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

test("a late successful response is isolated by project, selected definition and saved target", () => {
  const calls = createSSECaptureOwner();
  const a = calls.start(owner, run());
  assert.equal(sseCaptureView(calls.current(owner)).canCancel, true);
  assert.equal(calls.start(other, run("run-b")), null);
  calls.settle(a, receipt());
  for (const wrong of [
    other,
    { ...owner, projectId: "b" },
    { ...owner, definitionUrl: url + "/edited" },
  ]) {
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
