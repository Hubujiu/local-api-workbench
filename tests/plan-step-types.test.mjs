import { createMCP } from "../src/mcp.mjs";
import { writeProject } from "../src/project-files.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
    const put = await call(`/api/projects/${p.id}`, "PUT", {
      ...before,
      plans: [{ id: "bad", steps: [leaf(f.url, type)] }],
    });
    assert.equal(put.status, 400);
    assert.deepEqual(await new Store(root).get(p.id), before);
    assert.deepEqual(await call("/api/projects"), listBefore);
    assert.deepEqual(f.seen, []);
  }
  const saved = await call(`/api/projects/${p.id}/plans`, "POST", {
    steps: [leaf(f.url, "http")],
  });
  assert.equal(saved.status, 200);
  assert.equal((await new Store(root).get(p.id)).plans.length, 1);
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  const run = await call(`/api/projects/${p.id}/run`, "POST", {
    planId: saved.data.id,
  });
  assert.equal(run.status, 200);
  assert.equal(run.data.status, "passed");
  assert.deepEqual(f.seen, ["POST /effect"]);
});

test("backup validates historical snapshots before retention without rewriting valid evidence", () => {
  const input = backup([]);
  input.runs = Array.from({ length: 51 }, (_, i) => ({
    id: `run-${i}`,
    results: [],
    snapshot: {
      steps: [
        leaf("http://127.0.0.1:1/never", i === 50 ? "invalid" : undefined),
      ],
    },
  }));
  const before = structuredClone(input);
  assert.throws(() => restoreProject(input), /步骤类型/);
  assert.deepEqual(input, before);
  input.runs[50].snapshot.steps[0].type = "http";
  const restored = restoreProject(input);
  assert.equal(restored.runs.length, 50);
  assert.deepEqual(restored.runs, input.runs.slice(0, 50));
});
test("type getters and proxies reject before invocation or execution", async () => {
  for (const position of ["array", "row", "type"]) {
    let calls = 0;
    let steps = [leaf("http://127.0.0.1:1/never", undefined)];
    const trap = () => {
      calls++;
      throw Error("must not run");
    };
    if (position === "array") steps = new Proxy(steps, { get: trap });
    else if (position === "row")
      steps[0] = new Proxy(steps[0], { get: trap, getPrototypeOf: trap });
    else
      Object.defineProperty(steps[0], "type", { enumerable: true, get: trap });
    assert.throws(() => snapshotPlan({ steps }), /步骤类型/);
    await assert.rejects(
      runPlan({ steps }, {}, () => {
        throw Error("must not execute");
      }),
      /步骤类型/,
    );
    assert.equal(calls, 0);
  }
});

test("MCP refuses invalid plans and explicit owner replacement can repair a legacy malformed plan", async (t) => {
  const f = await endpoint(t);
  const root = await mkdtemp(join(tmpdir(), "step-type-repair-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    try {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const project = await app.store.create("repair");
  const before = await app.store.get(project.id);
  const dispatch = createMCP({
    store: app.store,
    projects: [project.id],
    write: true,
    execute: true,
  });
  const result = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "localapi_save_plan",
      arguments: {
        projectId: project.id,
        plan: { steps: [leaf(f.url, "unknown")] },
      },
    },
  });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /步骤类型/);
  assert.deepEqual(await app.store.get(project.id), before);
  // Simulate a pre-existing malformed disk definition without admitting it through Store.save.
  const legacy = { id: "legacy", steps: [leaf(f.url, "unknown")] };
  project.plans = [legacy];
  await writeProject(app.store.directory(project.id), project);
  assert.throws(
    () => versionPlan(legacy, { ...legacy, steps: [leaf(f.url, "http")] }),
    /步骤类型/,
  );
  const child = spawn(
    process.execPath,
    [
      "scripts/run-plan.mjs",
      "--project",
      project.id,
      "--plan",
      "legacy",
      "--credentials-stdin",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [code] = await exited;
    assert.equal(code, 2);
    assert.match(stderr, /步骤类型/);
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
  const current = await app.store.get(project.id);
  current.plans = [{ ...legacy, steps: [leaf(f.url, "http")] }];
  const response = await fetch(app.url + `/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify(current),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /步骤类型/);
  assert.equal(
    (await app.store.get(project.id)).plans[0].steps[0].type,
    "unknown",
  );
  current.plans[0].id = "explicit-replacement";
  const replacement = await fetch(app.url + `/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify(current),
  });
  assert.equal(replacement.status, 200, await replacement.text());
  assert.equal(
    (await new Store(root).get(project.id)).plans[0].steps[0].request.url,
    f.url,
  );
  assert.deepEqual(f.seen, []);
});

test("unrelated valid execution retains evidence alongside inert legacy history and an unchanged invalid plan", async (t) => {
  const f = await endpoint(t);
  const root = await mkdtemp(join(tmpdir(), "step-type-legacy-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    try {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const p = await app.store.create("legacy");
  p.plans = [
    { id: "bad", steps: [leaf(f.url, "unknown")] },
    snapshotPlan({ id: "good", steps: [leaf(f.url, "http")] }),
  ];
  p.runs = [
    { id: "null", results: [], snapshot: null },
    { id: "missing", results: [], snapshot: {} },
    {
      id: "old-unknown",
      results: [],
      snapshot: { steps: [leaf(f.url, "unknown")] },
    },
  ];
  await writeProject(app.store.directory(p.id), p);
  const diskBefore = await app.store.get(p.id);
  const response = await fetch(app.url + `/api/projects/${p.id}/run`, {
    method: "POST",
    headers: { "x-local-token": app.token, "content-type": "application/json" },
    body: JSON.stringify({ planId: "good" }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(f.seen, ["POST /effect"]);
  assert.equal(result.status, "passed");
  assert.equal(
    result.recordSaved,
    true,
    JSON.stringify(result.persistenceError),
  );
  const saved = await new Store(root).get(p.id);
  assert.deepEqual(saved.plans, diskBefore.plans);
  assert.deepEqual(saved.runs.slice(1), diskBefore.runs);
  for (const activity of [false, true]) {
    const changed = await app.store.get(p.id);
    changed.plans[0].name = "changed";
    await assert.rejects(app.store.save(changed, { activity }), /步骤类型/);
    const added = await app.store.get(p.id);
    added.plans.push({ ...structuredClone(added.plans[0]), id: "new-bad" });
    await assert.rejects(app.store.save(added, { activity }), /步骤类型/);
  }
  for (const position of ["type", "nested", "row"]) {
    for (const activity of [false, true]) {
      const injected = await app.store.get(p.id);
      let calls = 0;
      if (position === "row")
        injected.plans[0] = new Proxy(injected.plans[0], {
          get() {
            calls++;
            throw Error("trap");
          },
          getPrototypeOf() {
            calls++;
            throw Error("trap");
          },
        });
      else {
        const object =
          position === "type"
            ? injected.plans[0].steps[0]
            : injected.plans[0].steps[0].request;
        const key = position === "type" ? "type" : "url";
        const value = object[key];
        Object.defineProperty(object, key, {
          enumerable: true,
          get() {
            calls++;
            return value;
          },
        });
      }
      await assert.rejects(app.store.save(injected, { activity }));
      assert.equal(calls, 0, position);
    }
  }
  const duplicated = await app.store.get(p.id);
  duplicated.plans.push(structuredClone(duplicated.plans[0]));
  await assert.rejects(app.store.save(duplicated), /步骤类型/);
  const stale = await app.store.get(p.id);
  const updated = await app.store.get(p.id);
  updated.name = "unrelated config update";
  await app.store.save(updated);
  await assert.rejects(app.store.save(stale, { activity: true }), /其他窗口/);
  assert.deepEqual((await app.store.get(p.id)).plans, diskBefore.plans);
});
test("backup null and absent historical snapshots remain inert and unmodified", () => {
  const p = backup([]);
  p.runs = [
    { id: "n", results: [], snapshot: null },
    { id: "a", results: [] },
    { id: "e", results: [], snapshot: {} },
  ];
  assert.deepEqual(restoreProject(p).runs, p.runs);
});
