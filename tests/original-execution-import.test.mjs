import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";
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
const changeFile = (d, path, fn) => {
  const file = d.files.find((f) => f.path === path);
  const value = JSON.parse(file.text);
  fn(value);
  file.text = JSON.stringify(value);
};
const flowPath = "executions/flows/flow_1792937049044.json";
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
      reject(Error("fixture CLI timeout"));
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
test("genuine native flow imports frozen repeated steps, runs through CLI and preserves original run archives separately", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-flow-"));
  const seen = [];
  let codes = [503, 200];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    seen.push({ path: req.url, body });
    res.writeHead(codes.shift() ?? 200, { "content-type": "application/json" });
    res.end('{"fixture":"native-roundtrip"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    p = await store.create("native flow"),
    other = await store.create("isolated");
  const document = await source(),
    original = JSON.stringify(document);
  importIntoProject(p, document);
  assert.equal(JSON.stringify(document), original);
  assert.equal(seen.length, 0);
  assert.equal(p.plans.length, 1);
  const plan = p.plans[0];
  assert.equal(plan.name, "Native Script Plan");
  assert.equal(plan.statusPolicy, "strict200");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].request.beforeScript, "");
  assert.equal(plan.steps[0].request.afterScript, "");
  assert.match(
    plan.steps[0].request.importedScriptTasks.before[0].data,
    /from-before/,
  );
  assert.match(
    plan.steps[0].request.importedScriptTasks.after[0].data,
    /native_after/,
  );
  assert.match(plan.steps[0].request.importNotes.join(" "), /跳过.*前后置/);
  const environment = p.environments.find((e) => e.id === plan.environmentId);
  environment.variables.native_value = "environment-only";
  environment.variables.native_after = "unchanged-post-value";
  assert.notEqual(plan.steps[0].id, plan.steps[1].id);
  assert.equal(
    plan.steps[0].request.body,
    JSON.stringify({ message: "{{native_value}}", number: 7 }, null, 2),
  );
  assert.equal(p.runs.length, 0);
  assert.equal(
    p.settings.apipostDirectoryArtifacts[0].files.filter((f) =>
      /executions\/runs\/run_/.test(f.path),
    ).length,
    2,
  );
  for (const step of plan.steps)
    step.request.url = step.request.url.replace(
      "127.0.0.1:18766",
      `127.0.0.1:${server.address().port}`,
    );
  p.requests[0].url = "https://edited-source.invalid";
  p.requests[0].body = "edited";
  await store.save(p);
  const failed = await cli(root, p.id, plan.id);
  assert.equal(failed.code, 1, failed.stderr);
  const run = JSON.parse(failed.stdout);
  assert.equal(run.status, "failed");
  assert.deepEqual(
    run.results.map((s) => s.response.status),
    [503, 200],
  );
  assert.deepEqual(
    run.results.map((s) => s.status),
    ["failed", "passed"],
  );
  assert.equal(run.variables.native_after, "unchanged-post-value");
  assert.equal(run.variables.native_value, "environment-only");
  assert.equal(
    run.results
      .flatMap((r) => r.logs)
      .some(
        (l) => l.message === "native-before" || l.message === "native-after",
      ),
    false,
  );
  assert.deepEqual(
    seen,
    Array.from({ length: 2 }, () => ({
      path: "/echo?fixture=original",
      body: JSON.stringify({ message: "environment-only", number: 7 }, null, 2),
    })),
  );
  const saved = await new Store(root).get(p.id);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].id, run.id);
  assert.equal((await store.get(other.id)).runs.length, 0);
  const restored = restoreProject(structuredClone(saved));
  await store.save(restored);
  codes = [200, 200];
  const success = await cli(root, restored.id, plan.id);
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).status, "passed");
  assert.equal(seen.length, 4);
  assert.deepEqual(
    (await store.get(restored.id)).settings.apipostDirectoryArtifacts,
    saved.settings.apipostDirectoryArtifacts,
  );
});
test("native execution preflight rejects missing bindings, drifting snapshots, unknown input and inconsistent archives atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-flow-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = await new Store(root).create("unchanged");
  for (const mutate of [
    (d) => changeFile(d, flowPath, (f) => (f.environment_id = "missing")),
    (d) =>
      changeFile(
        d,
        flowPath,
        (f) => (f.steps[0].api_snapshot.target_id = "wrong"),
      ),
    (d) =>
      changeFile(
        d,
        flowPath,
        (f) => (f.steps[0].input.url = "https://override.invalid"),
      ),
    (d) =>
      changeFile(d, flowPath, (f) => (f.steps[1].step_id = f.steps[0].step_id)),
    (d) =>
      changeFile(
        d,
        "executions/flows/index.json",
        (f) => (f.records[0].step_count = 99),
      ),
    (d) =>
      changeFile(
        d,
        "executions/runs/index.json",
        (f) => (f.records[0].detail_file = "../outside.json"),
      ),
    (d) =>
      changeFile(
        d,
        "executions/runs/run_1792937433512_jatt2lk5.json",
        (f) => (f.project_id = "other"),
      ),
    (d) => d.files.push({ path: "executions/flows/orphan.json", text: "{}" }),
  ]) {
    const d = await source();
    mutate(d);
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, d));
    assert.deepEqual(p, before);
  }
});
