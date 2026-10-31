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
const pick = (name = "cookie", expression = " Session ", type = "envVars") => ({
  type: "pickVars",
  enabled: 1,
  data: { source: "responseCookie", variables: [{ name, expression, type }] },
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
  const root = await mkdtemp(path.join(tmpdir(), "native-cookie-workflow-"));
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
  test(`Cookie HTTP/${version} import current edits scopes next request frozen plan restore restart rollback`, async (t) => {
    const seen = [];
    const base = await upstream(t, version, (req, res) => {
      seen.push({ url: req.url, token: req.headers["x-cookie"] });
      res.setHeader(
        "set-cookie",
        req.url === "/bad"
          ? ["Session=one", "Session=two"]
          : ["Session=A=B==; HttpOnly; Path=/", "case=%E4%B8%AD", "bad=%ZZ"],
      );
      res.end("HTML login");
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
    api.url = base + "/login";
    api.protocol = version === "2" ? "http/2" : "http/1.1";
    api.request.query.parameter = [];
    api.request.header.parameter = [];
    api.request.pre_tasks = [];
    api.request.post_tasks = [
      pick(" initial "),
      script("response.cookies.Session='edited';"),
      {
        ...pick(),
        data: {
          source: "responseCookie",
          variables: [
            { name: "cookie", expression: " Session ", type: "envVars" },
            { name: "cookieGlobal", expression: "Session", type: "globalVars" },
            { name: "cookieTemp", expression: "Session", type: "tempVars" },
          ],
        },
      },
      script(
        "pm.test('same-phase scopes',()=>{pm.expect(pm.environment.get(' initial ')).to.equal('A=B==');pm.expect(pm.environment.get('cookie')).to.equal('edited');pm.expect(pm.globals.get('cookieGlobal')).to.equal('edited');pm.expect(pm.variables.get('cookieTemp')).to.equal('edited');})",
      ),
    ];
    api.request.post_tasks.forEach((task, i) => {
      task.id = "cookie-" + i;
      task.name = "cookie-" + i;
    });
    const original = structuredClone(source),
      p = await app.store.create("cookie"),
      other = await app.store.create("isolated");
    importIntoProject(p, source);
    assert.deepEqual(source, original);
    await app.store.save(p);
    const untouched = await app.store.get(other.id);
    assert.deepEqual(
      p.requests[0].nativeTasks.after[0].data,
      api.request.post_tasks[0].data,
    );
    const resource = {
      request: {
        url: base + "/later",
        httpVersion: version,
        inheritSharedScripts: false,
        headers: [{ key: "x-cookie", value: "{{cookie}}", enabled: true }],
        beforeScript:
          "pm.test('temporary isolated',()=>pm.expect(pm.variables.get('cookieTemp')).to.equal(undefined));",
      },
    };
    const plan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: p.requests[0] }, resource],
    });
    const live = await app.store.get(p.id);
    live.requests[0].nativeTasks.after[0].data.variables[0].expression =
      "missing";
    await app.store.save(live);
    const run = await app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(seen.at(-1).token, "edited");
    assert.equal(
      run.results[0].response.headers["set-cookie"][0],
      "Session=A=B==; HttpOnly; Path=/",
    );
    const disk = await new Store(app.root).get(p.id);
    assert.equal(disk.environments[0].variables.cookie, "edited");
    assert.equal(disk.globalVariables.cookieGlobal, "edited");
    assert.equal(disk.environments[0].variables[" initial "], "A=B==");
    assert.equal(
      Object.hasOwn(disk.environments[0].variables, "cookieTemp"),
      false,
    );
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
    for (const modification of [
      "delete response.cookies.Session;",
      "Object.defineProperty(response.cookies,'Session',{enumerable:true,get(){throw Error('GETTER CALLED')}})",
      "response.cookies.Session={};",
      "missing-later-row",
      "duplicate-wire",
      "post-soft",
      "post-throw",
    ]) {
      const bad = structuredClone(plan.steps[0].request);
      bad.nativeTasks.after = [
        script(
          "pm.environment.set('marker','rollback');pm.globals.set('marker','rollback');",
        ),
        pick(),
      ];
      if (modification === "missing-later-row")
        bad.nativeTasks.after[1].data.variables.push({
          name: "never",
          expression: "missing",
          type: "globalVars",
        });
      else if (modification === "duplicate-wire") bad.url = base + "/bad";
      else if (modification === "post-soft")
        bad.nativeTasks.after.push(
          script("pm.test('failure',()=>{throw Error('intentional false')})"),
        );
      else if (modification === "post-throw")
        bad.nativeTasks.after.push(script("throw Error('post failure')"));
      else bad.nativeTasks.after.splice(1, 0, script(modification));
      const before = await app.store.get(p.id),
        count = seen.length;
      const badPlan = await app.post(`/api/projects/${p.id}/plans`, {
        steps: [{ request: bad }, resource],
      });
      const failed = await app.post(`/api/projects/${p.id}/run`, {
        planId: badPlan.id,
      });
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.equal(seen.length, count + 1);
      assert.doesNotMatch(failed.results[0].error || "", /GETTER CALLED/);
      const after = await new Store(app.root).get(p.id);
      assert.deepEqual(after.environments, before.environments);
      assert.deepEqual(after.globalVariables, before.globalVariables);
    }
    assert.deepEqual(await app.store.get(other.id), untouched);
  });
