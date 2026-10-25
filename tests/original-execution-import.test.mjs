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

test("synthetic explicit step scripts and Query overrides run while API tasks stay inert", async (t) => {
  const document = await source();
  changeFile(document, flowPath, (flow) => {
    flow.steps[0].input.query = { fixture: "synthetic-query" };
    flow.steps[0].pre_script =
      'apt.environment.set("native_value", "synthetic-value"); console.log("synthetic-before");';
    flow.steps[0].post_script =
      'apt.environment.set("native_after", "synthetic-post"); console.log("synthetic-after");';
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "native-step-input-")),
    seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    seen.push({ path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"fixture":"native-roundtrip"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    p = await store.create("explicit plan script");
  importIntoProject(p, document);
  assert.equal(seen.length, 0);
  const plan = p.plans[0];
  assert.match(plan.steps[0].request.beforeScript, /synthetic-value/);
  assert.match(plan.steps[0].request.afterScript, /synthetic-post/);
  assert.equal(plan.steps[1].request.beforeScript, "");
  assert.equal(plan.steps[1].request.afterScript, "");
  assert.match(
    plan.steps[0].request.importedScriptTasks.before[0].data,
    /from-before/,
  );
  for (const step of plan.steps)
    step.request.url = step.request.url.replace(
      "127.0.0.1:18766",
      `127.0.0.1:${server.address().port}`,
    );
  await store.save(p);
  const result = await cli(root, p.id, plan.id);
  assert.equal(result.code, 0, result.stderr);
  const run = JSON.parse(result.stdout);
  assert.equal(run.status, "passed");
  assert.deepEqual(
    seen,
    ["/echo?fixture=synthetic-query", "/echo?fixture=original"].map((path) => ({
      path,
      body: JSON.stringify({ message: "synthetic-value", number: 7 }, null, 2),
    })),
  );
  assert.deepEqual(
    run.results.map((r) =>
      r.logs.filter((l) => l.message).map((l) => l.message),
    ),
    [["synthetic-before", "synthetic-after"], []],
  );
  assert.equal(run.variables.native_value, "synthetic-value");
  assert.equal(run.variables.native_after, "synthetic-post");
  const saved = await store.get(p.id);
  assert.equal(
    saved.environments.find((e) => e.id === plan.environmentId).variables
      .native_after,
    "synthetic-post",
  );
  assert.equal(
    restoreProject(saved).plans[0].steps[0].request.beforeScript,
    plan.steps[0].request.beforeScript,
  );
});

test("native step inputs reject unknown parameter names and over-budget scripts before project mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-step-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = await new Store(root).create("unchanged");
  for (const change of [
    (f) => (f.steps[0].input.query = { undefinedParameter: "value" }),
    (f) => (f.steps[0].pre_script = "x".repeat(65537)),
    (f) => (f.steps[0].post_script = { code: "not-string" }),
    (f) => (f.steps[0].input.auth = { type: "bearer", token: "not-granted" }),
  ]) {
    const d = await source();
    changeFile(d, flowPath, change);
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, d));
    assert.deepEqual(p, before);
  }
});

test("synthetic native step maps reuse bounded Query Header Path and Cookie overrides on real HTTP", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-map-input-")),
    seen = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    seen.push({
      path: req.url,
      header: req.headers["x-plan"],
      cookie: req.headers.cookie,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const document = await source();
  changeFile(document, flowPath, (flow) => {
    const step = flow.steps[0],
      request = step.api_snapshot.request;
    step.api_snapshot.url = "http://127.0.0.1:18766/echo/{id}?fixture=original";
    request.header.parameter = [
      { key: "X-Plan", value: "base", is_checked: 1 },
    ];
    request.cookie.parameter = [{ key: "sid", value: "base", is_checked: 1 }];
    request.restful.parameter = [{ key: "id", value: "base", is_checked: 1 }];
    step.input = {
      ...step.input,
      query: { fixture: "mapped" },
      headers: { "x-plan": "header-override" },
      cookies: { sid: "cookie-override" },
      path: { id: "a/b" },
    };
  });
  const store = new Store(root),
    p = await store.create("maps");
  importIntoProject(p, document);
  const plan = p.plans[0];
  for (const step of plan.steps)
    step.request.url = step.request.url.replace(
      "127.0.0.1:18766",
      `127.0.0.1:${server.address().port}`,
    );
  await store.save(p);
  const run = await cli(root, p.id, plan.id);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(seen[0], {
    path: "/echo/a%2Fb?fixture=mapped",
    header: "header-override",
    cookie: "sid=cookie-override",
  });
  assert.deepEqual(seen[1], {
    path: "/echo?fixture=original",
    header: undefined,
    cookie: undefined,
  });
});

test("synthetic explicit native authentication is snapshot-bound and never leaks to the next step or project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-auth-input-"));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    seen.push(req.headers.authorization || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  const unrelated = await store.create("unrelated");
  const before = await store.get(unrelated.id);
  for (const [auth, expected] of [
    [
      {
        type: "basic",
        basic: { username: "synthetic-user", password: "synthetic-password" },
      },
      "Basic " +
        Buffer.from("synthetic-user:synthetic-password").toString("base64"),
    ],
    [
      { type: "bearer", bearer: { key: "synthetic-not-a-real-token" } },
      "Bearer synthetic-not-a-real-token",
    ],
    [{ type: "noauth" }, ""],
  ]) {
    const document = await source();
    changeFile(document, flowPath, (flow) => {
      flow.steps[0].api_snapshot.request.auth = {
        type: "basic",
        basic: { username: "old", password: "old-synthetic" },
      };
      flow.steps[0].input.auth = auth;
    });
    const p = await store.create("synthetic auth " + auth.type);
    importIntoProject(p, document);
    const plan = p.plans[0];
    for (const step of plan.steps)
      step.request.url = step.request.url.replace(
        "127.0.0.1:18766",
        `127.0.0.1:${server.address().port}`,
      );
    await store.save(p);
    const saved = restoreProject(await store.get(p.id));
    assert.deepEqual(
      saved.plans[0].steps[0].request.auth,
      plan.steps[0].request.auth,
    );
    const offset = seen.length;
    const run = await cli(root, p.id, plan.id);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(seen.slice(offset), [expected, ""]);
  }
  assert.deepEqual(await store.get(unrelated.id), before);
});

test("native authentication rejects unsupported grants and malformed active fields before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-auth-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = await new Store(root).create("unchanged");
  for (const auth of [
    { type: "inherit" },
    { type: "oauth2", oauth2: { clientSecret: "synthetic" } },
    { type: "basic", basic: { username: {}, password: "synthetic" } },
    {
      type: "basic",
      basic: { username: "u", password: "p", file: "/not-read" },
    },
    { type: "bearer", bearer: { key: "x".repeat(65536) } },
    { type: "noauth", unexpected: true },
  ]) {
    const document = await source();
    changeFile(document, flowPath, (flow) => {
      flow.steps[0].input.auth = auth;
    });
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, document));
    assert.deepEqual(p, before);
  }
});
