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
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const row = (name, type = "envVars", expression) => ({
  name,
  type,
  ...(expression === undefined ? {} : { expression }),
});
const pick = (variables = [row("token")], enabled = 1) => ({
  type: "pickVars",
  id: "text-extract",
  name: "Text extract",
  enabled,
  data: { source: "responseText", variables },
});
const tasks = (after, before = []) => ({ version: 1, before, after });

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
  const root = await mkdtemp(path.join(tmpdir(), "native-text-workflow-"));
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

function sourceFor(base, version) {
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
      'order.push("api");const prefix="prefix:";apt.response.setBody(pm.response.text()+"-view");apt.response.setCode(201);',
    ),
    pick([
      row(" token "),
      row("\tsameRequest\t", "tempVars", "{{ignored}}"),
      row(
        " sharedToken ",
        "globalVars",
        '(() => { throw Error("must not execute") })()',
      ),
    ]),
    pick([row(" ", "envVars", "$[*]")], 0),
    script(
      "same-phase",
      'pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("order",order.join(","));pm.test("same phase",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(pm.environment.get("token")));',
    ),
  ];
  return source;
}

for (const version of ["1.1", "2"])
  test(`native responseText HTTP/${version} login closes import, trim-only names, scopes, Bearer, frozen plan, backup and restart`, async (t) => {
    const received = [];
    const base = await upstream(t, version, (req, res) => {
      received.push({
        path: req.url,
        authorization: req.headers.authorization,
      });
      res.setHeader("content-type", "text/plain");
      res.end(
        req.url.startsWith("/login/") ? "wire-" + req.url.slice(7) : "resource",
      );
    });
    const app = await application(t),
      source = sourceFor(base, version),
      original = structuredClone(source),
      p = await app.store.create("Text login");
    importIntoProject(p, source);
    assert.equal(p.requests[0].httpVersion, version);
    p.environments[0].variables.tenant = "A";
    p.environments.push({
      id: "text-other-env",
      name: "B",
      variables: { tenant: "B" },
    });
    await app.store.save(p);
    assert.deepEqual(source, original);
    assert.deepEqual(
      p.requests[0].nativeTasks.after
        .slice(0, 2)
        .map((entry) => entry.origin.scope),
      ["project", "folder"],
    );
    assert.deepEqual(
      p.requests[0].nativeTasks.after.find((entry) => entry.type === "pickVars")
        .data,
      source.apis[1].request.post_tasks[1].data,
    );
    const resource = {
      request: {
        url: base + "/resource",
        httpVersion: version,
        beforeScript:
          'pm.test("temporary isolation",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(undefined));',
        auth: { type: "bearer", token: "{{token}}" },
      },
    };
    const plan = await app.post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: p.requests[0] }, resource],
    });
    const live = await app.store.get(p.id);
    live.requests[0].nativeTasks.after.find(
      (entry) => entry.type === "pickVars",
    ).data.variables[0].name = "redirectedToken";
    await app.store.save(live);
    for (const [environmentId, tenant] of [
      [p.environments[0].id, "A"],
      ["text-other-env", "B"],
    ]) {
      const run = await app.post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        environmentId,
      });
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(received.at(-1).authorization, `Bearer wire-${tenant}-view`);
      assert.equal(run.results[0].response.body, `wire-${tenant}`);
      assert.equal(run.results[0].response.status, 200);
      assert.deepEqual(run.results[0].scriptResponse, {
        body: `wire-${tenant}-view`,
        status: 201,
      });
      const saved = await new Store(app.root).get(p.id),
        env = saved.environments.find((entry) => entry.id === environmentId);
      assert.equal(env.variables.token, `wire-${tenant}-view`);
      assert.equal(env.variables.derived, `prefix:wire-${tenant}-view`);
      assert.equal(env.variables.order, "project,folder,api");
      assert.equal(saved.globalVariables.sharedToken, `wire-${tenant}-view`);
      for (const absent of ["sameRequest", " token ", "redirectedToken", " "])
        assert(!Object.hasOwn(env.variables, absent), absent);
    }
    const other = await app.store.create("isolated text project");
    importIntoProject(other, source);
    other.environments[0].variables.tenant = "C";
    await app.store.save(other);
    const otherPlan = await app.post(`/api/projects/${other.id}/plans`, {
      steps: [{ request: other.requests[0] }, resource],
    });
    const concurrent = await Promise.all([
      app.post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        environmentId: p.environments[0].id,
      }),
      app.post(`/api/projects/${other.id}/run`, { planId: otherPlan.id }),
    ]);
    for (const run of concurrent)
      assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(
      (await new Store(app.root).get(p.id)).environments[0].variables.token,
      "wire-A-view",
    );
    assert.equal(
      (await new Store(app.root).get(other.id)).environments[0].variables.token,
      "wire-C-view",
    );
    const count = received.length;
    await app.post(
      `/api/projects/${p.id}/run`,
      { planId: plan.id, environmentId: other.environments[0].id },
      400,
    );
    assert.equal(received.length, count);
    const saved = await new Store(app.root).get(p.id),
      restored = await app.post("/api/restore", { document: saved }, 201);
    assert.deepEqual(
      restored.plans[0].steps[0].request.nativeTasks,
      saved.plans[0].steps[0].request.nativeTasks,
    );
    const frozenText =
      restored.plans[0].steps[0].request.nativeTasks.after.find(
        (entry) => entry.type === "pickVars",
      );
    assert.deepEqual(
      frozenText.data,
      source.apis[1].request.post_tasks[1].data,
    );
    assert(!Object.hasOwn(frozenText.data.variables[0], "expression"));
    await app.restart();
    const again = await app.post(`/api/projects/${restored.id}/run`, {
      planId: plan.id,
      environmentId: "text-other-env",
    });
    assert.equal(again.status, "passed", JSON.stringify(again));
    assert.equal(received.at(-1).authorization, "Bearer wire-B-view");
  });

for (const version of ["1.1", "2"])
  test(`native responseText HTTP/${version} preserves empty and Unicode non-JSON text without interpreting expression`, async (t) => {
    const values = [
      "",
      "雪🙂\n<not-json> & {{literal}}",
      '{"token":"whole JSON text, not a path"}',
    ];
    const base = await upstream(t, version, (req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(values[Number(req.url.slice(1))]);
    });
    for (let index = 0; index < values.length; index++) {
      const response = await executeRequest({
          url: base + "/" + index,
          httpVersion: version,
        }),
        original = structuredClone(response);
      const result = await runNativeTaskPhase(
        [
          pick([
            row(" text "),
            row(" local ", "tempVars", "$.token"),
            row(" shared ", "globalVars", "string(/login/token)"),
          ]),
          script(
            "read",
            'pm.test("identical text",()=>pm.expect(pm.variables.get("local")).to.equal(pm.environment.get("text")));',
          ),
        ],
        { request: {}, response },
      );
      assert.equal(result.scopes.environment.text, values[index]);
      assert.equal(result.scopes.globals.shared, values[index]);
      assert.equal(result.localVariables.local, values[index]);
      assert.deepEqual(response, original);
    }
  });

test("native responseText failures roll back post changes, keep pre commits and stop stale Bearer requests", async (t) => {
  const seen = [];
  let active;
  const base = await upstream(t, "1.1", (req, res) => {
    seen.push(req.url);
    if (active.disconnect) return req.socket.destroy();
    res.statusCode = active.status ?? 200;
    res.setHeader("content-type", "text/plain");
    res.end(active.body ?? "fresh");
  });
  const app = await application(t);
  const samples = [
    { name: "ASCII body over 64KiB", body: "x".repeat(65537) },
    { name: "UTF8 body over 64KiB", body: "é".repeat(32769) },
    {
      name: "processed body is not a string",
      after: [script("body", "response.body=42;"), pick()],
    },
    {
      name: "processed body is missing",
      after: [script("body", "delete response.body;"), pick()],
    },
    {
      name: "processed body has invalid Unicode",
      after: [script("body", 'response.body="\\ud800";'), pick()],
    },
    {
      name: "later text task rejects and rolls back earlier extraction",
      after: [
        pick(),
        script("body", "response.body=null;"),
        pick([row("other")]),
      ],
    },
    {
      name: "return cannot skip text extraction",
      after: [script("early", "return;"), pick()],
      error: /未完成/,
    },
    {
      name: "return cannot hide a later text task",
      after: [pick(), script("early", "return;"), pick([row("other")])],
      error: /未完成/,
    },
    {
      name: "cross-task catch cannot hide text failure",
      after: [
        script("try", "response.body=null;try {"),
        pick(),
        script("catch", "} catch (ignored) {}"),
      ],
      error: /未完成/,
    },
    {
      name: "post assertion rolls back extracted text",
      after: [
        pick(),
        script(
          "reject",
          'pm.test("reject",()=>pm.expect(false).to.equal(true));',
        ),
      ],
      error: /断言/,
    },
    {
      name: "post throw rolls back extracted text",
      after: [pick(), script("reject", 'throw Error("text post rejection");')],
      error: /text post rejection/,
    },
    {
      name: "wire 500 is not hidden by processed response",
      status: 500,
      after: [
        script(
          "view",
          'apt.response.setCode(200);apt.response.setBody("view");',
        ),
        pick(),
      ],
      error: /原始响应状态/,
    },
    {
      name: "pre failure prevents stale followup",
      before: [script("reject", 'throw Error("text pre rejection");')],
      error: /text pre rejection/,
    },
    {
      name: "network failure prevents stale followup",
      disconnect: true,
      error: /socket hang up|fetch failed/,
    },
  ];
  for (const sample of samples)
    await t.test(sample.name, async () => {
      active = sample;
      seen.length = 0;
      const p = await app.store.create(sample.name);
      p.environments[0].variables.token = "stale";
      p.globalVariables.priorGlobal = "saved";
      await app.store.save(p);
      const plan = await app.post(`/api/projects/${p.id}/plans`, {
        steps: [
          {
            request: {
              url: base + "/login",
              inheritSharedScripts: false,
              nativeTasks: tasks(
                [
                  script(
                    "post-change",
                    'pm.environment.set("postOnly","rollback");pm.globals.set("postGlobal","rollback");',
                  ),
                  ...(sample.after ?? [pick()]),
                ],
                sample.before ?? [
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
      assert.equal(run.results.length, 1);
      assert.match(
        run.results[0].error,
        sample.error ?? /pickVars|正文|Unicode|64KiB/,
      );
      assert.deepEqual(seen, sample.before ? [] : ["/login"]);
      assert.equal(run.variables.token, "stale");
      assert(!Object.hasOwn(run.variables, "postOnly"));
      const disk = await new Store(app.root).get(p.id);
      assert.equal(disk.environments[0].variables.token, "stale");
      assert.equal(
        disk.environments[0].variables.beforeProof,
        sample.before ? undefined : "committed",
      );
      assert(!Object.hasOwn(disk.environments[0].variables, "postOnly"));
      assert(!Object.hasOwn(disk.globalVariables, "postGlobal"));
      assert.equal(disk.globalVariables.priorGlobal, "saved");
      assert.equal(
        disk.runs.find((entry) => entry.id === run.id).results.length,
        1,
      );
    });
});

test("native responseText cancellation discards extracted post variables and disabled-only text retains legacy continuation", async (t) => {
  const seen = [],
    controller = new AbortController();
  const base = await upstream(t, "1.1", (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === "/pause") {
      controller.abort();
      return;
    }
    res.end("fresh");
  });
  const planFor = (after) =>
    snapshotPlan({
      steps: [
        {
          request: {
            url: base + "/login",
            inheritSharedScripts: false,
            nativeTasks: tasks(after, [
              script("pre", 'pm.environment.set("beforeProof","committed");'),
            ]),
          },
        },
        {
          request: {
            url: base + "/later",
            auth: { type: "bearer", token: "{{token}}" },
          },
        },
      ],
    });
  const commits = [];
  const cancelled = await runPlan(
    planFor([
      pick(),
      script(
        "wait",
        `await pm.sendRequest({url:${JSON.stringify(base + "/pause")}});`,
      ),
    ]),
    { token: "stale" },
    executeRequest,
    {
      variableScopes: { environment: { token: "stale" } },
      signal: controller.signal,
      onScopeChanges: async (changes) => commits.push(structuredClone(changes)),
    },
  );
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.equal(cancelled.results.length, 1);
  assert.match(cancelled.results[0].error, /取消/);
  assert.deepEqual(
    seen.map((entry) => entry.path),
    ["/login", "/pause"],
  );
  assert.equal(cancelled.variables.token, "stale");
  assert.equal(cancelled.variables.beforeProof, "committed");
  assert.equal(commits.length, 1);
  assert.deepEqual(
    commits[0].map((change) => change.name),
    ["beforeProof"],
  );
  seen.length = 0;
  const disabled = await runPlan(
    planFor([
      pick([row(" ", "envVars", "{{not evaluated}}")], 0),
      script("legacy", 'throw Error("disabled text keeps legacy behavior");'),
    ]),
    { token: "stale" },
    executeRequest,
    { variableScopes: { environment: { token: "stale" } } },
  );
  assert.equal(disabled.status, "failed");
  assert.equal(disabled.results.length, 2);
  assert.deepEqual(
    seen.map((entry) => entry.path),
    ["/login", "/later"],
  );
  assert.equal(seen.at(-1).authorization, "Bearer stale");
});
