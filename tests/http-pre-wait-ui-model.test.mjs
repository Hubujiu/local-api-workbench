import assert from "node:assert/strict";
import test from "node:test";
import {
  addHTTPPreWait,
  createHTTPPreWaitDrafts,
  supportsHTTPPreWait,
  validateHTTPPreWaits,
} from "../public/http-pre-wait.js";
import { httpPreActionsHTML } from "../public/http-pre-actions.js";

const fixture = () => ({ before: [] });
test("ordinary draft addition is genuine, exact and bounded", () => {
  const r = fixture();
  assert.equal(addHTTPPreWait(r), 0);
  assert.deepEqual(r.before, [
    { type: "wait", waitVersion: 1, milliseconds: 1000, enabled: true },
  ]);
  assert.throws(
    () => validateHTTPPreWaits(r, [{ ...r.before[0], milliseconds: "1000" }]),
    /整数/,
  );
  assert.throws(
    () => validateHTTPPreWaits(r, [{ ...r.before[0], extra: "bad" }]),
    /整数/,
  );
  r.before[0].milliseconds = 10000;
  assert.throws(() => addHTTPPreWait(r), /累计/);
  assert.equal(r.before.length, 1);
  assert.match(
    httpPreActionsHTML({ canWait: true }),
    /data-pre-action="wait">等待/,
  );
  assert.doesNotMatch(
    httpPreActionsHTML({ canWait: false }),
    /data-pre-action="wait"/,
  );
});

test("invalid lexical draft never overwrites canonical data, remains linked across reorder, and can clear", () => {
  const r = fixture(),
    other = fixture();
  addHTTPPreWait(r);
  addHTTPPreWait(r);
  const [wait, second] = r.before;
  const drafts = createHTTPPreWaitDrafts();
  assert.equal(drafts.edit(r, wait, "1250"), true);
  for (const raw of ["1.5", "1e3", "-1", "10001", " 1", ""]) {
    assert.equal(drafts.edit(r, wait, raw), false);
    assert.equal(drafts.read(wait).raw, raw);
    assert.equal(drafts.pending([r]), true);
    assert.equal(drafts.pending([other]), false);
    assert.equal(wait.milliseconds, 1250);
  }
  r.before.reverse();
  assert.equal(drafts.pending([r]), true);
  assert.equal(drafts.clear(wait), true);
  assert.equal(drafts.pending([r]), false);
  assert.equal(drafts.edit(r, wait, "9500"), false);
  assert.match(drafts.read(wait).message, /累计/);
  drafts.toggle(r, wait, false);
  assert.equal(drafts.edit(r, wait, "9500"), true);
  assert.equal(wait.milliseconds, 9500);
  assert.equal(wait.enabled, false);
  assert.throws(() => drafts.toggle(r, wait, true), /累计/);
  assert.equal(wait.enabled, false);
  assert.equal(second.enabled, true);
});

test("native/imported, GraphQL and SDK requests never acquire an ordinary wait", () => {
  for (const policy of [
    { nativeTasks: {} },
    { importedNativeTaskSource: {} },
    { importedScriptTasks: [] },
    { nativeInheritance: {} },
    { graphqlVariableTemplate: "" },
    { graphqlEditorVersion: 1 },
    { scriptURLMode: "sdk" },
    { headers: [{ dynamic: { source: "apipost-header-function" } }] },
  ]) {
    const r = { ...fixture(), ...policy };
    assert.equal(supportsHTTPPreWait(r), false);
    assert.throws(() => addHTTPPreWait(r), /不支持普通前置等待/);
    assert.deepEqual(r.before, []);
  }
});
