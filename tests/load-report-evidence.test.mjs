import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import {
  beginLoadReport,
  finishLoadReport,
  transitionLoadRun,
  validateLoadRuns,
} from "../src/load-report-evidence.mjs";
const pending = () => ({
  version: 1,
  id: randomUUID(),
  kind: "one-shot",
  state: "pending",
  startedAt: new Date().toISOString(),
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "load-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const project = await store.create("receipts");
  return { root, store, project };
}
test("receipts preserve concurrent configuration and other activities; terminal commits are idempotent", async (t) => {
  const { store, project } = await fixture(t);
  const stale = await store.get(project.id);
  const begun = await beginLoadReport(store, project.id, "one-shot");
  assert.ok(begun.record);
  stale.name = "edited";
  await store.save(stale);
  assert.equal((await store.get(project.id)).loadRuns.length, 1);
  const receipts = await Promise.all(
    Array.from({ length: 4 }, () =>
      beginLoadReport(store, project.id, "staged"),
    ),
  );
  assert.ok(receipts.every((item) => item.record));
  const terminal = {
    ...begun.record,
    state: "failed",
    finishedAt: new Date().toISOString(),
  };
  await Promise.all([
    store.writeLoadReport(project.id, terminal),
    store.append(project.id, "history", { id: randomUUID() }),
  ]);
  await store.writeLoadReport(project.id, terminal);
  let current = await store.get(project.id);
  assert.equal(current.name, "edited");
  assert.equal(current.loadRuns.length, 5);
  assert.equal(current.history.length, 1);
  await assert.rejects(
    store.writeLoadReport(project.id, { ...terminal, state: "cancelled" }),
    /冲突/,
  );
  // Generic activity/owner writes cannot erase receipts.
  current.loadRuns = [];
  await store.save(current, { activity: true });
  assert.equal((await store.get(project.id)).loadRuns.length, 5);
});
test("bounded transitions refuse 11th pending and retain exactly 50 terminal records", () => {
  let records = [];
  for (let i = 0; i < 10; i++) records = transitionLoadRun(records, pending());
  assert.throws(() => transitionLoadRun(records, pending()), /上限/);
  for (let i = 0; i < 65; i++) {
    const p = records.find((r) => r.state === "pending") ?? pending();
    if (!records.includes(p)) records = transitionLoadRun(records, p);
    records = transitionLoadRun(records, {
      ...p,
      state: "failed",
      finishedAt: p.startedAt,
    });
  }
  assert.equal(records.length, 50);
  assert.ok(records.every((r) => r.state === "failed"));
  validateLoadRuns(records);
  assert.throws(
    () => validateLoadRuns([{ ...records[0], secret: "no" }]),
    /无效/,
  );
  assert.throws(
    () => validateLoadRuns([{ ...records[0], version: 2 }]),
    /无效/,
  );
  assert.throws(() => validateLoadRuns([records[0], records[0]]), /无效/);
});
test("uncertain admission/terminal writes retain attempted identity without retries or secret errors", async (t) => {
  const { store, project, root } = await fixture(t);
  const real = store.writeLoadReport.bind(store);
  let calls = 0;
  store.writeLoadReport = async (...args) => {
    calls++;
    await real(...args);
    throw new ProjectCommitUncertain(project.id, Error("SECRET"));
  };
  const begun = await beginLoadReport(store, project.id, "one-shot");
  assert.equal(calls, 1);
  assert.equal(begun.record, undefined);
  assert.equal(begun.receipt.recordSaved, false);
  assert.equal(begun.receipt.persistenceOutcome.retry_safe, false);
  assert.ok(!JSON.stringify(begun).includes("SECRET"));
  let records = (await store.get(project.id)).loadRuns;
  assert.equal(records[0].id, begun.receipt.attemptedRecordId);
  const receipt = await finishLoadReport(store, project.id, records[0]);
  assert.equal(calls, 2);
  assert.equal(receipt.recordSaved, false);
  const restarted = new Store(root);
  await restarted.init();
  records = (await restarted.get(project.id)).loadRuns;
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "failed");
});
test("restart leaves pending unconfirmed and never reconstructs execution", async (t) => {
  const { store, project, root } = await fixture(t);
  const begun = await beginLoadReport(store, project.id, "one-shot");
  const restarted = new Store(root);
  await restarted.init();
  assert.deepEqual((await restarted.get(project.id)).loadRuns, [begun.record]);
});

test(
  "twelve independent Stores serialize receipt admission and ten terminal transitions without revision retries",
  { timeout: 20000 },
  async (t) => {
    const { root, store, project } = await fixture(t);
    const peers = Array.from({ length: 12 }, () => new Store(root));
    await Promise.all(peers.map((peer) => peer.init()));
    const records = peers.map(() => pending());
    const admitted = await Promise.allSettled(
      peers.map((peer, index) =>
        peer.writeLoadReport(project.id, records[index]),
      ),
    );
    assert.equal(
      admitted.filter((item) => item.status === "fulfilled").length,
      10,
    );
    for (const item of admitted.filter((item) => item.status === "rejected"))
      assert.match(item.reason.message, /上限/);
    const accepted = records.filter(
      (_, index) => admitted[index].status === "fulfilled",
    );
    assert.equal((await store.get(project.id)).loadRuns.length, 10);
    const terminal = accepted.map((record) => ({
      ...record,
      state: "failed",
      finishedAt: new Date().toISOString(),
    }));
    const saved = await Promise.all(
      terminal.map((record, index) =>
        peers[index].writeLoadReport(project.id, record),
      ),
    );
    assert.equal(saved.length, 10);
    const after = await store.get(project.id);
    assert.equal(after.loadRuns.length, 10);
    assert.equal(
      after.loadRuns.filter((record) => record.state === "pending").length,
      0,
    );
    assert.equal(new Set(after.loadRuns.map((record) => record.id)).size, 10);
    // Rejected admission did not poison a Store queue; storage-only replay remains idempotent.
    await Promise.all(
      terminal.map((record, index) =>
        peers[index].writeLoadReport(project.id, record),
      ),
    );
    assert.equal((await store.get(project.id)).loadRuns.length, 10);
    const next = await beginLoadReport(peers[11], project.id, "staged");
    assert.ok(next.record);
    const reopened = new Store(root);
    await reopened.init();
    assert.equal(
      (await reopened.get(project.id)).loadRuns.filter(
        (record) => record.state === "pending",
      ).length,
      1,
    );
  },
);
