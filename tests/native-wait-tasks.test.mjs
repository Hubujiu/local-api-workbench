import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  normalizeNativeWaitData,
  compileNativeWaits,
} from "../src/native-wait-tasks.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const wait = (data, enabled = 1) => ({
  type: "wait",
  id: "wait",
  name: "wait",
  enabled,
  data,
});
const pick = {
  type: "pickVars",
  id: "token",
  name: "token",
  enabled: 1,
  data: {
    source: "responseJson",
    variables: [{ name: "token", expression: "$.token", type: "envVars" }],
  },
};
function sourceFor(base) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.pre_tasks = [
    script(
      "project",
      `const order=["project"];await pm.sendRequest(${JSON.stringify(base)}+"/entered/"+pm.environment.get("tenant"));`,
    ),
    wait(20),
  ];
  source.apis[0].request.pre_tasks = [
    script("folder", 'order.push("folder");'),
    wait(30),
  ];
  const api = source.apis[1];
  api.url = base + "/main/{{tenant}}";
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.pre_tasks = [
    wait(30),
    wait("{{disabled}}", -1),
    script(
      "request",
      'order.push("request");apt.setRequestHeader("x-order",order.join(","));pm.environment.set("beforeProof",order.join(","));',
    ),
  ];
  api.request.post_tasks = [
    script(
      "post-enter",
      `const proof="post:";await pm.sendRequest(${JSON.stringify(base)}+"/post-entered/"+pm.environment.get("tenant"));`,
    ),
    wait(120),
    pick,
    script(
      "post-done",
      'pm.environment.set("postProof",proof+pm.environment.get("token"));',
    ),
  ];
  return source;
}

test("native wait accepts bounded integer durations and inert disabled scalars without coercion", () => {
  assert.deepEqual(compileNativeWaits([0, 999, 1]), [0, 999, 1]);
  for (const value of [
    "100",
    true,
    null,
    undefined,
    -1,
    1001,
    1.2,
    NaN,
    Infinity,
    {},
    [],
  ])
    assert.throws(() => normalizeNativeWaitData(value));
  for (const value of [null, false, 2000, -2, 0.5, "{{inert}}", ""])
    assert.equal(normalizeNativeWaitData(value, { enabled: false }), value);
  for (const value of [
    undefined,
    NaN,
    Infinity,
    {},
    [],
    "x".repeat(1001),
    "\ud800",
  ])
    assert.throws(() => normalizeNativeWaitData(value, { enabled: false }));
  assert.throws(() => compileNativeWaits([1000, 1]), /合计/);
  let called = 0;
  const source = [0];
  Object.defineProperty(source, "0", {
    enumerable: true,
    get() {
      called++;
      return 1;
    },
  });
  assert.throws(() => compileNativeWaits(source));
  assert.equal(called, 0);
});

test("zero wait is synchronous and does not allocate a timer or yield to queued microtasks", async () => {
  const result = await runNativeTaskPhase(
    [
      script(
        "before",
        'const order=["before"];Promise.resolve().then(()=>order.push("microtask"));',
      ),
      wait(0),
      script(
        "after",
        'order.push("after");pm.environment.set("immediate",order.join(","));',
      ),
    ],
    { request: {} },
    { timerLimit: 0 },
  );
  assert.equal(result.scopes.environment.immediate, "before,after");
  assert.equal(result.usage.timers, 0);
});

test("real inherited pre and post waits order HTTP, persist frozen tasks, and survive restore/restart", async (t) => {
  const events = [];
  const upstream = http.createServer((req, res) => {
    events.push({
      path: req.url,
      at: performance.now(),
      order: req.headers["x-order"],
      auth: req.headers.authorization,
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: "token-" + req.url.split("/").at(-1) }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(tmpdir(), "native-wait-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + upstream.address().port,
    source = sourceFor(base),
    original = structuredClone(source),
    p = await app.store.create("waits");
  importIntoProject(p, source);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "environment-B",
    name: "B",
    variables: { tenant: "B" },
  });
  await app.store.save(p);
  assert.deepEqual(source, original);
  const post = async (route, body) => {
    const r = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  const created = await post(`/api/projects/${p.id}/plans`, {
    steps: [
      { request: p.requests[0] },
      {
        request: {
          method: "GET",
          url: base + "/later/{{tenant}}",
          auth: { type: "bearer", token: "{{token}}" },
        },
      },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const plan = created.value;
  const live = await app.store.get(p.id);
  live.requests[0].nativeTasks.before.find((t) => t.type === "wait").data = 0;
  await app.store.save(live);
  for (let round = 0; round < 2; round++) {
    events.length = 0;
    const run = await post(`/api/projects/${p.id}/run`, { planId: plan.id });
    assert.equal(run.value.status, "passed", JSON.stringify(run));
    assert.deepEqual(
      events.map((e) => e.path),
      ["/entered/A", "/main/A", "/post-entered/A", "/later/A"],
    );
    assert(events[1].at - events[0].at >= 75, JSON.stringify(events));
    assert(events[3].at - events[2].at >= 115, JSON.stringify(events));
    assert.equal(events[1].order, "project,folder,request");
    assert.equal(events[3].auth, "Bearer token-A");
    const disk = await new Store(root).get(p.id);
    assert.equal(
      disk.environments[0].variables.beforeProof,
      "project,folder,request",
    );
    assert.equal(disk.environments[0].variables.postProof, "post:token-A");
    assert.deepEqual(
      disk.runs.at(-1).snapshot.steps[0].request.nativeTasks,
      plan.steps[0].request.nativeTasks,
    );
    if (round === 0) {
      await stop();
      app = await createApp({ root, port: 0 });
    }
  }
  const disk = await new Store(root).get(p.id),
    restored = await post("/api/restore", { document: disk });
  assert.equal(restored.status, 201);
  assert.deepEqual(
    restored.value.plans[0].steps[0].request.nativeTasks,
    plan.steps[0].request.nativeTasks,
  );
  const run = await post(`/api/projects/${restored.value.id}/run`, {
    planId: plan.id,
  });
  assert.equal(run.value.status, "passed", JSON.stringify(run));
  const other = await app.store.create("isolated wait project");
  importIntoProject(other, source);
  other.environments[0].variables.tenant = "C";
  await app.store.save(other);
  const otherPlan = await post(`/api/projects/${other.id}/plans`, {
    steps: [{ request: other.requests[0] }, plan.steps[1]],
  });
  assert.equal(otherPlan.status, 200);
  events.length = 0;
  const together = await Promise.all([
    post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId: "environment-B",
    }),
    post(`/api/projects/${other.id}/run`, { planId: otherPlan.value.id }),
  ]);
  assert(
    together.every((r) => r.value.status === "passed"),
    JSON.stringify(together),
  );
  for (const tenant of ["B", "C"]) {
    const group = events.filter((e) => e.path.endsWith("/" + tenant));
    assert.deepEqual(
      group.map((e) => e.path),
      [
        "/entered/" + tenant,
        "/main/" + tenant,
        "/post-entered/" + tenant,
        "/later/" + tenant,
      ],
    );
    assert(group[1].at - group[0].at >= 75);
    assert(group[3].at - group[2].at >= 115);
    assert.equal(group[3].auth, "Bearer token-" + tenant);
  }
  const isolated = await new Store(root).get(p.id);
  assert.equal(isolated.environments[0].variables.token, "token-A");
  assert.equal(isolated.environments[1].variables.token, "token-B");
  assert.equal(
    (await new Store(root).get(other.id)).environments[0].variables.token,
    "token-C",
  );
  const count = events.length,
    foreign = await post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId: other.environments[0].id,
    });
  assert.equal(foreign.status, 400);
  assert.equal(events.length, count);
});

test("raw native waits resist Number Promise timer and Date tampering using server monotonic ordering", async (t) => {
  const events = [];
  const server = http.createServer((req, res) => {
    events.push({ path: req.url, at: performance.now() });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const tampers = [
    "Number=()=>0;setTimeout=fn=>{fn();return 1;};Date.now=()=>0;",
    "Promise.prototype.constructor=function(){};Promise.prototype.then=function(resolve){resolve();};",
    "Promise=function(executor){executor(()=>{});return {then:resolve=>resolve()};};Reflect.apply=()=>{};Object.defineProperty=()=>{};",
    "globalThis.__nativeWaitTask=()=>{};globalThis.__readNativeWaitCompletion=()=>{};",
  ];
  for (const tamper of tampers) {
    events.length = 0;
    const result = await runNativeTaskPhase(
      [
        script(
          "entered",
          `await pm.sendRequest(${JSON.stringify(base + "/entered")});const marker="kept";`,
        ),
        script("tamper", tamper),
        wait(80),
        script(
          "after",
          `pm.environment.set("marker",marker);pm.sendRequest(${JSON.stringify(base + "/after")},()=>{});`,
        ),
      ],
      { request: {}, allowNetwork: true },
    );
    assert.equal(result.scopes.environment.marker, "kept");
    assert.equal(result.usage.timers, 1);
    assert.equal(result.networkRequests.length, 2);
    assert.deepEqual(
      events.map((e) => e.path),
      ["/entered", "/after"],
    );
    assert(
      events[1].at - events[0].at >= 75,
      JSON.stringify({ tamper, events }),
    );
  }
});

test("completion and unchanged timer quotas reject early return caught failure and guessed cancellation", async () => {
  for (const tasks of [
    [script("return", "return;"), wait(10)],
    [wait(0), script("return", "return;"), wait(10)],
  ])
    await assert.rejects(runNativeTaskPhase(tasks, { request: {} }), /未完成/);
  await assert.rejects(
    runNativeTaskPhase(
      [script("try", "try {"), wait(10), script("catch", "} catch(e) {}")],
      { request: {} },
      { timerLimit: 0 },
    ),
    /未完成/,
  );
  await assert.rejects(
    runNativeTaskPhase([wait(10)], { request: {} }, { timerLimit: 0 }),
    /定时器最多/,
  );
  await assert.rejects(
    runNativeTaskPhase(
      [
        script("cancel", "setTimeout(()=>clearTimeout(2),1);"),
        wait(80),
        script("must-not-run", 'throw Error("early continuation");'),
      ],
      { request: {} },
    ),
    /Promise未完成|wait阶段存在未完成/,
  );
  await assert.rejects(
    runNativeTaskPhase(
      [
        script("active", "for(let i=0;i<32;i++)setTimeout(()=>{},100);"),
        wait(10),
      ],
      { request: {} },
    ),
    /同时32次/,
  );
  await assert.rejects(
    runNativeTaskPhase(
      [
        script(
          "quota",
          "for(let i=0;i<100;i++){const id=setTimeout(()=>{},100);clearTimeout(id);}",
        ),
        wait(10),
      ],
      { request: {} },
    ),
    /最多100次/,
  );
  const callbacks = await runNativeTaskPhase(
    [
      script(
        "schedule",
        'const order=[];setTimeout(()=>order.push("callback"),10);',
      ),
      wait(40),
      script("after", 'order.push("after");pm.environment.set("order",order);'),
    ],
    { request: {} },
  );
  assert.deepEqual(callbacks.scopes.environment.order, ["callback", "after"]);
  assert.equal(callbacks.usage.timers, 2);
  const begin = performance.now();
  const inclusive = await runNativeTaskPhase([wait(999), wait(1)], {
    request: {},
  });
  assert(performance.now() - begin >= 995);
  assert.equal(inclusive.usage.timers, 2);
  await assert.rejects(
    runNativeTaskPhase(
      [
        script("detached", "const detached=(async()=>{"),
        wait(80),
        script("second", "})();try {"),
        wait(20),
        script("catch", "} catch(e) {} await detached;"),
      ],
      { request: {} },
    ),
    /未完成/,
  );
  await assert.rejects(
    runNativeTaskPhase([wait(1000)], { request: {} }, { wallBudgetMs: 700 }),
    (error) => {
      assert.match(error.message, /超时/);
      assert.equal(error.scriptStage, "total-deadline");
      assert.equal(error.lastWorkerStage, "async-completion");
      return true;
    },
  );
});

test("native wait validation is atomic after inheritance and no disabled data is coerced or interpolated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wait-import-"));
  try {
    const store = new Store(root),
      p = await store.create("atomic wait"),
      before = structuredClone(p);
    for (const data of ["1000", true, null, -1, 1001, 1.2, {}, undefined]) {
      const source = sourceFor("http://127.0.0.1:1");
      source.apis[1].request.pre_tasks[0].data = data;
      assert.throws(() => importIntoProject(p, source));
      assert.deepEqual(p, before);
    }
    const source = sourceFor("http://127.0.0.1:1");
    source.global.global_param.pre_tasks[1].data = 700;
    source.apis[0].request.pre_tasks[1].data = 400;
    assert.throws(() => importIntoProject(p, source), /合计/);
    assert.deepEqual(p, before);
    const request = (tasks) => ({
      inheritSharedScripts: false,
      nativeTasks: { version: 1, before: tasks, after: [] },
    });
    assert.equal(
      normalizeNativeTaskRequest(
        request(Array.from({ length: 16 }, () => wait(0))),
      ).before.length,
      16,
    );
    assert.throws(
      () =>
        normalizeNativeTaskRequest(
          request(Array.from({ length: 17 }, () => wait(0))),
        ),
      /超限|最多/,
    );
    let calls = 0;
    const task = wait(0);
    Object.defineProperty(task, "data", {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    assert.throws(() => normalizeNativeTaskRequest(request([task])));
    assert.equal(calls, 0);
    const inert = [null, true, 10000, -2, 0.5, "{{unresolved}}"];
    const output = await runNativeTaskPhase(
      inert.map((value) => wait(value, 0)),
      { request: {} },
      { timerLimit: 0 },
    );
    assert.equal(output.usage.timers, 0);
    assert.deepEqual(await new Store(root).get(p.id), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real HTTP cancellation during pre and post waits preserves only committed scopes and independent projects",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "wait-cancel-"));
    let app = await createApp({ root, port: 0 });
    const events = [];
    let observed;
    const upstream = http.createServer((req, res) => {
      events.push(req.url);
      if (req.url.endsWith("/wait-active")) observed?.();
      res.setHeader("content-type", "application/json");
      res.end('{"token":"fresh"}');
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const stop = async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    };
    t.after(async () => {
      await stop();
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const base = "http://127.0.0.1:" + upstream.address().port;
    const post = async (route, body) => {
      const r = await fetch(app.url + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const cancelled = [];
    for (const phase of ["before", "after"]) {
      const p = await app.store.create("cancel " + phase);
      p.environments[0].variables.token = "stale";
      await app.store.save(p);
      const mark = script(
        "entered",
        `pm.environment.set("pending","must-not-commit");await pm.sendRequest(${JSON.stringify(base + "/" + phase + "/entered")});setTimeout(()=>pm.sendRequest(${JSON.stringify(base + "/" + phase + "/wait-active")},()=>{}),20);`,
      );
      const plan = await post(`/api/projects/${p.id}/plans`, {
        steps: [
          {
            request: {
              method: "GET",
              url: base + "/" + phase + "/main",
              inheritSharedScripts: false,
              nativeTasks: {
                version: 1,
                before:
                  phase === "before"
                    ? [mark, wait(1000)]
                    : [
                        script(
                          "before",
                          'pm.environment.set("beforeProof","committed");',
                        ),
                      ],
                after: phase === "after" ? [mark, wait(1000), pick] : [],
              },
            },
          },
          { request: { method: "GET", url: base + "/" + phase + "/later" } },
        ],
      });
      const ready = new Promise((r) => (observed = r)),
        runId = "cancel_wait_" + phase;
      const running = post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        runId,
      });
      await ready;
      const other = await app.store.create("independent " + phase);
      const otherPlan = await post(`/api/projects/${other.id}/plans`, {
        steps: [
          {
            request: {
              method: "GET",
              url: base + "/" + phase + "/other",
              inheritSharedScripts: false,
              nativeTasks: {
                version: 1,
                before: [
                  wait(40),
                  script("set", 'pm.environment.set("independent","yes");'),
                ],
                after: [],
              },
            },
          },
        ],
      });
      const independent = post(`/api/projects/${other.id}/run`, {
        planId: otherPlan.id,
        runId: "independent_wait_" + phase,
      });
      const cancelStart = performance.now();
      await post("/api/cancel", { id: runId });
      const run = await running;
      assert.equal(run.status, "cancelled");
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 1);
      assert(
        performance.now() - cancelStart < 800,
        "cancel must not wait for full timer/wall budget",
      );
      assert(!events.includes("/" + phase + "/later"));
      assert.equal(events.includes("/" + phase + "/main"), phase === "after");
      if (phase === "after") assert.equal(run.results[0].response.status, 200);
      const disk = await new Store(root).get(p.id);
      assert.equal(disk.environments[0].variables.pending, undefined);
      assert.equal(disk.environments[0].variables.token, "stale");
      assert.equal(
        disk.environments[0].variables.beforeProof,
        phase === "after" ? "committed" : undefined,
      );
      assert.equal(disk.runs.find((r) => r.id === run.id).status, "cancelled");
      cancelled.push([p.id, run.id]);
      const finished = await independent;
      assert.equal(finished.status, "passed", JSON.stringify(finished));
      assert.equal(
        (await new Store(root).get(other.id)).environments[0].variables
          .independent,
        "yes",
      );
    }
    const count = events.length;
    await stop();
    app = await createApp({ root, port: 0 });
    for (const [projectId, runId] of cancelled)
      assert.equal(
        (await app.store.get(projectId)).runs.find((r) => r.id === runId)
          .status,
        "cancelled",
      );
    assert.equal(
      events.length,
      count,
      "restart must not replay cancelled requests",
    );
  },
);

test("wait-only stage failure keeps ordinary plan continuation while enabled pick retains strict stop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wait-policy-")),
    app = await createApp({ root, port: 0 });
  const seen = [],
    server = http.createServer((req, res) => {
      seen.push(req.url);
      res.end('{"token":"fresh"}');
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([
      new Promise((r) => app.server.close(r)),
      new Promise((r) => server.close(r)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const post = async (p, route, body) => {
    const response = await fetch(`${app.url}/api/projects/${p.id}/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const strict of [false, true]) {
    const p = await app.store.create("policy " + strict);
    seen.length = 0;
    const plan = await post(p, "plans", {
      steps: [
        {
          request: {
            method: "GET",
            url: base + "/main",
            inheritSharedScripts: false,
            nativeTasks: {
              version: 1,
              before: [
                script("skip", 'pm.environment.set("half","no");return;'),
                wait(20),
              ],
              after: strict ? [pick] : [],
            },
          },
        },
        { request: { method: "GET", url: base + "/later" } },
      ],
    });
    const run = await post(p, "run", { planId: plan.id });
    assert.equal(run.status, "failed");
    assert.equal(run.results.length, strict ? 1 : 2);
    assert.deepEqual(seen, strict ? [] : ["/later"]);
    assert.match(run.results[0].error, /未完成/);
    assert.equal(
      (await new Store(root).get(p.id)).environments[0].variables.half,
      undefined,
    );
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    runNativeTaskPhase(
      [wait(10)],
      { request: {} },
      { signal: cancelled.signal },
    ),
    /取消/,
  );
});
