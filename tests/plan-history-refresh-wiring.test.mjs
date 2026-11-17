import {
  capturePlanHistoryFocus,
  restorePlanHistoryFocus,
} from "../public/plan-history-focus.js";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createPlanHistoryRefresh } from "../public/plan-history-refresh.js";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const start = source.indexOf('  on("#refresh-plan-history",');
const end = source.indexOf('  on("#history-project-reload",', start);
assert(start > 0 && end > start);
function fixture() {
  let handler, resolve;
  const pending = new Promise((r) => (resolve = r));
  const target = {
    isConnected: true,
    contains: () => false,
    innerHTML: "old evidence",
  };
  const status = { isConnected: true, textContent: "" },
    button = { isConnected: true };
  const requests = [],
    renders = [];
  const owner = {
    id: "p",
    name: "unsaved",
    revision: 3,
    configRevision: 2,
    _diskFingerprint: "old",
    runs: [{ id: "old", results: [] }],
    requests: [{ name: "draft" }],
  };
  const context = vm.createContext({
    document: { activeElement: null },
    capturePlanHistoryFocus,
    restorePlanHistoryFocus,
    project: owner,
    projectOpenSequence: 1,
    editVersion: 5,
    lastRun: null,
    busy: false,
    saving: false,
    page: "plans",
    planTab: "runs",
    $: (selector) => (selector === "#plan-run-records" ? target : status),
    on: (selector, _event, fn) => {
      assert.equal(selector, "#refresh-plan-history");
      handler = fn;
    },
    api: (...args) => {
      requests.push(args);
      return pending;
    },
    refreshPlanHistory: createPlanHistoryRefresh(),
    renderRuns: (runs, lastRun) => {
      renders.push({ runs, lastRun });
      return "new evidence";
    },
    bindRunExports: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    context,
    owner,
    target,
    status,
    button,
    requests,
    renders,
    resolve,
    run: () => handler(null, button),
  };
}
test("actual app handler adopts only runs and updates only records DOM", async () => {
  const f = fixture(),
    before = structuredClone(f.owner),
    result = f.run();
  f.resolve({
    id: "p",
    name: "remote config",
    revision: 100,
    configRevision: 99,
    runs: [{ id: "mcp", status: "passed", results: [] }],
  });
  await result;
  assert.deepEqual(f.requests, [["/projects/p"]]);
  assert.deepEqual({ ...f.owner, runs: before.runs }, before);
  assert.equal(f.target.innerHTML, "new evidence");
  assert.equal(f.owner.runs[0].id, "mcp");
  assert.equal(f.button.disabled, false);
});
for (const [label, mutate] of [
  ["project switch", (f) => (f.context.project = { ...f.owner, id: "other" })],
  ["same owner reopened", (f) => f.context.projectOpenSequence++],
  ["draft changed", (f) => f.context.editVersion++],
  ["execution began", (f) => (f.context.busy = true)],
  ["save began", (f) => (f.context.saving = true)],
  ["tab switched", (f) => (f.context.planTab = "plans")],
  ["page switched", (f) => (f.context.page = "apis")],
  ["DOM replaced", (f) => (f.target.isConnected = false)],
  ["new lastRun", (f) => (f.context.lastRun = { id: "newer" })],
])
  test(`actual app handler rejects response after ${label}`, async () => {
    const f = fixture(),
      before = structuredClone(f.owner),
      result = f.run();
    mutate(f);
    f.resolve({ id: "p", runs: [] });
    await result;
    assert.deepEqual(f.owner, before);
    assert.equal(f.target.innerHTML, "old evidence");
    assert.equal(f.renders.length, 0);
  });
test("local lastRun retains precedence without changing saved receipt", async () => {
  const f = fixture();
  f.context.lastRun = { id: "same", status: "unknown", results: [] };
  const result = f.run();
  f.resolve({ id: "p", runs: [{ id: "same", status: "passed", results: [] }] });
  await result;
  assert.equal(f.renders[0].runs.length, 1);
  assert.equal(f.renders[0].runs[0].status, "unknown");
  assert.equal(f.owner.runs[0].status, "passed");
});
test("render failure cannot replace cached runs or existing DOM", async () => {
  const f = fixture(),
    before = structuredClone(f.owner);
  f.context.renderRuns = () => {
    throw Error("invalid nested evidence");
  };
  const result = f.run();
  f.resolve({ id: "p", runs: [{ id: "bad", results: [null] }] });
  await result;
  assert.deepEqual(f.owner, before);
  assert.equal(f.target.innerHTML, "old evidence");
  assert.match(f.status.textContent, /invalid nested/);
});
test("export chooses the same local lastRun shown by the renderer", () => {
  const a = source.indexOf("  const bindRunExports =");
  const b = source.indexOf('  on("#refresh-plan-history",', a);
  let handler, exported;
  const local = { id: "same", status: "unknown", results: [] };
  const saved = { id: "same", status: "passed", results: [] };
  const context = vm.createContext({
    lastRun: local,
    project: { runs: [saved] },
    on: (_selector, _event, fn) => (handler = fn),
    download: (_name, value) => (exported = value),
  });
  vm.runInContext(source.slice(a, b), context);
  handler(null, { dataset: { exportRun: "same" } });
  assert.equal(exported, local);
});
test("actual refresh fallback focuses only after button is re-enabled", async () => {
  const f = fixture(),
    active = { closest: () => null };
  f.context.document.activeElement = active;
  f.target.contains = (element) => element === active;
  f.target.querySelectorAll = () => [];
  let focused = 0;
  f.button.focus = (options) => {
    assert.equal(f.button.disabled, false);
    assert.deepEqual(options, { preventScroll: true });
    focused++;
  };
  const result = f.run();
  f.resolve({ id: "p", runs: [] });
  await result;
  assert.equal(focused, 1);
});
test("failed receipt does not move existing record focus", async () => {
  const f = fixture(),
    active = { closest: () => null };
  f.context.document.activeElement = active;
  f.target.contains = () => true;
  f.button.focus = () => assert.fail("failed read must not focus");
  const result = f.run();
  f.resolve({ id: "other", runs: [] });
  await result;
  assert.equal(f.target.innerHTML, "old evidence");
});
