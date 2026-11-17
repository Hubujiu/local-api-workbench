import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { writeProject } from "../src/project-files.mjs";
import { nativeInheritanceFixture } from "./fixtures/native-inheritance.mjs";
import { nativeDirectoryFixture } from "./fixtures/apipost-directory.mjs";

async function fixture(t, directory) {
  const root = await mkdtemp(join(tmpdir(), "native-append-legacy-"));
  const wire = [];
  const peer = http.createServer((req, res) => {
    wire.push(req.method + " " + req.url);
    res.end("ok");
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  let app;
  t.after(async () => {
    try {
      for (const server of [app?.server, peer].filter(Boolean)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const url = `http://127.0.0.1:${peer.address().port}/effect`;
  const store = new Store(root);
  const p = await store.create("legacy native graph");
  importIntoProject(
    p,
    directory
      ? nativeDirectoryFixture(nativeInheritanceFixture())
      : nativeInheritanceFixture(),
    { inheritanceMode: "preserve" },
  );
  await store.save(p);
  const disk = await store.get(p.id);
  const opaque = (id, type) => ({
    id,
    name: "Retain this inert legacy definition",
    steps: [{ id: "s", type, request: { method: "POST", url } }],
    legacyMetadata: { order: [2, 1], disabled: false },
  });
  disk.plans = [
    opaque("old-a", "unknown-a"),
    snapshotPlan({
      id: "valid",
      steps: [{ id: "valid-step", request: { method: "GET", url } }],
    }),
    opaque("old-b", "unknown-b"),
  ];
  disk.runs = [
    { id: "old-run", results: [], snapshot: structuredClone(disk.plans[0]) },
    { id: "null-snapshot", results: [], snapshot: null },
  ];
  // Model an already-persisted older version. Public saves must not create
  // unknown definitions, and this fixture does not claim they are executable.
  await writeProject(store.directory(p.id), disk);
  const before = await store.get(p.id);
  const source = nativeInheritanceFixture();
  source.apis[1].target_id = "added";
  source.apis[1].url = "/added";
  const input = {
    format: directory ? "apipost-directory" : "apipost",
    document: directory ? nativeDirectoryFixture(source) : source,
    selection: { mode: "all" },
  };
  app = await createApp({ root, port: 0 });
  const call = async (action, body) => {
    const response = await fetch(`${app.url}/api/projects/${p.id}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { root, store, p, before, input, wire, call };
}

for (const directory of [false, true]) {
  test(`signed ${directory ? "directory" : "JSON"} append preserves inert legacy plans and admits no execution`, async (t) => {
    const f = await fixture(t, directory);
    const preview = await f.call("import-preview", f.input);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.data.blockers, []);
    assert.equal(typeof preview.data.token, "string");
    assert.deepEqual(await f.store.get(f.p.id), f.before);
    assert.deepEqual(f.wire, []);
    await f.store.append(f.p.id, "history", { id: "new-activity" });
    const applied = await f.call("import-apply", {
      input: f.input,
      token: preview.data.token,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const saved = await new Store(f.root).get(f.p.id);
    assert.equal(saved.requests.length, f.before.requests.length + 1);
    assert.equal(saved.requests[0].id, f.before.requests[0].id);
    assert.deepEqual(saved.plans, f.before.plans);
    assert.deepEqual(saved.runs, f.before.runs);
    assert.equal(saved.history[0].id, "new-activity");
    assert.deepEqual(f.wire, []);
    for (const planId of ["old-a", "old-b"]) {
      const rejected = await f.call("run", { planId });
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /步骤类型/);
      assert.deepEqual(f.wire, []);
    }
    const valid = await f.call("run", { planId: "valid" });
    assert.equal(valid.status, 200, JSON.stringify(valid.data));
    assert.equal(valid.data.status, "passed");
    assert.equal(valid.data.recordSaved, true);
    assert.deepEqual(f.wire, ["GET /effect"]);
    const final = await new Store(f.root).get(f.p.id);
    assert.deepEqual(final.plans, f.before.plans);
    assert.deepEqual(final.runs.slice(1), f.before.runs);
  });
}

test("native append cannot authorize changed or duplicated opaque plans or stale configuration", async (t) => {
  const f = await fixture(t, false);
  const sessionId = "legacy-preservation";
  const preview = await f.store.previewManualImport(f.p.id, f.input, {
    sessionId,
  });
  assert.deepEqual(preview.blockers, []);
  for (const change of [
    (p) => (p.plans[0].name = "changed"),
    (p) => p.plans.push(structuredClone(p.plans[0])),
    (p) => p.plans.push({ ...structuredClone(p.plans[0]), id: "new" }),
  ]) {
    const forged = await f.store.get(f.p.id);
    change(forged);
    await assert.rejects(
      f.store.save(forged, {
        nativeAppend: { source: forged, context: {} },
      }),
      /步骤类型/,
    );
    assert.deepEqual(await f.store.get(f.p.id), f.before);
  }
  const newer = await f.store.get(f.p.id);
  newer.name = "newer configuration";
  await f.store.save(newer);
  const disk = await f.store.get(f.p.id);
  await assert.rejects(
    f.store.applyManualImport(
      f.p.id,
      { input: f.input, token: preview.token },
      { sessionId },
    ),
  );
  assert.deepEqual(await new Store(f.root).get(f.p.id), disk);
  assert.deepEqual(f.wire, []);
});

test("native append normalizes a sparse legacy plan once, with durable identities", async (t) => {
  const f = await fixture(t, false);
  const disk = await f.store.get(f.p.id);
  const request = disk.plans[1].steps[0].request;
  disk.plans = [
    {
      id: "sparse",
      steps: [{ request: { method: request.method, url: request.url } }],
    },
  ];
  await writeProject(f.store.directory(f.p.id), disk);
  const before = await f.store.get(f.p.id);
  const preview = await f.call("import-preview", f.input);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.blockers, []);
  assert.deepEqual(await f.store.get(f.p.id), before);
  const applied = await f.call("import-apply", {
    input: f.input,
    token: preview.data.token,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const saved = await new Store(f.root).get(f.p.id);
  assert.equal(saved.plans.length, 1);
  const plan = saved.plans[0];
  assert.equal(plan.id, "sparse");
  assert.ok(plan.steps[0].id);
  assert.ok(plan.steps[0].request.id);
  assert.ok(plan.createdAt);
  assert.equal(plan.steps[0].request.method, request.method);
  assert.equal(plan.steps[0].request.url, request.url);
  assert.deepEqual(f.wire, []);
  await f.store.save(saved);
  assert.deepEqual((await new Store(f.root).get(f.p.id)).plans, [plan]);
  const result = await f.call("run", { planId: "sparse" });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.status, "passed");
  assert.equal(result.data.recordSaved, true);
  assert.deepEqual(f.wire, ["GET /effect"]);
  assert.deepEqual((await new Store(f.root).get(f.p.id)).plans, [plan]);
});
