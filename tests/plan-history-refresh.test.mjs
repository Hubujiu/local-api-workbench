import test from "node:test";
import assert from "node:assert/strict";
import { createPlanHistoryRefresh } from "../public/plan-history-refresh.js";
import { renderPlans } from "../public/plan-view.js";
const record = (id) => ({ id, results: [], status: "passed" });
const project = () => ({
  id: "p",
  runs: [record("old")],
  plans: [],
  name: "unsaved draft",
  revision: 3,
  configRevision: 2,
  _diskFingerprint: "old",
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("read selects only saved history, leaves drafts and CAS/authority untouched", async () => {
  const owner = project(),
    before = structuredClone(owner),
    calls = [];
  const receipt = {
    ...owner,
    name: "other editor",
    revision: 99,
    configRevision: 98,
    _diskFingerprint: "other",
    runs: [record("mcp")],
  };
  const runs = await createPlanHistoryRefresh()({
    owner,
    isCurrent: () => true,
    read: async (id) => {
      calls.push(id);
      return receipt;
    },
  });
  assert.deepEqual(calls, ["p"]);
  assert.deepEqual(owner, before);
  assert.deepEqual(runs, receipt.runs);
  runs[0].results.push({ status: "failed" });
  assert.equal(receipt.runs[0].results.length, 0);
});
for (const [label, change] of [
  ["project or page changed", () => false],
  ["same-id project reopened", () => false],
  ["draft edited", () => false],
  ["execution started", () => false],
])
  test(`late read rejected when ${label}`, async () => {
    const owner = project(),
      d = deferred();
    let current = true;
    const result = createPlanHistoryRefresh()({
      owner,
      read: () => d.promise,
      isCurrent: () => current,
    });
    current = change();
    d.resolve({ ...owner, runs: [record("new")] });
    await assert.rejects(result, /已变化/);
    assert.equal(owner.runs[0].id, "old");
  });
test("concurrent run adoption cannot be overwritten", async () => {
  const owner = project(),
    d = deferred();
  const result = createPlanHistoryRefresh()({
    owner,
    read: () => d.promise,
    isCurrent: () => true,
  });
  owner.runs = [record("newer")];
  d.resolve({ ...owner, runs: [] });
  await assert.rejects(result, /已变化/);
  assert.equal(owner.runs[0].id, "newer");
});
test("latest refresh wins, old response cannot replace evidence", async () => {
  const refresh = createPlanHistoryRefresh(),
    owner = project(),
    a = deferred(),
    b = deferred();
  const first = refresh({
    owner,
    read: () => a.promise,
    isCurrent: () => true,
  });
  const second = refresh({
    owner,
    read: () => b.promise,
    isCurrent: () => true,
  });
  b.resolve({ ...owner, runs: [record("new")] });
  assert.equal((await second)[0].id, "new");
  a.resolve({ ...owner, runs: [record("old")] });
  await assert.rejects(first, /已变化/);
});
for (const receipt of [
  { id: "other", runs: [] },
  { id: "p" },
  { id: "p", runs: [null] },
  { id: "p", runs: [record("a"), record("a")] },
  { id: "p", runs: [{ id: "a" }] },
])
  test(
    "malformed or wrong-owner receipt leaves history intact " +
      JSON.stringify(receipt),
    async () => {
      const owner = project(),
        before = structuredClone(owner);
      await assert.rejects(
        createPlanHistoryRefresh()({
          owner,
          read: async () => receipt,
          isCurrent: () => true,
        }),
      );
      assert.deepEqual(owner, before);
    },
  );
test("read error leaves cached evidence and draft intact", async () => {
  const owner = project(),
    before = structuredClone(owner);
  await assert.rejects(
    createPlanHistoryRefresh()({
      owner,
      read: async () => {
        throw Error("offline");
      },
      isCurrent: () => true,
    }),
    /offline/,
  );
  assert.deepEqual(owner, before);
});
test("refresh is explicitly read-only and only offered on records tab", () => {
  const owner = project();
  assert.match(
    renderPlans({ project: owner, tab: "runs" }),
    /id="refresh-plan-history"/,
  );
  assert.match(
    renderPlans({ project: owner, tab: "runs" }),
    /不运行计划或保存草稿/,
  );
  assert.doesNotMatch(
    renderPlans({ project: owner, tab: "plans" }),
    /id="refresh-plan-history"/,
  );
});
test("unknown run outcome is neither failure nor success", () => {
  const owner = project();
  owner.runs = [{ ...record("uncertain"), status: "unknown" }];
  const html = renderPlans({ project: owner, tab: "runs" });
  assert.match(html, /结果待核对/);
  assert.doesNotMatch(html, /✓ 通过|× 失败/);
});
test("stable record ID is attribute encoded", () => {
  const owner = project();
  owner.runs = [record('record "one" & <two>')];
  const html = renderPlans({ project: owner, tab: "runs" });
  assert.match(
    html,
    /data-export-run="record &quot;one&quot; &amp; &lt;two&gt;"/,
  );
});
