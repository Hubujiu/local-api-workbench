import test from "node:test";
import assert from "node:assert/strict";
import {
  loadFailureReasons,
  loadFailureCounts,
  countLoadFailures,
} from "../src/load-report-semantics.mjs";

test("classification preserves existing status policies and separates assertions", () => {
  const record = {
    status: "passed",
    response: { status: 404 },
    assertions: [{ target: "status", passed: true }],
  };
  assert.deepEqual(loadFailureReasons(record), []);
  assert.deepEqual(
    loadFailureReasons(record, { policy: "2xx-and-assertions" }),
    ["http-status-policy"],
  );
  assert.deepEqual(
    loadFailureReasons({ ...record, status: "failed" }, { strict200: true }),
    ["http-status-policy"],
  );
  assert.deepEqual(loadFailureReasons(record, { expectedStatus: 404 }), []);
  assert.deepEqual(
    loadFailureReasons(
      { ...record, status: "failed" },
      { expectedStatus: 200 },
    ),
    ["http-status-policy"],
  );
  const failed = {
    ...record,
    status: "failed",
    assertions: [{ target: "status", passed: false }],
  };
  assert.deepEqual(loadFailureReasons(failed), ["assertion"]);
  assert.deepEqual(
    loadFailureReasons(failed, { policy: "2xx-and-assertions" }),
    ["http-status-policy", "assertion"],
  );
  assert.deepEqual(
    loadFailureReasons({
      status: "failed",
      response: { status: 503 },
      assertions: [],
    }),
    ["http-status-policy"],
  );
});
test("fixed vocabulary cannot carry remote messages and errors are not parsed", () => {
  const record = {
    status: "failed",
    error: "cancelled redirect secret-url token",
    response: { status: 200 },
  };
  assert.deepEqual(loadFailureReasons(record), ["execution"]);
  assert.deepEqual(loadFailureReasons(record, { cancelled: true }), [
    "cancelled",
  ]);
  assert.deepEqual(
    loadFailureReasons({ ...record, redirectFailure: { reason: "origin" } }),
    ["redirect"],
  );
  assert.deepEqual(
    loadFailureReasons({ ...record, redirectFailure: { reason: "cancelled" } }),
    ["cancelled", "redirect"],
  );
  assert.deepEqual(loadFailureReasons({ status: "failed" }), ["execution"]);
  const counts = loadFailureCounts();
  countLoadFailures(counts, ["assertion", "assertion", "secret-value"]);
  assert.deepEqual(counts, {
    "http-status-policy": 0,
    assertion: 1,
    execution: 0,
    cancelled: 0,
    redirect: 0,
  });
});
test("classification is a read-only projection of execution records", () => {
  const record = Object.freeze({
    status: "failed",
    response: Object.freeze({ status: 404 }),
    assertions: Object.freeze([]),
  });
  assert.deepEqual(
    loadFailureReasons(record, { policy: "2xx-and-assertions" }),
    ["http-status-policy"],
  );
  assert.deepEqual(Object.keys(record), ["status", "response", "assertions"]);
});
