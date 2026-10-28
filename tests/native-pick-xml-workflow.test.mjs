import test from "node:test";
import { withCLIResultDiagnostics } from "./helpers/cli-result-diagnostics.mjs";
import assert from "node:assert/strict";
import http from "node:http";
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
const pick = (variables, source = "responseXml", enabled = 1) => ({
  type: "pickVars",
  id: "xml-extract",
  name: "XML extract",
  enabled,
  data: { source, variables },
});
const tasks = (after, before = []) => ({ version: 1, before, after });
const tokenPick = () => pick([row("token", "string(/login/token)")]);
const xmlFor = (tenant) =>
  `<login tenant="${tenant}" blank=""><token>wire-${tenant}</token><empty/><text><![CDATA[雪 & punctuation]]></text><escaped>&amp;&#x41;&#66;</escaped><literal><![CDATA[&#0; &#xD800;]]></literal><!-- &#0; --><?note &#x110000;?></login>`;

async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function application(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-xml-workflow-"));
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

function sourceFor(base) {
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
  api.request.query.parameter = [];
  api.request.header.parameter = [];
  api.request.post_tasks = [
    script(
      "view",
      'order.push("api");const prefix="prefix:";apt.response.setBody(pm.response.text().replace("</token>","-view</token>"));apt.response.setCode(201);',
    ),
    pick([
      row("token", "string(/login/token)"),
      row("sameRequest", "string(/login/token)", "tempVars"),
      row("sharedToken", "string(/login/token)", "globalVars"),
      row("empty", "string(/login/empty)"),
      row("attribute", "string(/login/@tenant)"),
      row("emptyAttribute", "string(/login/@blank)"),
      row("escaped", "string(/login/escaped)"),
      row("cdata", "string(/login/text)"),
      row("literal", "string(/login/literal)"),
    ]),
    script(
      "same-phase",
      'pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("order",order.join(","));pm.test("same phase",()=>pm.expect(pm.variables.get("sameRequest")).to.equal(pm.environment.get("token")));',
    ),
  ];
  return source;
}

test("native responseXml real login closes import, current XML view, scopes, Bearer, frozen plan, backup and restart", async (t) => {
  const received = [];
  const base = await upstream(t, (req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/xml");
    res.end(req.url.startsWith("/login/") ? xmlFor(req.url.slice(7)) : "<ok/>");
  });
  const app = await application(t),
    source = sourceFor(base),
    original = structuredClone(source),
    p = await app.store.create("XML login");
  importIntoProject(p, source);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "xml-other-env",
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
      url: base + "/resource",
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
  ).data.variables[0].expression = "string(/login/missing)";
  await app.store.save(live);
  for (const [environmentId, tenant] of [
    [p.environments[0].id, "A"],
    ["xml-other-env", "B"],
  ]) {
    const run = await app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId,
    });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(received.at(-1).authorization, `Bearer wire-${tenant}-view`);
    assert.equal(run.results[0].response.body, xmlFor(tenant));
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(run.results[0].scriptResponse, {
      body: xmlFor(tenant).replace("</token>", "-view</token>"),
      status: 201,
    });
    const saved = await new Store(app.root).get(p.id),
      env = saved.environments.find((entry) => entry.id === environmentId);
    assert.equal(env.variables.token, `wire-${tenant}-view`);
    assert.equal(env.variables.derived, `prefix:wire-${tenant}-view`);
    assert.equal(env.variables.empty, "");
    assert.equal(env.variables.attribute, tenant);
    assert.equal(env.variables.emptyAttribute, "");
    assert.equal(env.variables.escaped, "&AB");
    assert.equal(env.variables.cdata, "雪 & punctuation");
    assert.equal(env.variables.literal, "&#0; &#xD800;");
    assert.equal(env.variables.order, "project,folder,api");
    assert.equal(saved.globalVariables.sharedToken, `wire-${tenant}-view`);
    assert(!Object.hasOwn(env.variables, "sameRequest"));
  }
  const other = await app.store.create("isolated XML project");
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
  await app.restart();
  const again = await app.post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
    environmentId: "xml-other-env",
  });
  assert.equal(again.status, "passed", JSON.stringify(again));
  assert.equal(received.at(-1).authorization, "Bearer wire-B-view");
});

test("native responseXml rejects unsafe or ambiguous login XML atomically, preserves pre commits and stops stale Bearer requests", async (t) => {
  const seen = [];
  let active;
  const base = await upstream(t, (req, res) => {
    seen.push(req.url);
    res.statusCode = active.status ?? 200;
    res.setHeader("content-type", "application/xml");
    res.end(active.body ?? "<login><token>fresh</token></login>");
  });
  const app = await application(t);
  const samples = [
    { name: "mismatched XML", body: "<login><token>fresh</login>" },
    {
      name: "trailing second document root",
      body: "<login><token>fresh</token></login><extra/>",
    },
    { name: "missing node", body: "<login/>" },
    {
      name: "multiple matching nodes",
      body: "<login><token>first</token><token>second</token></login>",
    },
    {
      name: "non-leaf token",
      body: "<login><token>fresh<child/></token></login>",
    },
    {
      name: "default namespace",
      body: '<login xmlns="urn:login"><token>fresh</token></login>',
    },
    {
      name: "prefixed namespace",
      body: '<login xmlns:x="urn:login"><x:token>fresh</x:token></login>',
    },
    { name: "unknown entity", body: "<login><token>&unknown;</token></login>" },
    {
      name: "internal DTD entity",
      body: '<!DOCTYPE login [<!ENTITY token "fresh">]><login><token>&token;</token></login>',
    },
    {
      name: "external DTD does not create a network request",
      body: `<!DOCTYPE login SYSTEM "${base}/entity"><login><token>fresh</token></login>`,
    },
    {
      name: "external entity does not create a network request",
      body: `<!DOCTYPE login [<!ENTITY token SYSTEM "${base}/entity">]><login><token>&token;</token></login>`,
    },
    {
      name: "later missing row",
      after: [
        pick([
          row("token", "string(/login/token)"),
          row("missing", "string(/login/missing)"),
        ]),
      ],
    },
    {
      name: "return cannot skip XML extraction",
      after: [script("early", "return;"), tokenPick()],
      error: /未完成/,
    },
    {
      name: "cross-task catch cannot hide XML failure",
      after: [
        script("try", "try {"),
        pick([row("missing", "string(/login/missing)")]),
        script("catch", "} catch (ignored) {}"),
      ],
      error: /未完成/,
    },
    {
      name: "post assertion rolls back extracted XML",
      after: [
        tokenPick(),
        script(
          "reject",
          'pm.test("reject",()=>pm.expect(false).to.equal(true));',
        ),
      ],
      error: /断言/,
    },
    {
      name: "wire 500 is not hidden by processed response",
      status: 500,
      after: [script("view", "apt.response.setCode(200);"), tokenPick()],
      error: /原始响应状态/,
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
                  ...(sample.after ?? [tokenPick()]),
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
      withCLIResultDiagnostics(
        () =>
          assert.match(run.results[0].error, sample.error ?? /XML|XPath|pickVars/),
        JSON.stringify(run),
      );
      assert.deepEqual(seen, ["/login"]);
      assert.equal(run.variables.token, "stale");
      assert(!Object.hasOwn(run.variables, "postOnly"));
      const disk = await new Store(app.root).get(p.id);
      assert.equal(disk.environments[0].variables.token, "stale");
      assert.equal(disk.environments[0].variables.beforeProof, "committed");
      assert(!Object.hasOwn(disk.environments[0].variables, "postOnly"));
      assert(!Object.hasOwn(disk.globalVariables, "postGlobal"));
      assert.equal(disk.globalVariables.priorGlobal, "saved");
      assert.equal(
        disk.runs.find((entry) => entry.id === run.id).results.length,
        1,
      );
    });
});

test("native XML, header and JSON pickVars coexist in one VM and follow the current processed body without changing wire evidence", async (t) => {
  const base = await upstream(t, (_req, res) => {
    res.setHeader("x-token", "header-wire");
    res.setHeader("content-type", "application/xml");
    res.end("<login><token>xml-wire</token></login>");
  });
  const response = await executeRequest({ url: base }),
    original = structuredClone(response);
  const result = await runNativeTaskPhase(
    [
      script(
        "prefix",
        'const prefix="same-phase:";apt.response.setBody("<login><token>xml-view</token></login>");',
      ),
      pick([row("xml", "string(/login/token)")]),
      pick([row("header", "x-token")], "responseHeader"),
      script("json-view", 'apt.response.setBody({token:"json-view"});'),
      pick([row("json", "$.token")], "responseJson"),
      script(
        "xml-view",
        'apt.response.setBody("<login><token><![CDATA[final <xml>]]></token></login>");',
      ),
      pick([row("final", "string(/login/token)")]),
      script(
        "read",
        'pm.environment.set("joined",prefix+[pm.environment.get("xml"),pm.environment.get("header"),pm.environment.get("json"),pm.environment.get("final")].join("|"));return;',
      ),
    ],
    { request: {}, response },
  );
  assert.equal(
    result.scopes.environment.joined,
    "same-phase:xml-view|header-wire|json-view|final <xml>",
  );
  assert.deepEqual(response, original);
});

test("native responseXml validates all rows before assignment and cancellation discards extracted post variables", async (t) => {
  const seen = [],
    controller = new AbortController();
  const base = await upstream(t, (req, res) => {
    seen.push(req.url);
    if (req.url === "/pause") {
      controller.abort();
      return;
    }
    res.setHeader("content-type", "application/xml");
    res.end("<login><token>fresh</token></login>");
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
      pick([
        row("token", "string(/login/token)"),
        row("missing", "string(/login/missing)"),
      ]),
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
      tokenPick(),
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
