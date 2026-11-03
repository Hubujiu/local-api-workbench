import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, normalizeRequest } from "../src/core.mjs";
import { writeProject } from "../src/project-files.mjs";
import { deleteAPIResources } from "../src/api-resource-lifecycle.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "plan-type-lifecycle-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    try {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const call = async (id, action, body) => {
    const r = await fetch(`${app.url}/api/projects/${id}/${action}`, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  return { app, root, call };
}
async function inject(app, p) {
  const disk = await app.store.get(p.id);
  disk.plans.push({
    id: "opaque-bad",
    steps: [
      {
        id: "s",
        type: "unknown",
        request: { method: "GET", url: "http://127.0.0.1:1/never" },
      },
    ],
  });
  await writeProject(app.store.directory(p.id), disk);
  return app.store.get(p.id);
}
test("owner native folder lifecycle retains unchanged bad plans without weakening graph identity", async (t) => {
  const f = await fixture(t);
  const p = await f.app.store.create("graph");
  importIntoProject(p, nativeInheritanceFixture(), {
    inheritanceMode: "preserve",
  });
  await f.app.store.save(p);
  const before = await inject(f.app, p);
  const folder = before.settings.nativeInheritance.folders[0];
  const result = await f.call(p.id, "native-inheritance-edit", {
    configRevision: before.configRevision,
    operation: {
      type: "move-folder",
      sourceId: folder.sourceId,
      parentId: "0",
      name: "Renamed",
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.plans, before.plans);
  assert.equal(
    result.data.settings.nativeInheritance.folders[0].sourceId,
    folder.sourceId,
  );
  assert.equal(
    result.data.settings.nativeInheritance.folders[0].path,
    "Renamed",
  );
  const tampered = await f.app.store.get(p.id);
  tampered.settings.nativeInheritance.folders[0].sourceId = "forged";
  await assert.rejects(f.app.store.save(tampered));
  assert.deepEqual((await new Store(f.root).get(p.id)).plans, before.plans);
});
test("owner resource restore retains unchanged bad plans and still enforces trash identity", async (t) => {
  const f = await fixture(t);
  const p = await f.app.store.create("resources");
  p.requests = [
    normalizeRequest({
      id: "api",
      method: "GET",
      url: "http://127.0.0.1:1/never",
    }),
  ];
  await f.app.store.save(p);
  const before = await inject(f.app, p);
  const candidate = await f.app.store.get(p.id);
  const deletion = deleteAPIResources(candidate, ["api"]);
  await f.app.store.save(deletion.project);
  const deleted = await f.app.store.get(p.id);
  const batchId = deleted.apiResourceTrash.batches.at(-1).id;
  const result = await f.call(p.id, "api-resource-restore", {
    configRevision: deleted.configRevision,
    batchId,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.requests.length, 1);
  assert.deepEqual(result.data.plans, before.plans);
  const tampered = await f.app.store.get(p.id);
  tampered.apiResourceTrash.batches = [];
  await assert.rejects(f.app.store.save(tampered));
  const after = await new Store(f.root).get(p.id);
  assert.deepEqual(after.plans, before.plans);
  assert.equal(after.requests[0].id, "api");
});
