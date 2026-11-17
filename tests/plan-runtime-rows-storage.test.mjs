import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/runtime.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { runPlan, importIntoProject, restoreProject } from "../src/core.mjs";
import { writeProject } from "../src/project-files.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";

const definition = () => ({
  id: "dynamic",
  name: "runtime rows",
  steps: [
    {
      id: "rows",
      type: "repeat",
      rowsFrom: { scope: "runtime", name: "items" },
      maxRows: 3,
      maxRowBytes: 1024,
      intervalMs: 0,
      steps: [
        {
          id: "leaf",
          liveRequestId: "api",
          request: { url: "http://example.invalid/" },
        },
      ],
    },
  ],
});
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t, native = false) {
  const root = await mkdtemp(join(tmpdir(), "runtime-rows-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const project = await store.create("rows");
  if (native)
    importIntoProject(project, nativeInheritanceFixture(), {
      inheritanceMode: "preserve",
    });
  else
    project.requests.push({
      id: "api",
      name: "API",
      url: "http://example.invalid/",
    });
  const input = definition();
  input.steps[0].steps[0].liveRequestId = project.requests[0].id;
  project.plans = [versionPlan(undefined, input, "manual", project)];
  await store.save(project);
  return { root, store, project: await store.get(project.id) };
}

for (const native of [false, true])
  test(`runtime rows definitions and history survive real Store restart/backup/restore (native=${native})`, async (t) => {
    const { root, store, project } = await fixture(t, native);
    const plan = project.plans[0];
    assert.deepEqual(versionPlan(plan, plan, "manual", project), plan);
    const changed = structuredClone(plan);
    changed.steps[0].maxRows = 2;
    assert.notEqual(
      hash(versionPlan(plan, changed, "manual", project)),
      hash(plan),
    );
    const executable = structuredClone(plan);
    delete executable.steps[0].steps[0].liveRequestId;
    let calls = 0;
    await assert.rejects(
      runPlan(executable, {}, async () => {
        calls++;
      }),
      /尚未启用/,
    );
    assert.equal(calls, 0);
    // Explicit internal opt-in only, never a public execution entry. Actual Store
    // history writes exercise the same record used by execution persistence.
    const run = await runPlan(
      executable,
      {},
      async () => ({ status: 200, headers: {}, body: "ok", duration: 0 }),
      {
        allowRuntimeRows: true,
        variableScopes: {
          runtime: { items: [{ privateUnused: "row-secret-not-for-storage" }] },
        },
      },
    );
    assert.equal(run.planHash, hash(run.snapshot));
    assert.equal(
      JSON.stringify(run.snapshot).includes("row-secret-not-for-storage"),
      false,
    );
    await store.append(project.id, "runs", run);
    const reopened = await new Store(root).get(project.id);
    assert.deepEqual(reopened.plans, project.plans);
    assert.deepEqual(reopened.runs[0], JSON.parse(JSON.stringify(run)));
    // Backup transport is the full JSON project document, including history.
    const backup = JSON.stringify(reopened);
    const restored = await new Store(root).restore(backup);
    const restoredDisk = await new Store(root).get(restored.id);
    assert.notEqual(restored.id, project.id);
    assert.deepEqual(restoredDisk.plans, reopened.plans);
    assert.deepEqual(restoredDisk.runs, reopened.runs);
    assert.equal(
      restoredDisk.runs[0].planHash,
      hash(restoredDisk.runs[0].snapshot),
    );
    assert.equal(
      restoredDisk.plans[0].steps[0].steps[0].liveRequestId,
      project.requests[0].id,
    );
    // Existing variable evidence remains lossless. Only definitions/snapshots
    // and control metadata must not introduce copies of the actual input rows.
    assert.equal(
      restoredDisk.runs[0].variables.items[0].privateUnused,
      "row-secret-not-for-storage",
    );
    assert.equal(
      JSON.stringify(restoredDisk.plans).includes("row-secret-not-for-storage"),
      false,
    );
    assert.equal(
      JSON.stringify(
        restoredDisk.runs[0].results.map((r) => r.repeat),
      ).includes("row-secret-not-for-storage"),
      false,
    );
    if (native) {
      const folder = restoredDisk.settings.nativeInheritance.folders[0];
      await store.editNativeInheritance(restored.id, {
        configRevision: restoredDisk.configRevision,
        operation: {
          type: "move-folder",
          sourceId: folder.sourceId,
          parentId: "0",
          name: "Renamed",
        },
      });
      assert.deepEqual((await store.get(restored.id)).plans, reopened.plans);
    }
  });

const corruptions = [
  (group) => {
    group.maxRows = 0;
  },
  (group) => {
    group.rows = [{ secret: "must-not-appear" }];
  },
  (group) => {
    group.rowsFrom.scope = "environment";
  },
  (group) => {
    group.steps[0].type = "unknown";
  },
  (group) => {
    group.steps[0] = { id: "protocol", type: "protocol", enabled: false };
  },
];
for (const [index, corrupt] of corruptions.entries())
  test(`malformed runtime rows rejected in version/save/history/restore/disk #${index}`, async (t) => {
    const { root, store, project } = await fixture(t);
    const bad = structuredClone(project.plans[0]);
    corrupt(bad.steps[0]);
    assert.throws(() => versionPlan(project.plans[0], bad, "manual", project));
    const candidate = structuredClone(project);
    candidate.plans = [bad];
    await assert.rejects(store.save(candidate));
    assert.deepEqual((await store.get(project.id)).plans, project.plans);
    const run = { id: "bad-run", results: [], snapshot: bad };
    await assert.rejects(store.append(project.id, "runs", run));
    await assert.rejects(store.restore({ ...project, runs: [run] }));
    await assert.rejects(store.restore(candidate));
    // Even records beyond restore retention must be inspected before truncation.
    await assert.rejects(
      store.restore({
        ...project,
        runs: [
          ...Array.from({ length: 50 }, (_, i) => ({
            id: `old-${i}`,
            results: [],
          })),
          run,
        ],
      }),
    );
    await writeProject(store.directory(project.id), {
      ...project,
      runs: [run],
    });
    await assert.rejects(new Store(root).get(project.id));
    await writeProject(store.directory(project.id), candidate);
    await assert.rejects(new Store(root).get(project.id));
  });

test("legacy single-file runtime rows validate on read, without rewriting", async (t) => {
  const { root, store, project } = await fixture(t);
  await rm(store.directory(project.id), { recursive: true });
  const file = join(store.base(project.id), project.id + ".json");
  const text = JSON.stringify(project);
  await writeFile(file, text);
  assert.deepEqual(
    (await new Store(root).get(project.id)).plans,
    project.plans,
  );
  assert.equal(await readFile(file, "utf8"), text);
  project.plans[0].steps[0].maxRows = -1;
  await writeFile(file, JSON.stringify(project));
  await assert.rejects(new Store(root).get(project.id));
});

test("runtime history and stored definitions cannot manufacture missing identities on read", async (t) => {
  const { root, store, project } = await fixture(t);
  const snapshot = structuredClone(project.plans[0]);
  delete snapshot.steps[0].id;
  const run = { id: "missing-identity", results: [], snapshot };
  await assert.rejects(store.append(project.id, "runs", run), /ID/);
  await assert.rejects(store.restore({ ...project, runs: [run] }), /ID/);
  await writeProject(store.directory(project.id), {
    ...project,
    plans: [snapshot],
  });
  await assert.rejects(new Store(root).get(project.id), /ID/);
});

test("linear restore keeps live-reference diagnostics before cloning in definitions and history", () => {
  for (const history of [false, true])
    for (const hidden of [false, true]) {
      let reads = 0;
      const step = { id: "leaf", request: { url: "http://example.invalid" } };
      Object.defineProperty(
        step,
        "liveRequestId",
        hidden
          ? { value: "api" }
          : {
              enumerable: true,
              get() {
                reads++;
                return "api";
              },
            },
      );
      const plan = { id: "plan", steps: [step] };
      const backup = {
        version: 1,
        requests: [],
        environments: [],
        plans: history ? [] : [plan],
        runs: history ? [{ id: "run", results: [], snapshot: plan }] : [],
      };
      assert.throws(() => restoreProject(backup), /实时计划引用/);
      assert.equal(reads, 0);
    }
});

test("runtime control graph restore still rejects hidden/accessor hooks without invoking them", () => {
  for (const history of [false, true]) {
    let reads = 0;
    const plan = definition();
    Object.defineProperty(plan.steps[0].rowsFrom, "name", {
      enumerable: true,
      get() {
        reads++;
        return "items";
      },
    });
    const backup = {
      version: 1,
      requests: [],
      environments: [],
      plans: history ? [] : [plan],
      runs: history ? [{ id: "run", results: [], snapshot: plan }] : [],
    };
    assert.throws(() => restoreProject(backup), /访问器/);
    assert.equal(reads, 0);
  }
});
