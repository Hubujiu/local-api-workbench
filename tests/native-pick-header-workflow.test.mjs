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
const row = (name, expression, type = "envVars") => ({
  name,
  expression,
  type,
});
const pick = (variables, source = "responseHeader", enabled = 1) => ({
  type: "pickVars",
  id: "header-extract",
  name: "Header extract",
  enabled,
  data: { source, variables },
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
      "before-extract",
      'order.push("api");const prefix="prefix:";response.headers["x-token"]+="-view";apt.response.setBody("<html>processed login</html>");apt.response.setCode(201);',
    ),
    pick([
      row("token", " X-ToKeN "),
      row("sameRequest", "x-token", "tempVars"),
      row("sharedToken", "X-TOKEN", "globalVars"),
      row("empty", "x-empty"),
      row("comma", "x-comma"),
    ]),
    script(
      "after-extract",
      'pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("order",order.join(","));pm.test("same phase",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(pm.environment.get("token")));',
    ),
  ];
  return source;
}

for (const version of ["1.1", "2"])
  test(`native responseHeader HTTP/${version} HTML login closes import, frozen plan, scopes, Bearer, backup and restart`, async (t) => {
    const received = [];
    const base = await fixture(t, version, (req, res) => {
      received.push({
        path: req.url,
        authorization: req.headers.authorization,
      });
      res.setHeader("content-type", "text/html");
      if (req.url.startsWith("/login/")) {
        res.setHeader("x-token", "wire-" + req.url.slice(7));
        res.setHeader("x-empty", "");
        res.setHeader("x-comma", "one, literal");
      }
      res.end("<html>wire login is not JSON</html>");
    });
    const root = await mkdtemp(path.join(tmpdir(), "native-header-roundtrip-"));
    let app = await createApp({ root, port: 0 });
    const stop = async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    };
    t.after(async () => {
      await stop();
      await rm(root, { recursive: true, force: true });
    });
    const post = async (route, body, status = 200) => {
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
    };
    const source = headerSource(base, version),
      original = structuredClone(source),
      p = await app.store.create("header workflow");
    importIntoProject(p, source);
    assert.equal(p.requests[0].httpVersion, version);
    p.environments[0].variables.tenant = "A";
    p.environments.push({
      id: "header-other-env",
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
    const resource = {
      request: {
        method: "GET",
        httpVersion: version,
        url: base + "/resource",
        beforeScript:
          'pm.test("temporary isolation",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(undefined));',
        auth: { type: "bearer", token: "{{token}}" },
      },
    };
    const plan = await post(`/api/projects/${p.id}/plans`, {
      steps: [{ request: p.requests[0] }, resource],
    });
    const live = await app.store.get(p.id);
    live.requests[0].nativeTasks.after.find(
      (entry) => entry.type === "pickVars",
    ).data.variables[0].expression = "x-missing";
    await app.store.save(live);
    for (const [environmentId, tenant] of [
      [p.environments[0].id, "A"],
      ["header-other-env", "B"],
    ]) {
      const run = await post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        environmentId,
      });
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(received.at(-1).authorization, `Bearer wire-${tenant}-view`);
      assert.equal(
        run.results[0].response.headers["x-token"],
        `wire-${tenant}`,
      );
      assert.equal(
        run.results[0].response.body,
        "<html>wire login is not JSON</html>",
      );
      assert.equal(run.results[0].response.status, 200);
      assert.deepEqual(run.results[0].scriptResponse, {
        body: "<html>processed login</html>",
        status: 201,
      });
      const saved = await new Store(root).get(p.id),
        env = saved.environments.find((entry) => entry.id === environmentId);
      assert.equal(env.variables.token, `wire-${tenant}-view`);
      assert.equal(env.variables.derived, `prefix:wire-${tenant}-view`);
      assert.equal(env.variables.empty, "");
      assert.equal(env.variables.comma, "one, literal");
      assert.equal(env.variables.order, "project,folder,api");
      assert.equal(saved.globalVariables.sharedToken, `wire-${tenant}-view`);
      assert(!Object.hasOwn(env.variables, "sameRequest"));
    }
    const other = await app.store.create("other header project");
    importIntoProject(other, source);
    assert.equal(other.requests[0].httpVersion, version);
    other.environments[0].variables.tenant = "C";
    await app.store.save(other);
    const otherPlan = await post(`/api/projects/${other.id}/plans`, {
      steps: [{ request: other.requests[0] }, resource],
    });
    const concurrent = await Promise.all([
      post(`/api/projects/${p.id}/run`, {
        planId: plan.id,
        environmentId: p.environments[0].id,
      }),
      post(`/api/projects/${other.id}/run`, { planId: otherPlan.id }),
    ]);
    for (const run of concurrent)
      assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(
      (await new Store(root).get(p.id)).environments[0].variables.token,
      "wire-A-view",
    );
    assert.equal(
      (await new Store(root).get(other.id)).environments[0].variables.token,
      "wire-C-view",
    );
    const count = received.length;
    await post(
      `/api/projects/${p.id}/run`,
      { planId: plan.id, environmentId: other.environments[0].id },
      400,
    );
    assert.equal(received.length, count);
    const saved = await new Store(root).get(p.id);
    const restored = await post("/api/restore", { document: saved }, 201);
    assert.deepEqual(
      restored.plans[0].steps[0].request.nativeTasks,
      saved.plans[0].steps[0].request.nativeTasks,
    );
    await stop();
    app = await createApp({ root, port: 0 });
    const rerun = await post(`/api/projects/${restored.id}/run`, {
      planId: plan.id,
      environmentId: "header-other-env",
    });
    assert.equal(rerun.status, "passed", JSON.stringify(rerun));
    assert.equal(received.at(-1).authorization, "Bearer wire-B-view");
  });

test("native responseHeader fails closed on real ambiguous or incomplete HTTP/1 headers and never sends the stale token", async (t) => {
  const seen = [];
  let active;
  const base = await fixture(t, "1.1", (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    if (active.disconnect) return req.socket.destroy();
    const headers = active.headers ?? ["X-Token", "fresh"];
    res.writeHead(active.status ?? 200, [
      "Content-Type",
      "text/html",
      ...headers,
    ]);
    res.end("<html>login</html>");
  });
  const root = await mkdtemp(path.join(tmpdir(), "native-header-failure-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const post = async (projectId, route, body) => {
    const response = await fetch(
      `${app.url}/api/projects/${projectId}/${route}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify(body),
      },
    );
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const valid = pick([row("token", "x-token")]);
  const samples = [
    {
      name: "missing selected header",
      headers: [],
      error: /响应头|Header|header/,
    },
    {
      name: "same-spelling duplicate",
      headers: ["X-Token", "first", "X-Token", "second"],
      error: /响应头|Header|header/,
    },
    {
      name: "interleaved mixed-case duplicate",
      headers: ["X-Token", "first", "x-token", "second", "X-Token", "third"],
      error: /响应头|Header|header/,
    },
    {
      name: "single set-cookie is still a non-string transport value",
      headers: ["Set-Cookie", "a=only"],
      after: [pick([row("token", "set-cookie")])],
      error: /响应头|Header|header/,
    },
    {
      name: "set-cookie array",
      headers: ["Set-Cookie", "a=first", "set-cookie", "a=second"],
      after: [pick([row("token", "set-cookie")])],
      error: /响应头|Header|header/,
    },
    {
      name: "bounded evidence overflow preserves ordinary visible headers",
      headers: [
        "X-Token",
        "fresh",
        ...Array.from({ length: 300 }, (_, index) => ["x" + index, "v"]).flat(),
        "X-Tail",
        "still visible",
      ],
      error: /响应头|Header|header/,
      tail: "still visible",
    },
    {
      name: "parser-saturated prefix cannot prove a unique token",
      headers: [
        "X-Token",
        "fresh",
        ...Array.from({ length: 1100 }, () => ["z", "x"]).flat(),
        "x-token",
        "hidden duplicate",
      ],
      error: /响应头|Header|header/,
    },
    {
      name: "later missing row rolls back every post assignment",
      after: [pick([row("token", "x-token"), row("missing", "x-missing")])],
      error: /响应头|Header|header/,
    },
    {
      name: "return cannot skip required header extraction",
      after: [script("early", "return;"), valid],
      error: /未完成/,
    },
    {
      name: "return cannot hide an incomplete later header task",
      after: [
        valid,
        script("early", "return;"),
        pick([row("later", "x-token")]),
      ],
      error: /未完成/,
    },
    {
      name: "cross-task catch cannot hide missing header",
      after: [
        script("try", "try {"),
        pick([row("missing", "x-missing")]),
        script("catch", "} catch (ignored) {}"),
      ],
      error: /未完成/,
    },
    {
      name: "script failure after extraction rolls back",
      after: [valid, script("throw", 'throw Error("header post rejection");')],
      error: /header post rejection/,
    },
    {
      name: "post assertion failure rolls back",
      after: [
        valid,
        script(
          "assert",
          'pm.test("reject",()=>pm.expect(false).to.equal(true));',
        ),
      ],
      error: /断言/,
    },
    {
      name: "wire failure is not hidden by body or status changes",
      status: 500,
      after: [
        script(
          "view",
          'apt.response.setCode(200);apt.response.setBody("view");',
        ),
        valid,
      ],
      error: /原始响应状态/,
    },
    {
      name: "network failure prevents stale token followup",
      disconnect: true,
      error: /socket hang up|fetch failed/,
    },
    {
      name: "pre failure prevents stale token followup",
      before: [script("reject", 'throw Error("header pre rejection");')],
      error: /header pre rejection/,
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
      const plan = await post(p.id, "plans", {
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
                  ...(sample.after ?? [valid]),
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
      const run = await post(p.id, "run", { planId: plan.id });
      assert.equal(run.status, "failed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 1);
      assert.match(run.results[0].error, sample.error);
      assert.deepEqual(
        seen.map((entry) => entry.path),
        sample.before ? [] : ["/login"],
      );
      assert.equal(run.variables.token, "stale");
      assert(!Object.hasOwn(run.variables, "postOnly"));
      if (sample.tail)
        assert.equal(run.results[0].response.headers["x-tail"], sample.tail);
      if (sample.status === 500) {
        assert.equal(run.results[0].response.status, 500);
        assert.equal(run.results[0].scriptResponse.status, 200);
      }
      const disk = await new Store(root).get(p.id);
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

for (const version of ["1.1", "2"])
  test(`native responseHeader HTTP/${version} reads the captured current map, ignores facade replacement and coexists with JSON tasks`, async (t) => {
    const base = await fixture(t, version, (_req, res) => {
      res.setHeader("x-token", "wire");
      res.setHeader("x-empty", "");
      res.setHeader("x-comma", "one, literal");
      res.end("<html>wire</html>");
    });
    const response = await executeRequest({ url: base, httpVersion: version });
    const original = structuredClone(response);
    const result = await runNativeTaskPhase(
      [
        script(
          "mutate",
          'response.headers["x-token"]="current";pm.response.headers.get=()=>{throw Error("public get must not run")};response.headers={"x-token":"replacement"};pm.response.headers={get:()=>"facade forgery"};',
        ),
        pick([
          row("token", " X-ToKeN "),
          row("empty", "x-empty"),
          row("comma", "x-comma"),
        ]),
        script("body", 'apt.response.setBody({token:"json-view",zero:0});'),
        pick(
          [row("jsonToken", "$.token"), row("zero", "$.zero")],
          "responseJson",
        ),
        script("complete", "return;"),
      ],
      { request: {}, response },
    );
    assert.equal(result.scopes.environment.token, "current");
    assert.equal(result.scopes.environment.empty, "");
    assert.equal(result.scopes.environment.comma, "one, literal");
    assert.equal(result.scopes.environment.jsonToken, "json-view");
    assert.equal(result.scopes.environment.zero, 0);
    assert.deepEqual(response, original);
  });

for (const version of ["1.1", "2"])
  test(`native responseHeader HTTP/${version} rejects duplicate evidence even when script replaces the merged value`, async (t) => {
    const base = await fixture(t, version, (_req, res) => {
      res.setHeader("x-token", ["first", "second"]);
      res.end("<html>duplicate token</html>");
    });
    const response = await executeRequest({ url: base, httpVersion: version });
    assert.equal(response.headers["x-token"], "first, second");
    await assert.rejects(
      runNativeTaskPhase(
        [
          script("forge", 'response.headers["x-token"]="forged unique value";'),
          pick([row("token", "x-token")]),
        ],
        { request: {}, response },
      ),
      /响应头|Header|header/,
    );
  });

test("native responseHeader validates every row before assigning and cancellation discards the whole post phase", async (t) => {
  const seen = [];
  const controller = new AbortController();
  const base = await fixture(t, "1.1", (req, res) => {
    seen.push(req.url);
    if (req.url === "/pause") {
      controller.abort();
      return;
    }
    res.setHeader("x-token", "fresh");
    res.end("<html>login</html>");
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
  const atomic = await runPlan(
    planFor([
      script("try", "try {"),
      pick([row("token", "x-token"), row("missing", "x-missing")]),
      script(
        "catch",
        `} catch (ignored) { await pm.sendRequest({url:${JSON.stringify(base + "/atomic/")}+pm.environment.get("token")}); }`,
      ),
    ]),
    { token: "stale" },
    executeRequest,
    { variableScopes: { environment: { token: "stale" } } },
  );
  assert.equal(atomic.status, "failed");
  assert.match(atomic.results[0].error, /未完成/);
  assert.deepEqual(seen, ["/login", "/atomic/stale"]);
  assert.equal(atomic.variables.token, "stale");
  seen.length = 0;
  const commits = [];
  const cancelled = await runPlan(
    planFor([
      pick([row("token", "x-token")]),
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
  assert.deepEqual(seen, ["/login", "/pause"]);
  assert.equal(cancelled.variables.token, "stale");
  assert.equal(cancelled.variables.beforeProof, "committed");
  assert.equal(commits.length, 1);
  assert.deepEqual(
    commits[0].map((change) => change.name),
    ["beforeProof"],
  );
});
