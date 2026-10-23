import test from "node:test";
import assert from "node:assert/strict";
import { runCaseBatch } from "../public/case-batch.js";
const items = () =>
  [1, 2, 3].map((i) => ({
    id: String(i),
    name: "Case " + i,
    request: { body: "body " + i },
  }));
test("case batch uses immutable ordered snapshots and continues explicit case failures", async () => {
  const source = items(),
    seen = [],
    progress = [];
  const result = await runCaseBatch(
    source,
    async (item) => {
      seen.push(item.request.body);
      source[1].request.body = "changed elsewhere";
      return { outcome: item.id === "2" ? "failed" : "passed" };
    },
    { onProgress: (p) => progress.push(p.completed) },
  );
  assert.deepEqual(seen, ["body 1", "body 2", "body 3"]);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.passed, 2);
  assert.equal(result.cancelled, false);
  assert.equal(progress.at(-1), 3);
});
test("case batch cancellation prevents later requests without hiding completed evidence", async () => {
  let stop = false;
  const seen = [];
  const result = await runCaseBatch(
    items(),
    async (item) => {
      seen.push(item.id);
      stop = true;
      return { outcome: "passed" };
    },
    { shouldStop: () => stop },
  );
  assert.deepEqual(seen, ["1"]);
  assert.equal(result.completed, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.results[0].result.outcome, "passed");
});
test("invalid batches make no calls and transport errors stop without retry", async () => {
  let calls = 0;
  for (const list of [
    [],
    Array.from({ length: 101 }, (_, i) => ({ id: String(i), request: {} })),
    [{ id: "a" }, { id: "a" }],
  ])
    await assert.rejects(() => runCaseBatch(list, async () => calls++));
  assert.equal(calls, 0);
  const result = await runCaseBatch(items(), async () => {
    calls++;
    throw Error("connection lost; outcome unknown");
  });
  assert.equal(calls, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.stoppedOnError, true);
  assert.match(result.results[0].error, /outcome unknown/);
});

test("batch order follows the visible root and nested group ordering", async () => {
  const { caseRunOrder } = await import("../public/case-folders.js");
  const p = {
    requests: [{ id: "api" }],
    caseFolders: [
      { id: "b", name: "B", sourceRequestId: "api", sort: 2 },
      { id: "a", name: "A", sourceRequestId: "api", sort: 1 },
      { id: "child", name: "Child", sourceRequestId: "api", parentId: "a" },
    ],
    cases: [
      { id: "nested", sourceRequestId: "api", folderId: "child" },
      { id: "b-case", sourceRequestId: "api", folderId: "b" },
      { id: "root", sourceRequestId: "api" },
      { id: "a-case", sourceRequestId: "api", folderId: "a" },
    ],
  };
  assert.deepEqual(
    caseRunOrder(p, "api").map((c) => c.id),
    ["root", "a-case", "nested", "b-case"],
  );
});

test("case result evidence is isolated across copied projects with identical case IDs", async () => {
  const { createCaseResultStore } = await import(
    "../public/case-result-store.js"
  );
  const store = createCaseResultStore();
  store.set(
    "source",
    "same-case",
    { outcome: "passed", body: "source evidence" },
    { collapsed: true },
  );
  assert.equal(store.results("copy").size, 0);
  assert.equal(store.collapsed("copy").size, 0);
  store.set("copy", "same-case", { outcome: "failed", body: "copy evidence" });
  assert.equal(
    store.results("source").get("same-case").body,
    "source evidence",
  );
  assert.equal(store.results("copy").get("same-case").body, "copy evidence");
  assert(store.collapsed("source").has("same-case"));
  assert.equal(store.collapsed("copy").has("same-case"), false);
});

test("batch input and displayed evidence have aggregate and UTF-8 limits without hiding outcomes", async () => {
  const { caseEvidence } = await import("../public/case-batch.js");
  let calls = 0;
  await assert.rejects(
    () =>
      runCaseBatch(
        [{ id: "large", request: { body: "x".repeat(4 * 1024 * 1024) } }],
        async () => calls++,
      ),
    /4MiB/,
  );
  assert.equal(calls, 0);
  const result = {
    outcome: "failed",
    status: 500,
    body: "中".repeat(50000),
    rawBodyBase64: "x".repeat(70000),
    request: { method: "GET", url: "https://example.test" },
    assertions: Array.from({ length: 30 }, (_, i) => ({
      name: "failure " + i,
      passed: false,
      message: "bad",
    })),
  };
  const evidence = caseEvidence(result);
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.evidenceTruncated, true);
  assert.equal(evidence.failedAssertionCount, 30);
  assert.equal(evidence.failedAssertions.length, 20);
  assert(
    new TextEncoder().encode(JSON.stringify(evidence)).byteLength <= 65536,
  );
  assert.equal(result.body.length, 50000);
  assert.equal(evidence.rawBodyBase64, undefined);
});

test("batch evidence budgets include JSON escaping for control characters", async () => {
  const { caseEvidence } = await import("../public/case-batch.js");
  const result = {
    outcome: "failed",
    body: "\0".repeat(70000),
    request: { url: "\0".repeat(9000) },
    error: "\0".repeat(9000),
    assertions: Array.from({ length: 30 }, () => ({
      passed: false,
      name: "\0".repeat(1000),
      message: "\0".repeat(1000),
    })),
  };
  const evidence = caseEvidence(result);
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.failedAssertionCount, 30);
  assert(
    new TextEncoder().encode(JSON.stringify(evidence)).byteLength <= 65536,
  );
});

test("starting a batch clears only selected evidence in its own project", async () => {
  const { createCaseResultStore } = await import(
    "../public/case-result-store.js"
  );
  const store = createCaseResultStore();
  for (const project of ["a", "b"])
    for (const id of ["selected", "other"])
      store.set(project, id, { outcome: "passed" }, { collapsed: true });
  store.clear("a", ["selected"]);
  assert.equal(store.results("a").has("selected"), false);
  assert.equal(store.collapsed("a").has("selected"), false);
  assert.equal(store.results("a").has("other"), true);
  assert.equal(store.results("b").has("selected"), true);
});
