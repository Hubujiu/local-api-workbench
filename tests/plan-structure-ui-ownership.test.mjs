import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const code = source.slice(
  source.indexOf('  on("#edit-plan-structure"'),
  source.indexOf('  on("#add-step"'),
);
function harness() {
  const p = { id: "p", steps: [] },
    project = {
      id: "a",
      revision: 1,
      configRevision: 1,
      plans: [p],
      requests: [],
    };
  const dialog = { open: true };
  let open,
    save,
    options,
    saves = 0,
    previews = 0;
  const env = {
    project,
    planId: "p",
    editVersion: 3,
    modalRevision: 0,
    assertExecutionReady() {},
    on(selector, event, fn) {
      open = fn;
    },
    modal(title, html, fn) {
      save = fn;
      env.modalRevision++;
    },
    planStructureEditor() {
      return "";
    },
    bindPlanStructureEditor(container, plan, opts) {
      options = opts;
      return () => {
        opts.assertCurrent();
        return structuredClone(plan);
      };
    },
    $(s) {
      return s === "#dialog" ? dialog : {};
    },
    savePlan: async () => {
      saves++;
    },
    api: async () => {
      previews++;
      return { valid: true, project_id: "a", projectConfigRevision: 1 };
    },
  };
  new Function("env", `with(env){${code}}`)(env);
  open();
  return {
    env,
    dialog,
    get options() {
      return options;
    },
    save: () => save(),
    get saves() {
      return saves;
    },
    get previews() {
      return previews;
    },
  };
}
for (const [label, mutate] of Object.entries({
  project: (h) => (h.env.project = { ...h.env.project }),
  selection: (h) => (h.env.planId = "other"),
  edit: (h) => h.env.editVersion++,
  planReplacement: (h) => (h.env.project.plans = [{ id: "p", steps: [] }]),
  closed: (h) => (h.dialog.open = false),
  newerModal: (h) => h.env.modalRevision++,
}))
  test(`actual structure modal refuses ${label} before save or preview`, async () => {
    const h = harness();
    mutate(h);
    await assert.rejects(async () => h.save(), /已变化/);
    await assert.rejects(
      () => h.options.preview({ id: "p", steps: [] }),
      /已变化/,
    );
    assert.equal(h.saves, 0);
    assert.equal(h.previews, 0);
  });
test("actual structure modal rejects late preview after project replacement", async () => {
  const h = harness();
  let release;
  const wait = new Promise((r) => (release = r));
  h.env.api = () => wait;
  const pending = h.options.preview({ id: "p", steps: [] });
  h.env.project = { ...h.env.project };
  release({ valid: true, project_id: "a", projectConfigRevision: 1 });
  await assert.rejects(() => pending, /已变化/);
  assert.equal(h.saves, 0);
});
for (const receipt of [
  { valid: true, project_id: "b", projectConfigRevision: 1 },
  { valid: true, project_id: "a", projectConfigRevision: 2 },
  { valid: false, project_id: "a", projectConfigRevision: 1 },
])
  test(
    "actual structure preview refuses mismatched receipt " +
      JSON.stringify(receipt),
    async () => {
      const h = harness();
      h.env.api = async () => receipt;
      await assert.rejects(
        () => h.options.preview({ id: "p", steps: [] }),
        /回执不匹配/,
      );
      assert.equal(h.saves, 0);
    },
  );
test("actual valid structure modal submits only on explicit save", async () => {
  const h = harness();
  await h.options.preview({ id: "p", steps: [] });
  assert.equal(h.saves, 0);
  await h.save();
  assert.equal(h.saves, 1);
});
