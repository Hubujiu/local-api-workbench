import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  exportOpenAPI,
  normalizeRequest,
  runPlan,
  snapshotPlan,
  toCurl,
} from "../src/core.mjs";
import {
  defaultHTTPPreWaitMilliseconds,
  maxHTTPPreWaitMilliseconds,
  canUseHTTPPreWait,
} from "../public/http-pre-wait-contract.js";
import {
  resolveDynamicRequest,
  resolveDynamicValue,
} from "../src/dynamic-values.mjs";
import { snapshotInterfaceForPlan } from "../public/plan-snapshots.js";
import { snapshotCase } from "../src/cases.mjs";
import { manualHTTPPreWait } from "../src/http-pre-wait.mjs";
import { materializeLivePlan } from "../src/live-plan-materialize.mjs";
import { runLoad } from "../src/load-runner.mjs";
import { generateRequestCode } from "../src/request-code-generation.mjs";
import { executeRequest } from "../src/runtime.mjs";
import { createApp } from "../src/server.mjs";

const admit = { preWaitAdmission: manualHTTPPreWait };
const wait = (milliseconds, enabled = true) => ({
  type: "wait",
  waitVersion: 1,
  milliseconds,
  enabled,
});
const db = (name) => ({
  type: "database",
  name,
  connectionId: "synthetic",
  sql: "SELECT 1",
});
const input = (before, extra = {}) => ({
  id: "wait-fixture",
  name: "Wait fixture",
  url: "http://127.0.0.1:32001/synthetic",
  method: "GET",
  before,
  ...extra,
});
const plan = (request) => ({ steps: [{ request }] });
const response = { status: 200, body: "ok", headers: {} };

test("versioned waits survive definition normalization and validate all rows and ranges", () => {
  const before = [wait(1250), wait(8750), wait(10000, false)];
  const request = normalizeRequest(input(before));
  assert.deepEqual(request.before, before);
  assert.equal(defaultHTTPPreWaitMilliseconds, 1000);
  assert.equal(maxHTTPPreWaitMilliseconds, 10000);
  assert.equal(canUseHTTPPreWait(request), true);
  for (const invalid of [
    { ...wait(1000), waitVersion: 2 },
    { ...wait(1), enabled: 1 },
    { ...wait(1), milliseconds: "1250" },
    { ...wait(1), nativeTask: { type: "wait", enabled: 1 } },
    wait(-1),
    wait(0.5),
    wait(10001, false),
    wait(Infinity),
  ])
    assert.throws(() => normalizeRequest(input([invalid])), /前置等待配置无效/);
  assert.throws(() => normalizeRequest(input([wait(10000), wait(1)])), /合计/);
  for (const extra of [
    { graphqlEditorVersion: 1 },
    { graphqlVariableTemplate: {} },
    { scriptURLMode: "sdk" },
    { nativeTasks: {} },
    { nativeInheritance: {} },
    { importedNativeTaskSource: {} },
    { importedScriptTasks: {} },
  ])
    assert.throws(
      () => snapshotPlan(plan(input([wait(1)], extra)), admit),
      /不能与/,
    );
  assert.throws(
    () => normalizeRequest(input([], { after: [wait(0)] })),
    /只支持/,
  );
  assert.deepEqual(
    snapshotPlan(plan(request), admit).steps[0].request.before,
    before,
  );
});

test("complete new ordinary list is admitted before preceding DB or execution can start", async () => {
  const notCalled = () => assert.fail("unexpected effect");
  for (const last of [
    { type: "wait" },
    { type: "set", name: "constructor" },
    { type: "unknown", name: "x" },
    { ...db("valid"), parameters: 1 },
    { ...db("valid"), path: "$[nonsense" },
  ]) {
    await assert.rejects(
      runPlan(plan(input([db("first"), wait(10), last])), {}, notCalled, {
        ...admit,
        databaseQuery: notCalled,
        onScopeChanges: notCalled,
      }),
    );
  }
});

test("ordinary Wait is serial before scripts, disabled Wait skips, and wire never receives it", async () => {
  const events = [];
  let firstTime;
  const request = input(
    [db("first"), wait(50), wait(10000, false), db("second")],
    {
      timeout: 2000,
      beforeScript: 'console.log("before script");',
    },
  );
  const run = await runPlan(
    snapshotPlan(plan(request), admit),
    {},
    (effective) => {
      events.push("transport");
      assert.deepEqual(effective.before, [db("first"), db("second")]);
      return response;
    },
    {
      ...admit,
      databaseQuery: () => {
        events.push("db");
        if (events.length === 1) firstTime = performance.now();
        else assert.ok(performance.now() - firstTime >= 35);
        return { count: 1 };
      },
    },
  );
  assert.deepEqual(events, ["db", "db", "transport"]);
  assert.equal(run.status, "passed");
  assert.deepEqual(run.results[0].logs, [
    { phase: "before", type: "database", name: "first" },
    { phase: "before", type: "wait", milliseconds: 50 },
    { phase: "before", type: "database", name: "second" },
    { phase: "before", message: "before script" },
  ]);
});

test("abort or pre-dispatch deadline during Wait prevents remaining operations, script and wire", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    const request = input([db("first"), wait(500), db("second")], {
      timeout: cancel ? 2000 : 100,
      beforeScript: 'console.log("must-not-run");',
    });
    let operations = 0;
    const run = await runPlan(
      snapshotPlan(plan(request), admit),
      {},
      () => assert.fail("transport started"),
      {
        ...admit,
        signal: controller.signal,
        databaseQuery: () => {
          assert.equal(++operations, 1);
          if (cancel) setImmediate(() => controller.abort("untrusted reason"));
          return { count: 1 };
        },
      },
    );
    assert.equal(operations, 1);
    assert.equal(run.results[0].status, "failed");
    assert.match(run.results[0].error, cancel ? /取消/ : /超时/);
    assert.deepEqual(run.results[0].logs, [
      { phase: "before", type: "database", name: "first" },
    ]);
  }
});

test("expired dynamic nodes and a cancelled running transform never start later transforms", async () => {
  const transform = {
    name: "one",
    body: "return args[0] * 2;",
  };
  const functions = [transform];
  const checked = [];
  const deadline = { deadline: Number.MAX_SAFE_INTEGER };
  functions.find = function (...args) {
    checked.push("lookup");
    return Array.prototype.find.apply(this, args);
  };
  const request = normalizeRequest(
    input([], {
      headers: [
        {
          key: "X-Local-Fixture",
          value: "",
          dynamic: { source: "fixed", value: 1, functions: ["one"] },
        },
      ],
    }),
  );
  let interpolations = 0;
  await assert.rejects(
    resolveDynamicRequest(
      request,
      {},
      functions,
      (value) => {
        interpolations++;
        // Deterministic monotonic snapshot expires as the first unit completes.
        deadline.deadline = 0;
        return value;
      },
      undefined,
      deadline,
    ),
    { code: "REQUEST_TIMEOUT" },
  );
  assert.equal(interpolations, 1);
  assert.deepEqual(checked, []);

  const controller = new AbortController();
  functions.find = function (...args) {
    checked.push("lookup");
    queueMicrotask(() => controller.abort("fixture only"));
    return Array.prototype.find.apply(this, args);
  };
  await assert.rejects(
    resolveDynamicValue(
      { source: "fixed", value: 1, functions: ["one", "one"] },
      {},
      functions,
      undefined,
      { signal: controller.signal },
    ),
    { code: "ABORT_ERR" },
  );
  assert.deepEqual(checked, ["lookup"]);
});

test("ordinary Wait plus imported dynamic compatibility template rejects before DB or wire", async () => {
  const request = input([db("first"), wait(0)], {
    headers: [
      {
        key: "X-Native-Template",
        value: "",
        dynamic: { source: "apipost-header-function", value: '{{"A"|lower}}' },
      },
    ],
  });
  assert.equal(canUseHTTPPreWait(request), false);
  const notCalled = () => assert.fail("incompatible request started work");
  await assert.rejects(
    runPlan(plan(request), {}, notCalled, {
      ...admit,
      databaseQuery: notCalled,
    }),
    /原版动态函数模板混用/,
  );
});

test("unmarked ordinary Wait is retained for read and backup but has no execution admission", async () => {
  const legacy = [{ type: "wait", ms: 1250, enabled: true }];
  const request = normalizeRequest(input(legacy));
  assert.deepEqual(request.before, legacy);
  assert.deepEqual(normalizeRequest(request).before, legacy);
  assert.throws(() => snapshotPlan(plan(request), admit), /前置等待配置无效/);
  await assert.rejects(
    runPlan(plan(request), {}, () => assert.fail("legacy wait sent"), admit),
    /前置等待配置无效/,
  );
  assert.throws(
    () => normalizeRequest(input([...legacy, wait(0)])),
    /前置等待配置无效/,
  );
});

test("unsupported surfaces fail closed rather than dropping enabled or disabled Wait", async () => {
  const request = normalizeRequest(input([wait(1250, false)]));
  for (const unsupported of [
    () => snapshotPlan(plan(request)),
    () => snapshotInterfaceForPlan(request),
    () => snapshotCase({ name: "case", sourceRequestId: request.id, request }),
    () => toCurl(request),
    () => generateRequestCode(request, "node", "fetch"),
    () => exportOpenAPI({ requests: [request] }),
    () =>
      materializeLivePlan(
        { requests: [request] },
        {
          steps: [
            {
              id: "live-step",
              liveRequestId: request.id,
              request: normalizeRequest(input([])),
            },
          ],
        },
      ),
  ])
    assert.throws(unsupported, /不支持手动调试前置等待/);
  await assert.rejects(
    runLoad({ requests: [request], environments: [], settings: {} }, request),
    /负载执行不支持手动调试前置等待/,
  );
  await assert.rejects(
    executeRequest(request),
    /直接 HTTP 传输不支持手动调试前置等待/,
  );
  await assert.rejects(
    runPlan(plan(request), {}, () => assert.fail("transport started"), {
      preWaitAdmission: true,
    }),
    /执行计划不支持手动调试前置等待/,
  );
});

test("owner manual API executes one loopback request only for a valid explicit dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "http-pre-wait-"));
  let hits = 0,
    app;
  const peer = http.createServer((_req, res) => {
    hits++;
    res.end("owned fixture");
  });
  t.after(async () => {
    app?.server.closeAllConnections();
    await app?.close();
    peer.closeAllConnections();
    if (peer.listening) await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("owned fixture");
  const request = normalizeRequest(
    input([wait(25)], {
      url: "http://127.0.0.1:" + peer.address().port,
    }),
  );
  const legacy = normalizeRequest({
    ...request,
    id: "legacy-wait",
    before: [{ type: "wait", ms: 1250, enabled: true }],
  });
  project.requests.push(request, legacy);
  await app.store.save(project);
  const stored = await app.store.get(project.id);
  assert.deepEqual(stored.requests[0].before, request.before);
  assert.deepEqual(stored.requests[1].before, legacy.before);
  const exportFormat = (format) =>
    fetch(
      app.url + "/api/projects/" + project.id + "/export?format=" + format,
      {
        headers: { "x-local-token": app.token },
      },
    );
  const backup = await exportFormat("native");
  assert.equal(backup.status, 200);
  const backedUp = await backup.json();
  assert.deepEqual(backedUp.requests[0].before, request.before);
  assert.deepEqual(backedUp.requests[1].before, legacy.before);
  const openapi = await exportFormat("openapi");
  assert.equal(openapi.status, 400);
  assert.match(
    (await openapi.json()).error,
    /OpenAPI导出不支持手动调试前置等待/,
  );
  for (const format of ["apipost", "apipost-directory"]) {
    const incompatible = await exportFormat(format);
    assert.equal(incompatible.status, 400);
    assert.match((await incompatible.json()).error, /before|前置等待/);
  }
  const call = (action, request) =>
    fetch(app.url + "/api/projects/" + project.id + "/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify({ request }),
    });
  const bad = await call("execute", { ...request, before: [{ type: "wait" }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /前置等待配置无效/);
  const old = await call("execute", legacy);
  assert.equal(old.status, 400);
  assert.match((await old.json()).error, /前置等待配置无效/);
  const curl = await call("curl", request);
  assert.equal(curl.status, 400);
  assert.match((await curl.json()).error, /不支持手动调试前置等待/);
  assert.equal(hits, 0);
  const good = await call("execute", request);
  assert.equal(good.status, 200);
  const result = await good.json();
  assert.equal(result.body, "owned fixture");
  assert.deepEqual(result.logs, [
    { phase: "before", type: "wait", milliseconds: 25 },
  ]);
  assert.equal(hits, 1);
  const after = await app.store.get(project.id);
  assert.deepEqual(after.requests[0].before, request.before);
  assert.deepEqual(after.requests[1].before, legacy.before);
  assert.equal(after.history.length, 1);
});
