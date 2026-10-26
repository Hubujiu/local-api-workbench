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

test("synthetic native text, empty JSON and form body overrides preserve real CLI wire bytes and backup snapshots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-body-input-"));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({ body, type: req.headers["content-type"] });
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
  for (const [mode, input, expected, media] of [
    [
      "plain",
      "literal=+%20&value={{native_value}}",
      "literal=+%20&value=synthetic-body-value",
      "text/plain",
    ],
    [
      "xml",
      "<value>{{native_value}}</value>",
      "<value>synthetic-body-value</value>",
      "application/xml",
    ],
    [
      "json",
      { value: "{{native_value}}", number: 7 },
      '{\n  "value": "synthetic-body-value",\n  "number": 7\n}',
      "application/json",
    ],
    [
      "urlencoded",
      { value: "a+b &{{native_value}}" },
      "value=a%2Bb+%26synthetic-body-value&keep=unchanged",
      "application/x-www-form-urlencoded",
    ],
    [
      "form-data",
      { value: "a+b &{{native_value}}" },
      null,
      "multipart/form-data",
    ],
  ]) {
    const document = await source();
    changeFile(document, flowPath, (flow) => {
      const step = flow.steps[0];
      step.api_snapshot.request.body = {
        mode,
        raw: "",
        parameter: [
          { key: "value", value: "base", is_checked: 1 },
          { key: "keep", value: "unchanged", is_checked: 1 },
        ],
      };
      // Raw/JSON do not carry form metadata.
      if (!["urlencoded", "form-data"].includes(mode))
        step.api_snapshot.request.body.parameter = [];
      step.input.body = input;
      step.pre_script =
        'apt.environment.set("native_value", "synthetic-body-value");';
    });
    const p = await store.create("body " + mode);
    importIntoProject(p, document);
    const plan = p.plans[0];
    for (const step of plan.steps)
      step.request.url = step.request.url.replace(
        "127.0.0.1:18766",
        `127.0.0.1:${server.address().port}`,
      );
    await store.save(p);
    const restored = restoreProject(await store.get(p.id));
    assert.deepEqual(restored.plans[0].steps[0].request, plan.steps[0].request);
    const offset = seen.length;
    const run = await cli(root, p.id, plan.id);
    assert.equal(run.code, 0, run.stderr);
    const first = seen[offset];
    assert.ok(first.type.startsWith(media), first.type);
    if (expected !== null) assert.equal(first.body, expected);
    else {
      assert.match(
        first.body,
        /name="value"\r\n\r\na\+b &synthetic-body-value\r\n/,
      );
      assert.match(first.body, /name="keep"\r\n\r\nunchanged\r\n/);
    }
    assert.equal(JSON.parse(seen[offset + 1].body).number, 7);
  }
});

test("native body inputs reject files, unknown form fields and non-text raw values atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-body-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = await new Store(root).create("unchanged");
  for (const [mode, parameter, input] of [
    ["plain", [], { not: "text" }],
    ["urlencoded", [{ key: "known", value: "old" }], { missing: "new" }],
    [
      "form-data",
      [{ key: "upload", type: "file", value: "/not-read" }],
      { upload: "new-file" },
    ],
    ["none", [], "body"],
  ]) {
    const document = await source();
    changeFile(document, flowPath, (flow) => {
      flow.steps[0].api_snapshot.request.body = { mode, parameter, raw: "" };
      flow.steps[0].input.body = input;
    });
    const before = structuredClone(p);
    assert.throws(() => importIntoProject(p, document));
    assert.deepEqual(p, before);
  }
});

test("synthetic extraction assertion and wait API sources remain inert and uninterpolated through CLI restore", async (t) => {
  // Existing directory/flow layout is a genuine fixture; the added tasks are
  // independently authored, not original pickVars/assert/wait execution evidence.
  const root = await mkdtemp(path.join(os.tmpdir(), "native-pick-source-"));
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not JSON: active pickVars would fail");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const document = await source();
  changeFile(document, flowPath, (flow) => {
    for (const step of flow.steps) {
      step.api_snapshot.request.pre_tasks = [
        {
          type: "wait",
          id: "inert-pre-wait",
          name: "Historical enabled pre wait",
          enabled: 1,
          data: 1000,
        },
        {
          type: "wait",
          id: "disabled-pre-wait",
          name: "Literal disabled pre wait",
          enabled: -1,
          data: "{{WAIT_LITERAL}}",
        },
      ];
      step.api_snapshot.request.post_tasks = [
        {
          type: "pickVars",
          id: "inert-pick",
          name: "Inert extraction",
          enabled: 1,
          data: {
            source: "responseJson",
            variables: [
              { name: "token", expression: "$.token", type: "envVars" },
            ],
          },
        },
        {
          type: "customScript",
          id: "inert-throw",
          name: "Inert script",
          enabled: 1,
          data: 'throw Error("API source must not execute")',
        },
        {
          type: "assert",
          id: "inert-assert",
          name: "Inert JSON assertion",
          enabled: 1,
          data: {
            type: "responseJson",
            expression: {
              path: "$.business",
              compareType: "eq",
              compareValue: "true",
            },
          },
        },
        {
          type: "assert",
          id: "disabled-template",
          name: "Disabled incomplete source",
          enabled: -1,
          data: {
            type: "responseJson",
            expression: {
              path: "{{DO_NOT_INTERPOLATE}}",
              compareValue: "{{MISSING_SOURCE_VALUE}}",
            },
          },
        },
        {
          type: "wait",
          id: "inert-post-wait",
          name: "Historical enabled post wait",
          enabled: 1,
          data: 1000,
        },
        {
          type: "wait",
          id: "disabled-post-wait",
          name: "Literal disabled post wait",
          enabled: 0,
          data: "{{MISSING_WAIT_LITERAL}}",
        },
      ];
      step.pre_script = "";
      step.post_script = "";
    }
  });
  const original = structuredClone(document),
    store = new Store(root),
    p = await store.create("inert extraction");
  importIntoProject(p, document);
  assert.deepEqual(document, original);
  assert.equal(calls, 0);
  const plan = p.plans[0];
  const env = p.environments.find((item) => item.id === plan.environmentId);
  env.variables.token = "unchanged";
  env.variables.WAIT_LITERAL = 7;
  for (const step of plan.steps) {
    assert.equal(step.request.nativeTasks, undefined);
    assert.deepEqual(
      step.request.importedNativeTaskSource.before.map((task) => [
        task.type,
        task.enabled,
        task.data,
      ]),
      [
        ["wait", 1, 1000],
        ["wait", -1, "{{WAIT_LITERAL}}"],
      ],
    );
    assert.deepEqual(
      step.request.importedNativeTaskSource.after
        .filter((task) => task.type === "wait")
        .map((task) => [task.enabled, task.data]),
      [
        [1, 1000],
        [0, "{{MISSING_WAIT_LITERAL}}"],
      ],
    );
    assert.equal(
      step.request.importedNativeTaskSource.after[0].type,
      "pickVars",
    );
    step.request.url = step.request.url.replace(
      "127.0.0.1:18766",
      `127.0.0.1:${server.address().port}`,
    );
  }
  const frozenSource = structuredClone(
    plan.steps.map((step) => step.request.importedNativeTaskSource),
  );
  await store.save(p);
  for (const project of [p, restoreProject(await new Store(root).get(p.id))]) {
    if (project.id !== p.id) await store.save(project);
    const result = await cli(root, project.id, project.plans[0].id);
    assert.equal(result.code, 0, result.stderr);
    const run = JSON.parse(result.stdout);
    assert.equal(run.status, "passed");
    assert.equal(run.results.length, 2);
    assert(run.results.every((step) => step.request.nativeTasks === undefined));
    assert.deepEqual(
      run.snapshot.steps.map((step) => step.request.importedNativeTaskSource),
      frozenSource,
    );
    assert.deepEqual(
      run.results.map((step) => step.request.importedNativeTaskSource),
      frozenSource,
      "execution must not interpolate or activate opaque source fields",
    );
    const saved = await new Store(root).get(project.id);
    assert.equal(
      saved.environments.find((item) => item.id === plan.environmentId)
        .variables.token,
      "unchanged",
    );
    assert(saved.runs.some((item) => item.id === run.id));
  }
  assert.equal(calls, 4);
});
