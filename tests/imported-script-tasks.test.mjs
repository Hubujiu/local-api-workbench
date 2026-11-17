import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeImportedScriptTasks,
  importedScriptTasksHTML,
} from "../public/imported-script-tasks.js";
import { normalizeRequest } from "../src/core.mjs";
const task = {
  type: "customScript",
  id: "original",
  name: "Original",
  enabled: -1,
  data: "throw Error('disabled')",
};
const source = () => ({ version: 1, before: [{ ...task }], after: [] });

test("task provenance is preserved as inert source, independently of the editable program", () => {
  const original = source();
  const request = normalizeRequest({
    url: "https://example.test",
    beforeScript: "edited()",
    importedScriptTasks: original,
  });
  assert.equal(request.beforeScript, "edited()");
  assert.deepEqual(request.importedScriptTasks, original);
  request.importedScriptTasks.before[0].data = "changed-copy";
  assert.equal(original.before[0].data, task.data);
  const html = importedScriptTasksHTML({
    version: 1,
    before: [{ ...task, data: "</pre><img src=x onerror=alert(1)>" }],
    after: [],
  });
  assert.match(html, /只读/);
  assert.match(html, /不参与执行/);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
});

test("task provenance validates states, total source size and array/object shapes without invoking accessors", () => {
  for (const value of [
    { ...source(), version: 2 },
    { ...source(), extra: true },
    { ...source(), before: [{ ...task, enabled: true }] },
    { ...source(), before: [{ ...task, type: "database", data: {} }] },
    { ...source(), before: [{ ...task, data: "中".repeat(22000) }] },
    { ...source(), before: Array(2) },
    { ...source(), before: Array.from({ length: 17 }, () => ({ ...task })) },
  ])
    assert.throws(() => normalizeImportedScriptTasks(value));
  let called = false;
  const getter = source();
  Object.defineProperty(getter.before, "0", {
    enumerable: true,
    get() {
      called = true;
      return task;
    },
  });
  assert.throws(() => normalizeImportedScriptTasks(getter));
  assert.equal(called, false);
  const objectGetter = source();
  Object.defineProperty(objectGetter.before[0], "data", {
    enumerable: true,
    get() {
      called = true;
      return "x";
    },
  });
  assert.throws(() => normalizeImportedScriptTasks(objectGetter));
  assert.equal(called, false);
});

test("inert task scope origins survive validation and render escaped without accessor execution", () => {
  const value = source();
  value.before[0].origin = { scope: "folder", id: "<source>" };
  assert.deepEqual(normalizeImportedScriptTasks(value), value);
  assert.match(importedScriptTasksHTML(value), /目录:&lt;source&gt;/);
  for (const origin of [
    { scope: "unknown", id: "x" },
    { scope: "folder", id: "" },
    { scope: "folder", id: "x", extra: true },
  ]) {
    value.before[0].origin = origin;
    assert.throws(() => normalizeImportedScriptTasks(value));
  }
  let called = false;
  value.before[0].origin = {
    scope: "folder",
    get id() {
      called = true;
      return "x";
    },
  };
  assert.throws(() => normalizeImportedScriptTasks(value));
  assert.equal(called, false);
});
