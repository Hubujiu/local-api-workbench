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
          url: base + "/later/A",
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
});
