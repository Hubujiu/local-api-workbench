import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
const script = (data) => ({ type: "customScript", enabled: 1, data });
const pick = (source, expression, name, type = "envVars") => ({
  type: "pickVars",
  enabled: 1,
  data: { source, variables: [{ name, type, expression }] },
});
async function upstream(t, version, handler) {
  const server = version === "2" ? http2.createServer() : http.createServer();
  const sessions = new Set();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("request", handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const session of sessions) session.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function application(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-request-workflow-"));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get store() {
      return app.store;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    async post(route, body, status = 200) {
      const response = await fetch(app.url + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return value;
    },
  };
}

for (const version of ["1.1", "2"])
  test(`request snapshot HTTP/${version} import, SDK edits, frozen plan, scopes, restart and strict failure`, async (t) => {
    const seen = [];
    const base = await upstream(t, version, (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({
          path: req.url,
          header: req.headers["x-source"],
          picked: req.headers["x-picked"],
          body,
        });
        res.statusCode = req.url.includes("fail") ? 500 : 200;
        res.end("ok");
      });
    });
    const app = await application(t),
      source = modernApipostFixture();
    source.global.envs = [];
    source.global.servers = [];
    source.global.global_vars = {};
    source.global.global_param.pre_tasks = [];
    source.global.global_param.post_tasks = [];
    source.apis[0].request.pre_tasks = [];
    source.apis[0].request.post_tasks = [];
    const api = source.apis[1];
    api.url = base + "/snapshot";
    api.protocol = version === "2" ? "http/2" : "http/1.1";
    api.method = "POST";
    api.request.query.parameter = [];
    api.request.header.parameter = [
      { key: "X-Source", value: "initial", is_checked: 1 },
    ];
    api.request.body = {
      mode: "raw",
      raw: '{"token":"body-token","value":3}',
      raw_parameter: [],
      parameter: [],
      raw_lang: "json",
    };
    api.request.pre_tasks = [
      pick("requestHeader", " x-source ", "h"),
      pick("requestBody", "$.token", "b", "globalVars"),
      script(
        'pm.request.headers.upsert({key:"X-Source",value:"edited"});pm.request.body.update("{\\"token\\":\\"wire-edited\\"}");',
      ),
      pick("requestHeader", "x-source", "again", "tempVars"),
      pick("requestBody", "$.value", "number"),
      script(
        'pm.test("snapshot still initial",()=>pm.expect(pm.variables.get("again")).to.equal("initial"));',
      ),
    ];
    api.request.post_tasks = [];
    api.request.pre_tasks.forEach((task, i) => {
      task.id = `request-${i}`;
      task.name = task.id;
    });
    const original = structuredClone(source),
      p = await app.store.create("request snapshots"),
      other = await app.store.create("isolation");
    importIntoProject(p, source);
    assert.deepEqual(source, original);
    // Canonical configured strict-JSON body; the native importer may label raw JSON as raw.
    assert(["raw", "json"].includes(p.requests[0].bodyType));
    await app.store.save(p);
    const isolated = await app.store.get(other.id);
    const later = {
      request: {
        url: base + "/later",
        httpVersion: version,
        inheritSharedScripts: false,
        headers: [
          { key: "x-picked", value: "{{h}}/{{b}}/{{number}}", enabled: true },
        ],
        beforeScript:
          'pm.test("temp isolation",()=>pm.expect(pm.variables.get("again")).to.equal(undefined));',
      },
    };
    const plan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: p.requests[0] }, later],
    });
    const live = await app.store.get(p.id);
    live.requests[0].headers[0].value = "different-live";
    await app.store.save(live);
    const run = await app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(seen.at(-2).header, "edited");
    assert.equal(seen.at(-2).body, '{"token":"wire-edited"}');
    assert.equal(seen.at(-1).picked, "initial/body-token/3");
    const saved = await app.store.get(p.id);
    assert.equal(saved.environments[0].variables.h, "initial");
    assert.equal(saved.environments[0].variables.number, 3);
    assert.equal(saved.globalVariables.b, "body-token");
    const restored = await app.post("/api/restore", { document: saved }, 201);
    assert.deepEqual(
      restored.plans.find((x) => x.id === plan.id).steps,
      plan.steps,
    );
    await app.restart();
    const rerun = await app.post(`/api/projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(rerun.status, "passed", JSON.stringify(rerun));
    assert.equal(seen.at(-1).picked, "initial/body-token/3");
    // Later row failure prevents all row assignments and all preceding phase mutations.
    const bad = structuredClone(plan.steps[0].request);
    bad.nativeTasks.before = [
      script('pm.environment.set("marker","must rollback");'),
      {
        ...pick("requestBody", "$.token", "first"),
        data: {
          source: "requestBody",
          variables: [
            { name: "first", type: "envVars", expression: "$.token" },
            { name: "missing", type: "envVars", expression: "$.missing" },
          ],
        },
      },
    ];
    const before = await app.store.get(p.id),
      count = seen.length;
    const badPlan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: bad }, later],
    });
    const failed = await app.post(`/api/projects/${p.id}/run`, {
      planId: badPlan.id,
    });
    assert.equal(failed.status, "failed");
    assert.equal(seen.length, count);
    assert.deepEqual(
      (await app.store.get(p.id)).environments,
      before.environments,
    );
    // A successful pre-phase commit is not rolled back by a subsequent failed HTTP response,
    // but extraction's strict contract stops the later request instead of using stale data.
    const network = structuredClone(plan.steps[0].request);
    network.url = base + "/fail";
    network.headers[0].value = "precommitted";
    network.nativeTasks.before = [pick("requestHeader", "x-source", "h")];
    const netPlan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: network }, later],
    });
    const prev = seen.length;
    const net = await app.post(`/api/projects/${p.id}/run`, {
      planId: netPlan.id,
    });
    assert.equal(net.status, "failed");
    assert.match(
      net.results[0].error,
      /仅后置变量变更未提交，成功前置变量已提交/,
    );
    assert.equal(seen.length, prev + 1);
    assert.equal(
      (await app.store.get(p.id)).environments[0].variables.h,
      "precommitted",
    );
    const offline = structuredClone(network);
    offline.url = "http://127.0.0.1:1/offline";
    const offlinePlan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: offline }, later],
    });
    const offlineCount = seen.length;
    const offlineRun = await app.post(`/api/projects/${p.id}/run`, {
      planId: offlinePlan.id,
    });
    assert.equal(offlineRun.status, "failed");
    assert.equal(seen.length, offlineCount);
    for (const failure of ["soft", "throw"]) {
      const postFailure = structuredClone(network);
      postFailure.url = base + "/post-error";
      postFailure.headers[0].value = "saved-pre-" + failure;
      postFailure.nativeTasks.after = [
        script(
          'pm.environment.set("afterMarker","uncommitted");pm.globals.set("afterGlobal","uncommitted");' +
            (failure === "soft"
              ? 'pm.test("soft failure",()=>{throw Error("intentional false")});'
              : 'throw Error("intentional post exception");'),
        ),
      ];
      const prior = seen.length;
      const failurePlan = await app.post(`/api/projects/${p.id}/plans`, {
        steps: [{ request: postFailure }, later],
      });
      const failureRun = await app.post(`/api/projects/${p.id}/run`, {
        planId: failurePlan.id,
      });
      assert.equal(failureRun.status, "failed");
      assert.equal(failureRun.results[0].response.status, 200);
      assert.equal(seen.length, prior + 1);
      const after = await app.store.get(p.id);
      assert.equal(after.environments[0].variables.h, "saved-pre-" + failure);
      assert(!Object.hasOwn(after.environments[0].variables, "afterMarker"));
      assert(!Object.hasOwn(after.globalVariables, "afterGlobal"));
    }
    const disabled = structuredClone(network);
    disabled.url = base + "/disabled";
    disabled.nativeTasks.before[0].enabled = 0;
    disabled.nativeTasks.after = [
      script(
        'pm.environment.set("ordinaryAfter","committed");pm.test("ordinary soft failure",()=>{throw Error("intentional false")});',
      ),
    ];
    const disabledPlan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: disabled }, later],
    });
    const disabledCount = seen.length;
    const disabledRun = await app.post(`/api/projects/${p.id}/run`, {
      planId: disabledPlan.id,
    });
    assert.equal(disabledRun.status, "failed");
    assert.equal(seen.length, disabledCount + 2);
    assert.equal(disabledRun.results[1].status, "passed");
    assert.equal(
      (await app.store.get(p.id)).environments[0].variables.ordinaryAfter,
      "committed",
    );
    assert.deepEqual(await app.store.get(other.id), isolated);
  });
