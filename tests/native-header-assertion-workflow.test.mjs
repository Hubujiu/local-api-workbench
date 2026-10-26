import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { importIntoProject, runPlan, snapshotPlan } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const assertion = (id, path, compareValue, compareType = "eq") => ({
  type: "assert",
  id,
  name: id,
  enabled: 1,
  data: {
    type: "responseHeader",
    expression: { path, compareType, compareValue },
  },
});
const pick = (enabled = 1) => ({
  type: "pickVars",
  id: "pick-token",
  name: "pick token",
  enabled,
  data: {
    source: "responseHeader",
    variables: [{ name: "token", expression: "x-token", type: "envVars" }],
  },
});
const tasks = (after, before = []) => ({ version: 1, before, after });

async function fixture(t, version, handler) {
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

async function workbench(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-header-assertion-"));
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
    restart: async () => {
      await stop();
      app = await createApp({ root, port: 0 });
    },
    post: async (route, body, status = 200) => {
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

function headerSource(base, version) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.post_tasks = [
    script("project", 'const order=["project"];'),
  ];
  source.apis[0].request.post_tasks = [
    script("folder", 'order.push("folder");'),
  ];
  const api = source.apis[1];
  api.url = base + "/login/{{tenant}}";
  api.protocol = version === "2" ? "http/2" : "http/1.1";
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.post_tasks = [
    script(
      "view",
      'order.push("api");response.headers["x-state"]="view:"+response.headers["x-state"];delete response.headers["x-delete"];apt.response.setBody("<html>processed</html>");apt.response.setCode(201);',
    ),
    assertion("current casefold", "X-StAtE", "view:ready"),
    assertion("empty", "x-empty", ""),
    assertion("comma literal", "x-comma", "one, literal"),
    assertion("literal undefined", "x-undefined", "undefined"),
    assertion("missing", "x-missing", "undefined"),
    assertion("no trim", " x-state ", "undefined"),
    assertion("deleted", "x-delete", "undefined"),
    script(
      "after",
      'order.push("after");tests.length=0;pm.environment.set("token",response.headers["x-token"]);pm.environment.set("order",order.join(","));pm.globals.set("sharedToken",response.headers["x-token"]);pm.variables.set("localOnly","temporary");',
    ),
  ];
  return source;
}

for (const version of ["1.1", "2"])
  test(`native header assertions HTTP/${version} close HTML import, soft failure, frozen plan, scope receipt, backup and restart`, async (t) => {
    const seen = [];
    let ready = false;
    const base = await fixture(t, version, (req, res) => {
      seen.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader("content-type", "text/html");
      res.setHeader("x-token", "wire-" + req.url.split("/").at(-1));
      res.setHeader("x-state", ready ? "ready" : "blocked");
      res.setHeader("x-empty", "");
      res.setHeader("x-comma", "one, literal");
      res.setHeader("x-undefined", "undefined");
      res.setHeader("x-delete", "initially present");
      res.end("<html>wire is not JSON</html>");
    });
    const app = await workbench(t);
    const source = headerSource(base, version),
      original = structuredClone(source);
    const p = await app.store.create("header assertions");
    importIntoProject(p, source);
    assert.deepEqual(source, original);
    assert.equal(p.requests[0].httpVersion, version);
    p.environments[0].variables.tenant = "A";
    p.environments.push({
      id: "header-assertion-B",
      name: "B",
      variables: { tenant: "B" },
    });
    await app.store.save(p);
    const later = {
      request: {
        url: base + "/later",
        httpVersion: version,
        auth: { type: "bearer", token: "{{token}}" },
        beforeScript:
          'pm.test("local isolation",()=>pm.expect(pm.variables.get("localOnly")).to.equal(undefined));',
      },
    };
    const plan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: p.requests[0] }, later],
    });
    const live = await app.store.get(p.id);
    live.requests[0].nativeTasks.after.find(
      (task) => task.type === "assert",
    ).data.expression.compareValue = "edited after freeze";
    await app.store.save(live);
    for (const [environmentId, tenant, passes] of [
      [p.environments[0].id, "A", false],
      ["header-assertion-B", "B", true],
    ]) {
      ready = passes;
      const run = await app.post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        environmentId,
      });
      assert.equal(
        run.status,
        passes ? "passed" : "failed",
        JSON.stringify(run),
      );
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 2);
      assert.equal(run.results[1].status, "passed");
      assert.deepEqual(
        run.results[0].assertions.map((entry) => [entry.name, entry.passed]),
        [
          ["current casefold", passes],
          ["empty", true],
          ["comma literal", true],
          ["literal undefined", true],
          ["missing", true],
          ["no trim", true],
          ["deleted", true],
        ],
      );
      assert.equal(seen.at(-1).authorization, `Bearer wire-${tenant}`);
      assert.equal(
        run.results[0].response.headers["x-state"],
        passes ? "ready" : "blocked",
      );
      assert.equal(
        run.results[0].response.headers["x-delete"],
        "initially present",
      );
      assert.equal(
        run.results[0].response.body,
        "<html>wire is not JSON</html>",
      );
      assert.equal(run.results[0].response.status, 200);
      assert.deepEqual(run.results[0].scriptResponse, {
        body: "<html>processed</html>",
        status: 201,
      });
      assert.deepEqual(
        run.results[0].request.nativeTasks,
        plan.steps[0].request.nativeTasks,
      );
      const saved = await new Store(app.root).get(p.id);
      const environment = saved.environments.find(
        (entry) => entry.id === environmentId,
      );
      assert.equal(environment.variables.token, `wire-${tenant}`);
      assert.equal(environment.variables.order, "project,folder,api,after");
      assert.equal(saved.globalVariables.sharedToken, `wire-${tenant}`);
      assert(!Object.hasOwn(environment.variables, "localOnly"));
      assert.equal(
        saved.runs.find((entry) => entry.id === run.id).status,
        run.status,
      );
    }
    ready = false;
    const executed = await app.post(`/api/projects/${p.id}/execute`, {
      request: { ...plan.steps[0].request, url: base + "/login/receipt" },
      environmentId: "header-assertion-B",
    });
    assert.equal(executed.outcome, "failed");
    assert.equal(executed.assertions[0].passed, false);
    assert.equal(executed.variableWrites.environmentId, "header-assertion-B");
    assert.equal(executed.variableWrites.commits, 1);
    assert(
      executed.variableWrites.changes.some(
        (change) =>
          change.scope === "environment" &&
          change.name === "token" &&
          change.after.value === "wire-receipt",
      ),
    );
    assert(
      !executed.variableWrites.changes.some(
        (change) => change.name === "localOnly",
      ),
    );
    const receiptDisk = await new Store(app.root).get(p.id);
    assert.equal(receiptDisk.environments[0].variables.token, "wire-A");
    assert.equal(receiptDisk.environments[1].variables.token, "wire-receipt");
    const restored = await app.post(
      "/api/restore",
      { document: receiptDisk },
      201,
    );
    assert.deepEqual(
      restored.plans[0].steps[0].request.nativeTasks,
      plan.steps[0].request.nativeTasks,
    );
    await app.restart();
    ready = true;
    const rerun = await app.post(`/api/projects/${restored.id}/run`, {
      planId: plan.id,
      environmentId: "header-assertion-B",
    });
    assert.equal(rerun.status, "passed", JSON.stringify(rerun));
    assert.equal(rerun.recordSaved, true);
    assert.equal(seen.at(-1).authorization, "Bearer wire-B");
    const other = await app.store.create("other header assertion project");
    importIntoProject(other, source);
    other.environments[0].variables.tenant = "C";
    await app.store.save(other);
    const otherPlan = await app.post(`/api/projects/${other.id}/plans`, {
      steps: [{ request: other.requests[0] }, later],
    });
    const concurrent = await Promise.all([
      app.post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        environmentId: p.environments[0].id,
      }),
      app.post(`/api/projects/${other.id}/run`, { planId: otherPlan.id }),
    ]);
    assert(
      concurrent.every((run) => run.status === "passed"),
      JSON.stringify(concurrent),
    );
    const first = await new Store(app.root).get(p.id),
      second = await new Store(app.root).get(other.id);
    assert.equal(first.environments[0].variables.token, "wire-A");
    assert.equal(first.environments[1].variables.token, "wire-receipt");
    assert.equal(first.globalVariables.sharedToken, "wire-A");
    assert.equal(second.environments[0].variables.token, "wire-C");
    assert.equal(second.globalVariables.sharedToken, "wire-C");
    const count = seen.length;
    await app.post(
      `/api/projects/${p.id}/run`,
      { planId: plan.id, environmentId: other.environments[0].id },
      400,
    );
    assert.equal(seen.length, count);
  });

for (const version of ["1.1", "2"])
  test(`native header assertions HTTP/${version} retain ordinary continuation and only active pick enforces strict rollback`, async (t) => {
    const seen = [];
    let duplicate = false;
    const base = await fixture(t, version, (req, res) => {
      seen.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader("x-token", "fresh");
      res.setHeader("x-state", duplicate ? ["blocked", "ready"] : "blocked");
      res.end("<html>not JSON</html>");
    });
    const app = await workbench(t);
    for (const sample of [
      { name: "soft false", prefix: [], soft: true },
      { name: "disabled pick stays soft", prefix: [pick(0)], soft: true },
      {
        name: "active pick plus soft false is strict",
        prefix: [pick()],
        strict: true,
      },
      {
        name: "duplicate lookup is ordinary stage error",
        prefix: [],
        duplicate: true,
      },
      {
        name: "active pick plus duplicate stage error is strict",
        prefix: [pick()],
        duplicate: true,
        strict: true,
      },
    ])
      await t.test(sample.name, async () => {
        duplicate = Boolean(sample.duplicate);
        seen.length = 0;
        const p = await app.store.create(sample.name);
        p.environments[0].variables.token = "stale";
        await app.store.save(p);
        const plan = await app.post(`/api/projects/${p.id}/plans`, {
          steps: [
            {
              request: {
                url: base + "/first",
                httpVersion: version,
                inheritSharedScripts: false,
                nativeTasks: tasks(
                  [
                    script(
                      "post",
                      'pm.environment.set("postOnly","committed only on soft failure");',
                    ),
                    ...sample.prefix,
                    assertion("header state", "x-state", "ready"),
                    script(
                      "after",
                      'pm.environment.set("followingTask","yes");tests.length=0;',
                    ),
                  ],
                  [
                    script(
                      "pre",
                      'pm.environment.set("beforeProof","committed");',
                    ),
                  ],
                ),
              },
            },
            {
              request: {
                url: base + "/later",
                httpVersion: version,
                auth: { type: "bearer", token: "{{token}}" },
              },
            },
          ],
        });
        const run = await app.post(`/api/projects/${p.id}/run`, {
          planId: plan.id,
        });
        assert.equal(run.status, "failed", JSON.stringify(run));
        assert.equal(run.recordSaved, true);
        assert.equal(run.results.length, sample.strict ? 1 : 2);
        assert.equal(seen.length, sample.strict ? 1 : 2);
        if (!sample.strict)
          assert.equal(seen.at(-1).authorization, "Bearer stale");
        if (sample.duplicate)
          assert.match(run.results[0].error, /响应头|Header|header/);
        else
          assert.equal(
            run.results[0].assertions.find(
              (entry) => entry.name === "header state",
            ).passed,
            false,
          );
        const saved = await new Store(app.root).get(p.id);
        assert.equal(saved.environments[0].variables.token, "stale");
        assert.equal(saved.environments[0].variables.beforeProof, "committed");
        assert.equal(
          saved.environments[0].variables.postOnly,
          sample.soft ? "committed only on soft failure" : undefined,
        );
        assert.equal(
          saved.environments[0].variables.followingTask,
          sample.soft ? "yes" : undefined,
        );
        assert.equal(
          saved.runs.find((entry) => entry.id === run.id).results.length,
          sample.strict ? 1 : 2,
        );
      });
  });

test("native header assertion cancellation discards post writes after a completed comparison and never starts the later request", async (t) => {
  const seen = [],
    commits = [];
  const controller = new AbortController();
  const base = await fixture(t, "1.1", (req, res) => {
    seen.push(req.url);
    if (req.url === "/pause") {
      controller.abort();
      return;
    }
    res.setHeader("x-state", "ready");
    res.end("<html>not JSON</html>");
  });
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: base + "/first",
          inheritSharedScripts: false,
          nativeTasks: tasks(
            [
              assertion("completed before cancellation", "x-state", "ready"),
              script(
                "wait",
                `pm.environment.set("postOnly","discard");await pm.sendRequest({url:${JSON.stringify(base + "/pause")}});`,
              ),
            ],
            [script("pre", 'pm.environment.set("beforeProof","committed");')],
          ),
        },
      },
      { request: { url: base + "/later" } },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest, {
    variableScopes: { environment: {} },
    signal: controller.signal,
    onScopeChanges: async (changes) => commits.push(structuredClone(changes)),
  });
  assert.equal(result.status, "cancelled", JSON.stringify(result));
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].error, /取消/);
  assert.deepEqual(seen, ["/first", "/pause"]);
  assert.equal(result.variables.beforeProof, "committed");
  assert(!Object.hasOwn(result.variables, "postOnly"));
  assert.equal(commits.length, 1);
  assert.deepEqual(
    commits[0].map((change) => change.name),
    ["beforeProof"],
  );
});
