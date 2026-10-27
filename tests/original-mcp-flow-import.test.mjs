import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";
const flowPath = "executions/flows/flow_1792937049044.json";
const indexPath = "executions/flows/index.json";
async function source() {
  const files = [];
  for (const [directory, prefix] of [
    ["directory/", ""],
    ["executions/", "executions/"],
  ]) {
    const root = new URL(
      "./fixtures/original-offline2/" + directory,
      import.meta.url,
    );
    for (const file of (await readdir(root, { recursive: true })).filter((p) =>
      p.endsWith(".json"),
    )) {
      const p = file.replaceAll("\\", "/");
      files.push({
        path: prefix + p,
        text: await readFile(new URL(p, root), "utf8"),
      });
    }
  }
  return { format: "apipost-offline-directory-v1", files };
}
function changeFile(document, path, change) {
  const file = document.files.find((f) => f.path === path),
    value = JSON.parse(file.text);
  change(value);
  file.text = JSON.stringify(value);
}
async function mcpSource(port = 18766) {
  const document = await source();
  changeFile(document, "envs/1.json", (env) => {
    env.env_var_list.native_value.value = "wrong-historical-environment";
  });
  const env = JSON.parse(
    document.files.find((f) => f.path === "envs/1.json").text,
  );
  env.env_id = "2";
  env.name = "Current environment";
  env.env_var_list.native_value.value = "actual-environment";
  document.files.push({ path: "envs/2.json", text: JSON.stringify(env) });
  changeFile(document, "envs/index.json", (index) =>
    index.items.push({ env_id: "2", name: env.name }),
  );
  changeFile(document, indexPath, (index) => {
    index.records[0].source = "mcp";
    index.records[0].environment_id = "2";
  });
  changeFile(document, flowPath, (flow) => {
    flow.source = "mcp";
    flow.environment_id = "2";
    flow.mcp_name = "{{not_expanded}}";
    flow.mcp_description = "Older AI description";
    flow.mcp_environment_id = "1";
    for (const step of flow.steps)
      step.api_snapshot.url = `http://127.0.0.1:${port}/echo?fixture=original`;
    const first = flow.steps[0];
    first.api_snapshot.request.body.raw = JSON.stringify({
      keep: "snapshot",
      obsolete: "must-not-return",
    });
    first.input = {
      body: { keep: "manual-current", value: "{{native_value}}" },
      query: { fixture: "current-query" },
    };
    first.mcp_input = {
      body: { keep: "old-AI", obsolete: "{{not_expanded}}" },
      query: { fixture: "old-query" },
      headers: { "old-header": "literal {{not_expanded}}" },
      auth: { type: "noauth" },
    };
    first.mcp_deleted_body_keys = ["keep", "../outside", "nested.path"];
    first.pre_script = 'console.log("current-step");';
    first.post_script = 'apt.environment.set("native_after", "current-post");';
    flow.steps[1].input = { body: { second: "{{native_value}}" } };
    flow.steps[1].mcp_input = {};
    flow.steps[1].mcp_deleted_body_keys = [];
  });
  return document;
}
function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-plan.mjs", "--project", projectId, "--plan", planId],
      {
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("native MCP CLI timed out"));
    }, 15000);
    child.on("error", reject);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
async function echo(t, status = []) {
  const seen = [],
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: req.url, body, oldHeader: req.headers["old-header"] });
      res.writeHead(status.shift() ?? 200, {
        "content-type": "application/json",
      });
      res.end("{}");
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { seen, port: server.address().port };
}

test("synthetic MCP saved-flow CLI uses current input/environment, continues 503, persists entry-origin and survives backup/restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wire = await echo(t, [503, 200]),
    document = await mcpSource(wire.port),
    original = JSON.stringify(document);
  const store = new Store(root),
    p = await store.create("MCP migration"),
    other = await store.create("isolated"),
    otherBefore = await store.get(other.id);
  importIntoProject(p, document);
  assert.equal(JSON.stringify(document), original);
  assert.equal(wire.seen.length, 0);
  assert.equal(p.runs.length, 0);
  const plan = p.plans[0],
    history = structuredClone(plan.importedNativeFlowSource);
  assert.equal(plan.source, "ai");
  assert.equal(history.source, "mcp");
  assert.equal(history.steps[0].importedStepId, plan.steps[0].id);
  assert.equal(history.steps[1].importedStepId, plan.steps[1].id);
  assert.notEqual(plan.steps[0].id, plan.steps[1].id);
  assert.deepEqual(history.steps[1].mcp_deleted_body_keys, []);
  assert.equal(history.mcp_environment_id, "1");
  assert.equal(
    plan.steps.some((step) => step.nativeMCP || step.request.nativeTasks),
    false,
  );
  assert.match(
    plan.steps[0].request.importedScriptTasks.before[0].data,
    /from-before/,
  );
  p.requests[0].url = "https://edited-live-api.invalid";
  p.requests[0].body = "edited-live-body";
  await store.save(p);
  const result = await cli(root, p.id, plan.id);
  assert.equal(result.code, 1, result.stderr);
  const run = JSON.parse(result.stdout);
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results.map((s) => s.response.status),
    [503, 200],
  );
  assert.deepEqual(
    wire.seen.map(({ path, body }) => ({ path, body: JSON.parse(body) })),
    [
      {
        path: "/echo?fixture=current-query",
        body: { keep: "manual-current", value: "actual-environment" },
      },
      {
        path: "/echo?fixture=original",
        body: { second: "actual-environment" },
      },
    ],
  );
  assert.equal(
    wire.seen.some((r) => r.oldHeader),
    false,
  );
  assert.deepEqual(run.results[0].logs.map((l) => l.message).filter(Boolean), [
    "current-step",
  ]);
  assert.equal(run.variables.native_after, "current-post");
  assert.deepEqual(run.snapshot.importedNativeFlowSource, history);
  const saved = await new Store(root).get(p.id);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].source, "cli");
  assert.equal(
    saved.environments.find((e) => e.id === plan.environmentId).variables
      .native_after,
    "current-post",
  );
  assert.equal(
    saved.environments.find(
      (e) => e.variables.native_value === "wrong-historical-environment",
    ).variables.native_after,
    "",
  );
  assert.deepEqual(saved.plans[0].importedNativeFlowSource, history);
  assert.deepEqual(await store.get(other.id), otherBefore);
  const restored = restoreProject(JSON.stringify(saved));
  await store.save(restored);
  const again = await cli(root, restored.id, plan.id);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).status, "passed");
  const restarted = await new Store(root).get(restored.id);
  assert.equal(restarted.runs.length, 2);
  assert.deepEqual(restarted.plans[0].importedNativeFlowSource, history);
  assert.deepEqual(
    restarted.settings.apipostDirectoryArtifacts,
    saved.settings.apipostDirectoryArtifacts,
  );
  assert.equal(wire.seen.length, 4);
  assert.deepEqual(wire.seen.slice(2), wire.seen.slice(0, 2));
});

test("native MCP import rejects unsafe/unknown baselines, missing actual environment and inconsistent indexes atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("unchanged"),
    original = structuredClone(p);
  for (const change of [
    (f) => delete f.environment_id,
    (f) => (f.environment_id = ""),
    (f) => (f.environment_id = "missing"),
    (f) => (f.mcp_name = {}),
    (f) => (f.mcp_description = "\ud800"),
    (f) => (f.mcp_environment_id = 1),
    (f) =>
      (f.steps[0].mcp_input = {
        auth: { type: "bearer", bearer: { key: "never-retain" } },
      }),
    (f) => (f.steps[0].mcp_input = { target_id: "other" }),
    (f) => (f.steps[0].mcp_input = { file: "/never-read" }),
    (f) => (f.steps[0].mcp_input = { body: "x".repeat(65536) }),
    (f) => (f.steps[0].mcp_deleted_body_keys = [null]),
    (f) => (f.steps[0].mcp_deleted_body_keys = Array(1001).fill("key")),
    (f) => (f.steps[0].step_id = f.steps[1].step_id),
  ]) {
    const document = await mcpSource();
    changeFile(document, flowPath, change);
    assert.throws(() => importIntoProject(p, document));
    assert.deepEqual(p, original);
  }
  const mismatch = await mcpSource();
  changeFile(mismatch, indexPath, (x) => (x.records[0].source = "manual"));
  assert.throws(() => importIntoProject(p, mismatch));
  assert.deepEqual(p, original);
  const huge = await mcpSource();
  changeFile(
    huge,
    flowPath,
    (f) => (f.mcp_description = "x".repeat(4 * 1024 * 1024)),
  );
  assert.throws(() => importIntoProject(p, huge), /4MiB/);
  assert.deepEqual(p, original);
  // An absent baseline environment is valid history, never an active binding.
  const oldEnvironment = await mcpSource();
  changeFile(
    oldEnvironment,
    flowPath,
    (f) => (f.mcp_environment_id = "historical-missing-env"),
  );
  importIntoProject(p, oldEnvironment);
  assert.equal(
    p.plans[0].importedNativeFlowSource.mcp_environment_id,
    "historical-missing-env",
  );
});

test("ordinary manual/AI flows keep the legacy shape while comparison metadata remains preserved for either source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  for (const origin of ["manual", "ai"]) {
    const document = await source();
    changeFile(document, flowPath, (f) => (f.source = origin));
    changeFile(document, indexPath, (i) => (i.records[0].source = origin));
    const p = await store.create(origin);
    importIntoProject(p, document);
    assert.equal(p.plans[0].source, origin);
    assert.equal(Object.hasOwn(p.plans[0], "importedNativeFlowSource"), false);
    changeFile(document, flowPath, (f) => {
      f.mcp_name = "previous AI name";
    });
    const withHistory = await store.create(origin + " history");
    importIntoProject(withHistory, document);
    assert.equal(withHistory.plans[0].importedNativeFlowSource.source, origin);
    assert.equal(
      withHistory.plans[0].importedNativeFlowSource.mcp_name,
      "previous AI name",
    );
  }
});

test("HTTP import, clone/edit, project PUT and backup restore retain historical IDs without executing baselines", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const wire = await echo(t);
  const call = async (route, method = "GET", data, status = 200) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  let p = await call(
    "/api/projects",
    "POST",
    { name: "HTTP MCP migration" },
    201,
  );
  const base = `/api/projects/${p.id}`;
  p = await call(base + "/import", "POST", {
    document: await mcpSource(wire.port),
  });
  const plan = p.plans[0],
    history = structuredClone(plan.importedNativeFlowSource);
  assert.equal(wire.seen.length, 0);
  const clone = await call(base + "/plans", "POST", {
    ...plan,
    id: "cloned-plan",
    steps: plan.steps.map((s, i) => ({ ...s, id: `cloned-step-${i}` })),
  });
  assert.deepEqual(clone.importedNativeFlowSource, history);
  assert.equal(clone.source, "manual");
  const edited = {
    ...plan,
    name: "manual edit",
    steps: [...plan.steps].reverse(),
  };
  delete edited.importedNativeFlowSource;
  const reordered = await call(base + "/plans", "POST", edited);
  assert.deepEqual(reordered.importedNativeFlowSource, history);
  assert.equal(reordered.steps[0].id, history.steps[1].importedStepId);
  const sourceOnly = await call(base + "/plans", "POST", {
    ...reordered,
    importedNativeFlowSource: {
      ...history,
      mcp_name: "changed historical label",
    },
  });
  assert.equal(
    sourceOnly.importedNativeFlowSource.mcp_name,
    "changed historical label",
  );
  // Deleting a current step does not delete the import-time comparison record.
  const shortened = await call(base + "/plans", "POST", {
    ...sourceOnly,
    steps: sourceOnly.steps.slice(0, 1),
  });
  assert.equal(shortened.importedNativeFlowSource.steps.length, 2);
  p = await call(base);
  p.plans.find((x) => x.id === clone.id).steps[0].request.body = JSON.stringify(
    { edited: "current via PUT", value: "{{native_value}}" },
  );
  p = await call(base, "PUT", p);
  assert.deepEqual(
    p.plans.find((x) => x.id === clone.id).importedNativeFlowSource,
    history,
  );
  const before = await call(base),
    invalid = structuredClone(before);
  invalid.plans[0].importedNativeFlowSource.steps[0].mcp_input.auth = {
    type: "basic",
    basic: { password: "not-retained" },
  };
  await call(base, "PUT", invalid, 400);
  assert.deepEqual(await call(base), before);
  const run = await call(base + "/run", "POST", { planId: clone.id });
  assert.equal(run.status, "passed");
  assert.equal(run.recordSaved, true);
  assert.deepEqual(JSON.parse(wire.seen[0].body), {
    edited: "current via PUT",
    value: "actual-environment",
  });
  assert.deepEqual(run.snapshot.importedNativeFlowSource, history);
  assert.equal((await call(base)).runs[0].source, "manual");
  const backup = await call(base + "/export");
  const restored = await call(
    "/api/restore",
    "POST",
    { document: backup },
    201,
  );
  assert.equal(wire.seen.length, 2);
  const again = await call(`/api/projects/${restored.id}/run`, "POST", {
    planId: clone.id,
  });
  assert.equal(again.status, "passed");
  assert.equal(again.snapshot.steps[0].id, "cloned-step-0");
  assert.deepEqual(again.snapshot.importedNativeFlowSource, history);
  assert.deepEqual(wire.seen.slice(2), wire.seen.slice(0, 2));
  assert.deepEqual(
    (await new Store(root).get(restored.id)).plans.find(
      (x) => x.id === clone.id,
    ).importedNativeFlowSource,
    history,
  );
  assert.equal((await call(base)).runs.length, 1);
});

test("cancelled imported MCP HTTP flow records actual entry origin and never dispatches a later step", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-cancel-"));
  const app = await createApp({ root, port: 0 });
  let started;
  const firstReceived = new Promise((resolve) => (started = resolve)),
    seen = [];
  const target = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    seen.push(req.url);
    if (seen.length === 1) started();
    else res.end("{}");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(async () => {
    target.closeAllConnections();
    app.server.closeAllConnections();
    await Promise.all([
      new Promise((r) => target.close(r)),
      new Promise((r) => app.server.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("cancel MCP import"),
    other = await app.store.create("unrelated"),
    otherBefore = await app.store.get(other.id);
  importIntoProject(p, await mcpSource(target.address().port));
  await app.store.save(p);
  const call = async (route, body) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const pending = call(`/api/projects/${p.id}/run`, {
    planId: p.plans[0].id,
    runId: "cancel-imported-mcp",
  });
  let timeout;
  try {
    await Promise.race([
      firstReceived,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("first request not received")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await call("/api/cancel", { id: "cancel-imported-mcp" });
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.recordSaved, true);
  assert.equal(seen.length, 1);
  const saved = await new Store(root).get(p.id);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].source, "manual");
  assert.deepEqual(
    saved.plans[0].importedNativeFlowSource,
    p.plans[0].importedNativeFlowSource,
  );
  assert.deepEqual(await app.store.get(other.id), otherBefore);
});

test("absent current input never falls back to MCP baseline or applies historical deleted body keys", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mcp-no-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wire = await echo(t),
    document = await mcpSource(wire.port);
  changeFile(document, flowPath, (flow) => {
    delete flow.steps[0].input;
    flow.steps[0].api_snapshot.request.body.raw = JSON.stringify({
      keep: "frozen-snapshot",
      value: "{{native_value}}",
    });
    delete flow.steps[0].pre_script;
    delete flow.steps[0].post_script;
  });
  const store = new Store(root),
    p = await store.create("no baseline fallback");
  importIntoProject(p, document);
  await store.save(p);
  const result = await cli(root, p.id, p.plans[0].id);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(wire.seen[0].body), {
    keep: "frozen-snapshot",
    value: "actual-environment",
  });
  assert.equal(wire.seen[0].path, "/echo?fixture=original");
  assert.equal(wire.seen[0].oldHeader, undefined);
  assert.equal(JSON.parse(result.stdout).variables.native_after, "");
});
