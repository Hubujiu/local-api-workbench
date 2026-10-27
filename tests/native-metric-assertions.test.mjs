import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeAssertionData } from "../src/native-response-assertions.mjs";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const metric = (type, compareType, compareValue, extra = {}) => ({
  type: "assert",
  enabled: 1,
  name: `${type} ${compareType}`,
  data: {
    type,
    expression: {
      compareType,
      ...(compareValue === undefined ? {} : { compareValue }),
      ...extra,
    },
  },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
const phase = (
  tasks,
  response = { status: 200, body: "wire", duration: 12.5, size: 4 },
) => runNativeTaskPhase(tasks, { request: {}, response });

test("metric paths are optional inert diagnostics; only declared bounded comparisons are accepted", () => {
  for (const type of ["responseTime", "responseSize"]) {
    for (const expression of [
      { compareType: "exist" },
      { compareType: "eq", compareValue: "4", path: "{{ignored}}" },
    ]) {
      assert.deepEqual(normalizeNativeAssertionData({ type, expression }), {
        type,
        expression,
      });
    }
    for (const expression of [
      { compareType: "eq" },
      { compareType: "eq", compareValue: 4 },
      { compareType: "eq", compareValue: "{{active}}" },
      { compareType: "unsupportedComparison", compareValue: "4" },
      { compareType: "exist", path: undefined },
    ])
      assert.throws(() => normalizeNativeAssertionData({ type, expression }));
  }
});

test("both metric sources preserve all fourteen comparisons, current values, and absence", async () => {
  for (const type of ["responseTime", "responseSize"]) {
    const rows = [
      ["eq", "12.5", true],
      ["uneq", "12", true],
      ["lt", "13", true],
      ["lte", "12.5", true],
      ["gt", "12", true],
      ["gte", "12.5", true],
      ["includes", ".5", true],
      ["unincludes", "9", true],
      ["null", undefined, false],
      ["notnull", undefined, true],
      ["exist", undefined, true],
      ["notexist", undefined, false],
      ["belongscollection", "1,12.5,2", true],
      ["notbelongscollection", "12,13", true],
    ];
    const result = await phase([
      script(`pm.response.${type}=12.5;`),
      ...rows.map(([op, expected]) => metric(type, op, expected)),
    ]);
    assert.deepEqual(
      result.tests.map((t) => t.passed),
      rows.map((row) => row[2]),
    );
    const missing = await phase([
      script(`delete pm.response.${type};`),
      metric(type, "notexist"),
      metric(type, "eq", "undefined"),
    ]);
    assert(missing.tests.every((t) => t.passed));
  }
});

test("metric assertions avoid unrelated body access and do not recompute size after setBody", async () => {
  const result = await phase([
    script('apt.response.setBody("changed body is longer");'),
    metric("responseSize", "eq", "4"),
    metric("responseTime", "eq", "12.5"),
    script(
      'Object.defineProperty(response,"body",{get(){throw Error("body must not be read");},configurable:true});',
    ),
    metric("responseSize", "eq", "4"),
    script(
      'Object.defineProperty(response,"body",{value:"restored",writable:true,configurable:true,enumerable:true});',
    ),
  ]);
  assert(result.tests.every((t) => t.passed));
});

test("metric invalid source data cannot become a passing absence assertion and runtimes remain isolated", async () => {
  for (const setup of [
    'Object.defineProperty(pm.response,"responseSize",{get(){throw Error("getter ran");}});',
    "pm.response.responseSize={valueOf(){return 4;}};",
    "pm.response.responseSize=Infinity;",
    'pm.response.responseSize="x".repeat(65537);',
    'pm.response.responseSize="中".repeat(22000);',
    'pm.response.responseSize="\\ud800";',
  ]) {
    await assert.rejects(
      phase([script(setup), metric("responseSize", "notexist")]),
      /原生|有限|64KiB|Unicode/,
    );
  }
  assert.throws(
    () =>
      runNativeTaskPhase([metric("responseTime", "notexist")], { request: {} }),
    /后置/,
  );
  const results = await Promise.all([
    phase([
      script("pm.response.responseSize=9;"),
      metric("responseSize", "eq", "9"),
    ]),
    phase([metric("responseSize", "eq", "4")]),
  ]);
  assert(results.every((r) => r.tests.every((t) => t.passed)));
});

test("metric HTTP import, decoded byte count, plan soft failure, persistence and backup restore close end to end", async (t) => {
  const body = "中文😀",
    bytes = Buffer.byteLength(body),
    packed = gzipSync(body);
  const server = http.createServer((_req, res) => {
    res.setHeader("content-encoding", "gzip");
    res.end(packed);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(tmpdir(), "native-metrics-"));
  let app = await createApp({ root, port: 0 });
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (route, value, expected = 200) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(value),
    });
    const json = await response.json();
    assert.equal(response.status, expected, JSON.stringify(json));
    return json;
  };
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.post_tasks = [];
  source.apis[0].request.post_tasks = [];
  source.apis[1].url = `http://127.0.0.1:${server.address().port}/metrics`;
  source.apis[1].request.query.parameter = [];
  source.apis[1].request.header.parameter = [];
  source.apis[1].request.post_tasks = [
    metric("responseSize", "eq", String(bytes)),
    metric("responseTime", "gte", "0"),
    metric("responseSize", "eq", String(body.length)),
    script('pm.environment.set("metricCompleted","yes");'),
  ];
  source.apis[1].request.post_tasks.forEach((task, index) => {
    task.id = `metric-${index}`;
    task.name ??= `metric-${index}`;
  });
  const original = structuredClone(source),
    project = await app.store.create("metrics");
  importIntoProject(project, source);
  assert.deepEqual(source, original);
  await app.store.save(project);
  const plan = await post(`/api/projects/${project.id}/plans`, {
    steps: [
      { request: project.requests[0] },
      { request: { url: source.apis[1].url, inheritSharedScripts: false } },
    ],
  });
  const run = await post(`/api/projects/${project.id}/run`, {
    planId: plan.id,
  });
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.deepEqual(
    run.results[0].assertions.map((x) => x.passed),
    [true, true, false],
  );
  assert.equal(run.results[1].status, "passed");
  assert.equal(run.results[0].response.size, bytes);
  assert.equal(run.results[0].response.body, body);
  const disk = await new Store(root).get(project.id);
  assert(
    disk.environments.some((env) => env.variables.metricCompleted === "yes"),
  );
  const isolated = await app.store.create("isolated metrics");
  assert(
    isolated.environments.every(
      (env) => !Object.hasOwn(env.variables, "metricCompleted"),
    ),
  );
  assert.equal(disk.runs.at(-1).id, run.id);
  assert.deepEqual(
    disk.plans[0].steps[0].request.nativeTasks,
    plan.steps[0].request.nativeTasks,
  );
  const restored = await post("/api/restore", { document: disk }, 201);
  assert.deepEqual(
    restored.requests[0].nativeTasks,
    disk.requests[0].nativeTasks,
  );
  await close();
  app = await createApp({ root, port: 0 });
  const again = await post(`/api/projects/${restored.id}/run`, {
    planId: restored.plans[0].id,
  });
  assert.equal(again.status, "failed");
  assert.deepEqual(
    again.results[0].assertions.map((x) => x.passed),
    [true, true, false],
  );
});
