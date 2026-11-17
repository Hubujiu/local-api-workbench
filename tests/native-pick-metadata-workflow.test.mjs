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
const pick = (source) => ({
  type: "pickVars",
  enabled: 1,
  data: {
    source,
    variables: [
      { name: ` ${source} `, type: "envVars" },
      { name: `global${source}`, type: "globalVars", expression: "{{inert}}" },
      { name: `temp${source}`, type: "tempVars", expression: "$[*]" },
    ],
  },
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
  const root = await mkdtemp(path.join(tmpdir(), "native-metadata-workflow-"));
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
  test(`metadata HTTP/${version} import, all scopes, frozen plan, backup, restart and strict rollback`, async (t) => {
    const seen = [];
    const base = await upstream(t, version, (req, res) => {
      seen.push({
        url: req.url,
        code: req.headers["x-code"],
        size: req.headers["x-size"],
      });
      res.end("wire");
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
    api.url = base + "/metadata";
    api.protocol = version === "2" ? "http/2" : "http/1.1";
    api.request.query.parameter = [];
    api.request.header.parameter = [];
    api.request.pre_tasks = [];
    api.request.post_tasks = [
      ...Object.keys({ responseCode: 1, responseTime: 1, responseSize: 1 }).map(
        pick,
      ),
      script(
        `for(const name of ['responseCode','responseTime','responseSize']){pm.test(name,()=>{pm.expect(typeof pm.environment.get(name)).to.equal('number');pm.expect(pm.variables.get('temp'+name)).to.equal(pm.environment.get(name));pm.expect(pm.globals.get('global'+name)).to.equal(pm.environment.get(name));});}`,
      ),
    ];
    api.request.post_tasks.forEach((task, i) => {
      task.id = `meta-${i}`;
      task.name = `meta-${i}`;
    });
    const original = structuredClone(source),
      p = await app.store.create("metadata"),
      other = await app.store.create("isolation");
    importIntoProject(p, source);
    assert.deepEqual(source, original);
    await app.store.save(p);
    const untouched = await app.store.get(other.id);
    assert.deepEqual(
      p.requests[0].nativeTasks.after[1].data,
      api.request.post_tasks[1].data,
    );
    const resource = {
      request: {
        url: base + "/later",
        httpVersion: version,
        inheritSharedScripts: false,
        headers: [
          { key: "x-code", value: "{{responseCode}}", enabled: true },
          { key: "x-size", value: "{{responseSize}}", enabled: true },
        ],
        beforeScript:
          'pm.test("temporary isolated",()=>pm.expect(pm.variables.get("tempresponseCode")).to.equal(undefined));',
      },
    };
    const plan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: p.requests[0] }, resource],
    });
    const live = await app.store.get(p.id);
    live.requests[0].nativeTasks.after[0].data.variables[0].name = "changed";
    await app.store.save(live);
    const run = await app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(seen.at(-1).code, "200");
    assert.equal(seen.at(-1).size, "4");
    assert.equal(run.results[0].response.status, 200);
    assert.equal(run.results[0].response.size, 4);
    const disk = await new Store(app.root).get(p.id);
    for (const key of ["responseCode", "responseTime", "responseSize"]) {
      assert.equal(typeof disk.environments[0].variables[key], "number");
      assert.equal(
        disk.globalVariables[`global${key}`],
        disk.environments[0].variables[key],
      );
    }
    assert(!Object.hasOwn(disk.environments[0].variables, "changed"));
    const restored = await app.post("/api/restore", { document: disk }, 201);
    assert.deepEqual(
      restored.plans.find((x) => x.id === plan.id).steps,
      plan.steps,
    );
    await app.restart();
    const rerun = await app.post(`/api/projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(rerun.status, "passed", JSON.stringify(rerun));
    // Safe current-facade edits affect extraction, never original transport evidence.
    const edited = structuredClone(plan.steps[0].request);
    edited.nativeTasks.after.unshift(
      script(
        "pm.response.code=201;pm.response.responseTime=12.5;pm.response.responseSize=8;",
      ),
    );
    const editedPlan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: edited }, resource],
    });
    const changed = await app.post(`/api/projects/${p.id}/run`, {
      planId: editedPlan.id,
    });
    assert.equal(changed.status, "passed", JSON.stringify(changed));
    assert.equal(seen.at(-1).code, "201");
    assert.equal(seen.at(-1).size, "8");
    assert.equal(changed.results[0].response.status, 200);
    assert.equal(changed.results[0].response.size, 4);
    for (const modification of [
      "delete pm.response.responseSize;",
      "Object.defineProperty(pm.response,'responseTime',{enumerable:true,get(){throw Error('GETTER CALLED')}})",
      "pm.response.responseSize=NaN;",
    ]) {
      const bad = structuredClone(plan.steps[0].request);
      bad.nativeTasks.after.unshift(
        script("pm.environment.set('marker','rollback');" + modification),
      );
      const before = await app.store.get(p.id),
        count = seen.length;
      const badPlan = await app.post(`/api/projects/${p.id}/plans`, {
        steps: [{ request: bad }, resource],
      });
      const failed = await app.post(`/api/projects/${p.id}/run`, {
        planId: badPlan.id,
      });
      assert.equal(failed.status, "failed");
      assert.equal(seen.length, count + 1);
      assert.doesNotMatch(failed.results[0].error, /GETTER CALLED/);
      assert.deepEqual(
        (await app.store.get(p.id)).environments,
        before.environments,
      );
      assert.deepEqual(
        (await app.store.get(p.id)).globalVariables,
        before.globalVariables,
      );
    }
    assert.deepEqual(await app.store.get(other.id), untouched);
  });
