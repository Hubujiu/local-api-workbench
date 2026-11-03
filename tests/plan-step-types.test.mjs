import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotPlan, restoreProject, runPlan } from "../src/core.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
const invalid = ["unsupported-step", "HTTP", "", null, false, 0, {}, []];
const leaf = (url, type) => ({
  id: "s",
  type,
  request: { method: "POST", url },
});
const backup = (steps) => ({
  version: 1,
  name: "backup",
  requests: [],
  environments: [],
  plans: [{ id: "p", steps }],
});
async function endpoint(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.method + " " + req.url);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { seen, url: `http://127.0.0.1:${server.address().port}/effect` };
}
test("snapshot and backup restore reject every unknown type without modifying input", () => {
  for (const type of invalid) {
    const plan = { steps: [leaf("http://127.0.0.1:1/never", type)] };
    const before = structuredClone(plan);
    assert.throws(() => snapshotPlan(plan), /步骤类型/);
    assert.throws(() => restoreProject(backup(plan.steps)), /步骤类型/);
    assert.deepEqual(plan, before);
  }
});
test("direct execution preflights the entire batch including disabled invalid leaves before real HTTP", async (t) => {
  const f = await endpoint(t);
  for (const type of invalid)
    for (const enabled of [true, false]) {
      const plan = {
        steps: [
          { ...leaf(f.url, undefined), id: "first" },
          { ...leaf(f.url, type), enabled },
        ],
      };
      await assert.rejects(runPlan(plan, {}, executeRequest), /步骤类型/);
      assert.deepEqual(f.seen, []);
    }
});
test("missing and explicit HTTP types retain real execution behavior", async (t) => {
  const f = await endpoint(t);
  for (const type of [undefined, "http"]) {
    const p = snapshotPlan({ steps: [leaf(f.url, type)] });
    const run = await runPlan(p, {}, executeRequest);
    assert.equal(run.status, "passed");
  }
  assert.deepEqual(f.seen, ["POST /effect", "POST /effect"]);
});
test("owner invalid save and restore leave durable project state unchanged and normal saved execution survives reopen", async (t) => {
  const f = await endpoint(t);
  const root = await mkdtemp(join(tmpdir(), "step-type-"));
  let app;
  t.after(async () => {
    try {
      if (app) {
        app.server.closeAllConnections();
        await new Promise((r) => app.server.close(r));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  app = await createApp({ root, port: 0 });
  const call = async (path, method = "GET", body) => {
    const r = await fetch(app.url + path, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const { data: p } = await call("/api/projects", "POST", {
    name: "type-test",
  });
  const before = await new Store(root).get(p.id);
  const listBefore = await call("/api/projects");
  for (const type of invalid) {
    const r = await call(`/api/projects/${p.id}/plans`, "POST", {
      steps: [leaf(f.url, type)],
    });
    assert.equal(r.status, 400, JSON.stringify(r));
    assert.match(r.data.error, /步骤类型/);
    const restored = await call(
      "/api/restore",
      "POST",
      backup([leaf(f.url, type)]),
    );
    assert.equal(restored.status, 400);
    assert.deepEqual(await new Store(root).get(p.id), before);
    assert.deepEqual(await call("/api/projects"), listBefore);
    assert.deepEqual(f.seen, []);
  }
  const saved = await call(`/api/projects/${p.id}/plans`, "POST", {
    steps: [leaf(f.url, "http")],
  });
  assert.equal(saved.status, 200);
  assert.equal((await new Store(root).get(p.id)).plans.length, 1);
  const run = await call(`/api/projects/${p.id}/run`, "POST", {
    planId: saved.data.id,
  });
  assert.equal(run.status, 200);
  assert.equal(run.data.status, "passed");
  assert.deepEqual(f.seen, ["POST /effect"]);
});
