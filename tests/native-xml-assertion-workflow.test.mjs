import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
    type: "responseXml",
    expression: { path, compareType, compareValue },
  },
});
const pick = (
  name = "token",
  expression = "string(/login/token)",
  enabled = 1,
) => ({
  type: "pickVars",
  id: "pick-" + name,
  name: "pick " + name,
  enabled,
  data: {
    source: "responseXml",
    variables: [{ name, expression, type: "envVars" }],
  },
});
const tasks = (after, before = []) => ({ version: 1, before, after });
const xmlFor = (tenant, ready = true) =>
  `<login kind="ready" blank=""><state>${ready ? "ready" : "blocked"}</state><token>wire-${tenant}</token><empty/><text><![CDATA[雪 & punctuation]]></text><escaped>&amp;&#x41;&#66;</escaped></login>`;

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
  const root = await mkdtemp(path.join(tmpdir(), "native-xml-assertion-"));
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
      'order.push("api");apt.response.setBody(pm.response.text().replace("<state>","<state>view:"));apt.response.setCode(201);',
    ),
    assertion("current XML view", " \tstring(/login/state) \n", "view:ready"),
    assertion("attribute", "string(/login/@kind)", "ready"),
    assertion("empty attribute", "string(/login/@blank)", ""),
    assertion("empty element", "string(/login/empty)", ""),
    assertion("CDATA", "string(/login/text)", "雪 & punctuation"),
    assertion("entities", "string(/login/escaped)", "&AB"),
    assertion("literal unequal", "string(/login/state)", "never", "uneq"),
    script(
      "after",
      'order.push("after");const token=pm.response.text().split("<token>")[1].split("</token>")[0];pm.environment.set("token",token);pm.environment.set("order",order.join(","));pm.globals.set("sharedToken",token);pm.variables.set("localOnly","temporary");',
    ),
  ];
  return source;
}

test("native XML assertions close real import, current body, soft failure, frozen plan, scope receipt, restore and restart", async (t) => {
  const seen = [];
  let ready = false;
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/xml");
    res.end(xmlFor(req.url.split("/").at(-1), ready));
  });
  const app = await application(t),
    source = sourceFor(base),
    original = structuredClone(source);
  const p = await app.store.create("XML assertions");
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "xml-assertion-B",
    name: "B",
    variables: { tenant: "B" },
  });
  await app.store.save(p);
  const later = {
    request: {
      url: base + "/later",
      auth: { type: "bearer", token: "{{token}}" },
      beforeScript:
        'pm.test("local isolation",()=>pm.expect(pm.variables.get("localOnly")).to.equal(undefined));',
    },
  };
  const plan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [{ request: p.requests[0] }, later],
  });
  const storedAssertion = plan.steps[0].request.nativeTasks.after.find(
    (entry) => entry.type === "assert",
  );
  assert.equal(
    storedAssertion.data.expression.path,
    " \tstring(/login/state) \n",
  );
  const live = await app.store.get(p.id);
  live.requests[0].nativeTasks.after.find(
    (entry) => entry.type === "assert",
  ).data.expression.compareValue = "edited after freeze";
  await app.store.save(live);
  for (const [environmentId, tenant, passes] of [
    [p.environments[0].id, "A", false],
    ["xml-assertion-B", "B", true],
  ]) {
    ready = passes;
    const run = await app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId,
    });
    assert.equal(run.status, passes ? "passed" : "failed", JSON.stringify(run));
    assert.equal(run.recordSaved, true);
    assert.equal(run.results.length, 2);
    assert.equal(run.results[1].status, "passed");
    assert.deepEqual(
      run.results[0].assertions.map((entry) => [entry.name, entry.passed]),
      [
        ["current XML view", passes],
        ["attribute", true],
        ["empty attribute", true],
        ["empty element", true],
        ["CDATA", true],
        ["entities", true],
        ["literal unequal", true],
      ],
    );
    assert.equal(seen.at(-1).authorization, `Bearer wire-${tenant}`);
    assert.equal(run.results[0].response.body, xmlFor(tenant, passes));
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(run.results[0].scriptResponse, {
      body: xmlFor(tenant, passes).replace("<state>", "<state>view:"),
      status: 201,
    });
    assert.deepEqual(
      run.results[0].request.nativeTasks,
      plan.steps[0].request.nativeTasks,
    );
    const saved = await new Store(app.root).get(p.id),
      env = saved.environments.find((entry) => entry.id === environmentId);
    assert.equal(env.variables.token, `wire-${tenant}`);
    assert.equal(env.variables.order, "project,folder,api,after");
    assert.equal(saved.globalVariables.sharedToken, `wire-${tenant}`);
    assert(!Object.hasOwn(env.variables, "localOnly"));
    assert.equal(
      saved.runs.find((entry) => entry.id === run.id).status,
      run.status,
    );
  }
  ready = false;
  const executed = await app.post(`/api/projects/${p.id}/execute`, {
    request: { ...plan.steps[0].request, url: base + "/login/receipt" },
    environmentId: "xml-assertion-B",
  });
  assert.equal(executed.outcome, "failed");
  assert.equal(executed.assertions[0].passed, false);
  assert.equal(executed.variableWrites.environmentId, "xml-assertion-B");
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
  const disk = await new Store(app.root).get(p.id);
  assert.equal(disk.environments[0].variables.token, "wire-A");
  assert.equal(disk.environments[1].variables.token, "wire-receipt");
  const restored = await app.post("/api/restore", { document: disk }, 201);
  assert.deepEqual(
    restored.plans[0].steps[0].request.nativeTasks,
    plan.steps[0].request.nativeTasks,
  );
  await app.restart();
  ready = true;
  const rerun = await app.post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
    environmentId: "xml-assertion-B",
  });
  assert.equal(rerun.status, "passed", JSON.stringify(rerun));
  assert.equal(rerun.recordSaved, true);
  assert.equal(seen.at(-1).authorization, "Bearer wire-B");
  const other = await app.store.create("other XML assertion project");
  importIntoProject(other, source);
  other.environments[0].variables.tenant = "C";
  await app.store.save(other);
  const otherPlan = await app.post(`/api/projects/${other.id}/plans`, {
    steps: [{ request: other.requests[0] }, later],
  });
  const runs = await Promise.all([
    app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId: p.environments[0].id,
    }),
    app.post(`/api/projects/${other.id}/run`, { planId: otherPlan.id }),
  ]);
  assert(
    runs.every((run) => run.status === "passed"),
    JSON.stringify(runs),
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

test("native XML assertion lookup errors remain stage errors and only active pick adds strict rollback", async (t) => {
  const seen = [];
  let current;
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/xml");
    res.end(
      current.body ??
        "<login><token>fresh</token><state>blocked</state></login>",
    );
  });
  const app = await application(t);
  for (const sample of [
    { name: "false remains soft", soft: true },
    {
      name: "disabled pick remains soft",
      prefix: [pick("token", "string(/login/token)", 0)],
      soft: true,
    },
    {
      name: "active pick plus false is strict",
      prefix: [pick()],
      strict: true,
    },
    {
      name: "missing selection is stage error",
      body: "<login><token>fresh</token></login>",
      error: true,
    },
    {
      name: "multiple selections are stage error",
      body: "<login><state>ready</state><state>ready</state></login>",
      error: true,
    },
    {
      name: "non-leaf selection is stage error",
      body: "<login><state>ready<child/></state></login>",
      error: true,
    },
    {
      name: "malformed XML is stage error",
      body: "<login><state>ready</login>",
      error: true,
    },
    {
      name: "later active pick makes earlier XML error strict",
      body: "<login><token>fresh</token></login>",
      suffix: [pick()],
      strict: true,
      error: true,
    },
  ])
    await t.test(sample.name, async () => {
      current = sample;
      seen.length = 0;
      const p = await app.store.create(sample.name);
      p.environments[0].variables.token = "stale";
      await app.store.save(p);
      const plan = await app.post(`/api/projects/${p.id}/plans`, {
        steps: [
          {
            request: {
              url: base + "/first",
              inheritSharedScripts: false,
              nativeTasks: tasks(
                [
                  script(
                    "post",
                    'pm.environment.set("postOnly","soft commit");',
                  ),
                  ...(sample.prefix ?? []),
                  assertion("state", "string(/login/state)", "ready"),
                  ...(sample.suffix ?? []),
                  script("after", 'pm.environment.set("followingTask","yes");'),
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
      assert.equal(run.results.length, sample.strict ? 1 : 2);
      assert.equal(seen.length, sample.strict ? 1 : 2);
      if (!sample.strict)
        assert.equal(seen.at(-1).authorization, "Bearer stale");
      if (sample.error) {
        assert.match(run.results[0].error, /XML|节点|匹配|叶|唯一/);
        assert(
          !run.results[0].assertions.some((entry) => entry.name === "state"),
        );
      } else
        assert.equal(
          run.results[0].assertions.find((entry) => entry.name === "state")
            .passed,
          false,
        );
      const saved = await new Store(app.root).get(p.id);
      assert.equal(saved.environments[0].variables.token, "stale");
      assert.equal(saved.environments[0].variables.beforeProof, "committed");
      assert.equal(
        saved.environments[0].variables.postOnly,
        sample.soft ? "soft commit" : undefined,
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

test("native XML assertions and picks read each current body in one real response phase", async (t) => {
  const seen = [];
  const wire = "<login><token>wire</token></login>";
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/xml");
    res.end(wire);
  });
  const app = await application(t);
  const p = await app.store.create("mixed XML operations");
  await app.store.save(p);
  const plan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [
      {
        request: {
          url: base + "/first",
          inheritSharedScripts: false,
          nativeTasks: tasks([
            assertion("wire first", "string(/login/token)", "wire"),
            pick("first"),
            script(
              "second",
              'apt.response.setBody("<login><token>second</token></login>");',
            ),
            assertion("second view", "string(/login/token)", "second"),
            pick("second"),
            script(
              "third",
              "apt.response.setBody('<login label=\"third\"><token>third</token></login>');",
            ),
            assertion("third attribute", "string(/login/@label)", "third"),
            pick("token"),
            assertion("not stale", "string(/login/token)", "wire", "uneq"),
            script(
              "after",
              'pm.environment.set("combined",pm.environment.get("first")+","+pm.environment.get("second")+","+pm.environment.get("token"));',
            ),
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
  const run = await app.post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, 2);
  assert(run.results[0].assertions.every((entry) => entry.passed));
  assert.equal(run.results[0].response.body, wire);
  assert.equal(
    run.results[0].scriptResponse.body,
    '<login label="third"><token>third</token></login>',
  );
  assert.equal(seen.at(-1).authorization, "Bearer third");
  assert.equal(
    (await new Store(app.root).get(p.id)).environments[0].variables.combined,
    "wire,second,third",
  );
  const failPlan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [
      {
        request: {
          url: base + "/fail",
          inheritSharedScripts: false,
          nativeTasks: tasks([
            assertion("initial", "string(/login/token)", "wire"),
            pick("token"),
            script("invalidate", 'apt.response.setBody("<login/>");'),
            assertion("fresh parse missing", "string(/login/token)", "wire"),
          ]),
        },
      },
      { request: { url: base + "/must-not-run" } },
    ],
  });
  const count = seen.length;
  const failed = await app.post(`/api/projects/${p.id}/run`, {
    planId: failPlan.id,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.results.length, 1);
  assert.match(failed.results[0].error, /XML|节点|匹配|唯一/);
  assert.equal(seen.length, count + 1);
  assert.equal(
    (await new Store(app.root).get(p.id)).environments[0].variables.token,
    "third",
  );
});

test("native XML assertion cancellation discards post writes after a completed comparison", async (t) => {
  const seen = [],
    commits = [];
  const controller = new AbortController();
  const base = await upstream(t, (req, res) => {
    seen.push(req.url);
    if (req.url === "/pause") {
      controller.abort();
      return;
    }
    res.setHeader("content-type", "application/xml");
    res.end("<login><token>ready</token></login>");
  });
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: base + "/first",
          inheritSharedScripts: false,
          nativeTasks: tasks(
            [
              assertion("completed", "string(/login/token)", "ready"),
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
