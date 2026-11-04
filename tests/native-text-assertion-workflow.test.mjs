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
const assertion = (
  id,
  compareValue,
  compareType = "eq",
  type = "responseText",
  path,
) => ({
  type: "assert",
  id,
  name: id,
  enabled: 1,
  data: {
    type,
    expression: {
      ...(path === undefined ? {} : { path }),
      compareType,
      compareValue,
    },
  },
});
const pick = (name = "token", expression, enabled = 1) => ({
  type: "pickVars",
  id: "pick-" + name,
  name: "pick " + name,
  enabled,
  data: {
    source: "responseText",
    variables: [
      {
        name,
        type: "envVars",
        ...(expression === undefined ? {} : { expression }),
      },
    ],
  },
});
const tasks = (after, before = []) => ({ version: 1, before, after });
const textFor = (tenant, ready = true) =>
  `tenant:${tenant}|state:${ready ? "ready" : "blocked"}| 雪 🧪 | e\u0301\r\n`;
const diagnosticPath = " {{not-a-template}} / [not a path]() ";

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
  const root = await mkdtemp(path.join(tmpdir(), "native-text-assertion-"));
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
      'order.push("api");apt.response.setBody("view|"+pm.response.text());apt.response.setCode(201);',
    ),
    assertion("business substring", "state:ready", "includes"),
    assertion(
      "inert diagnostic",
      "view|tenant:",
      "includes",
      "responseText",
      diagnosticPath,
    ),
    assertion("Unicode spacing", " 雪 🧪 ", "includes"),
    assertion("no Unicode normalization", "é", "unincludes"),
    assertion("case-sensitive", "STATE:", "unincludes"),
    assertion("CRLF preserved", "\r\n", "includes"),
    assertion("empty needle", "", "includes"),
    assertion("not empty", "", "uneq"),
    script(
      "after",
      'order.push("after");const token="wire-"+pm.response.text().split("|")[1].slice(7);pm.environment.set("token",token);pm.environment.set("order",order.join(","));pm.globals.set("sharedToken",token);pm.variables.set("localOnly","temporary");',
    ),
  ];
  return source;
}

test("native Text assertions close current-body HTTP import, soft failure, frozen plan, receipt, restore, restart and isolation", async (t) => {
  const seen = [];
  let ready = false;
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    // A Text source must not switch parsers based on this deliberately misleading type.
    res.setHeader("content-type", "application/xml; charset=utf-8");
    res.end(textFor(req.url.split("/").at(-1), ready));
  });
  const app = await application(t),
    source = sourceFor(base),
    original = structuredClone(source);
  const p = await app.store.create("Text assertions");
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "text-assertion-B",
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
  const savedTasks = plan.steps[0].request.nativeTasks.after;
  assert(
    !Object.hasOwn(
      savedTasks.find((entry) => entry.name === "business substring").data
        .expression,
      "path",
    ),
  );
  assert.equal(
    savedTasks.find((entry) => entry.name === "inert diagnostic").data
      .expression.path,
    diagnosticPath,
  );
  const live = await app.store.get(p.id);
  live.requests[0].nativeTasks.after.find(
    (entry) => entry.type === "assert",
  ).data.expression.compareValue = "edited after freeze";
  await app.store.save(live);
  for (const [environmentId, tenant, passes] of [
    [p.environments[0].id, "A", false],
    ["text-assertion-B", "B", true],
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
        ["business substring", passes],
        ["inert diagnostic", true],
        ["Unicode spacing", true],
        ["no Unicode normalization", true],
        ["case-sensitive", true],
        ["CRLF preserved", true],
        ["empty needle", true],
        ["not empty", true],
      ],
    );
    assert.equal(seen.at(-1).authorization, `Bearer wire-${tenant}`);
    assert.equal(run.results[0].response.body, textFor(tenant, passes));
    assert.equal(run.results[0].response.status, 200);
    assert.deepEqual(run.results[0].scriptResponse, {
      body: "view|" + textFor(tenant, passes),
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
    environmentId: "text-assertion-B",
  });
  assert.equal(executed.outcome, "failed");
  assert.equal(executed.assertions[0].passed, false);
  assert.equal(executed.variableWrites.environmentId, "text-assertion-B");
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
    environmentId: "text-assertion-B",
  });
  assert.equal(rerun.status, "passed", JSON.stringify(rerun));
  assert.equal(rerun.recordSaved, true);
  assert.equal(seen.at(-1).authorization, "Bearer wire-B");
  const other = await app.store.create("other Text assertion project");
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

test("native Text assertion false stays soft while active Text pick enforces strict rollback", async (t) => {
  const seen = [];
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.end("blocked");
  });
  const app = await application(t);
  for (const sample of [
    { name: "assert-only false", soft: true },
    {
      name: "disabled Text pick",
      prefix: [pick("token", undefined, 0)],
      soft: true,
    },
    { name: "active Text pick plus false", prefix: [pick()], strict: true },
    {
      name: "non-string current body is stage error",
      prefix: [script("invalid body", "response.body=42;")],
      error: true,
    },
    {
      name: "later Text pick makes body error strict",
      prefix: [script("invalid body", "response.body=null;")],
      suffix: [pick()],
      strict: true,
      error: true,
    },
  ])
    await t.test(sample.name, async () => {
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
                  assertion("state", "ready", "includes"),
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
        assert.match(run.results[0].error, /Text|正文|字符串/);
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

test("native includes and unincludes compare Code, Header, JSON, XML and Text as literal case-sensitive strings", async (t) => {
  const seen = [];
  const base = await upstream(t, (req, res) => {
    seen.push(req.url);
    res.setHeader("x-value", "Prefix needle Suffix");
    res.end("plain wire");
  });
  const app = await application(t),
    p = await app.store.create("mixed comparators");
  await app.store.save(p);
  const after = [
    assertion("Code includes", "0", "includes", "responseCode", ""),
    assertion(
      "Header includes",
      "needle",
      "includes",
      "responseHeader",
      "X-VALUE",
    ),
    assertion(
      "Header case",
      "NEEDLE",
      "unincludes",
      "responseHeader",
      "x-value",
    ),
    script(
      "JSON view",
      'apt.response.setBody({value:"雪 Alpha",n:200,nil:null});',
    ),
    assertion("JSON text", "Alpha", "includes", "responseJson", "$.value"),
    assertion("JSON number string", "0", "includes", "responseJson", "$.n"),
    assertion("JSON null string", "ull", "includes", "responseJson", "$.nil"),
    script(
      "XML view",
      'apt.response.setBody("<root><value>雪 Alpha</value></root>");',
    ),
    assertion(
      "XML includes",
      "Alpha",
      "includes",
      "responseXml",
      "string(/root/value)",
    ),
    assertion(
      "XML case",
      "alpha",
      "unincludes",
      "responseXml",
      "string(/root/value)",
    ),
    script("empty Text", 'apt.response.setBody("");'),
    assertion("empty equality", ""),
    assertion("empty includes", "", "includes"),
    assertion("empty unincludes is false", "", "unincludes"),
    script("after false", 'pm.environment.set("afterFalse","committed");'),
  ];
  assert.equal(after.length, 15);
  const plan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [
      {
        request: {
          url: base + "/first",
          inheritSharedScripts: false,
          nativeTasks: tasks(after),
        },
      },
      { request: { url: base + "/later" } },
    ],
  });
  const run = await app.post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.results.length, 2);
  assert.equal(run.results[1].status, "passed");
  assert.equal(run.results[0].assertions.length, 11);
  assert(run.results[0].assertions.slice(0, -1).every((entry) => entry.passed));
  assert.equal(run.results[0].assertions.at(-1).passed, false);
  assert.equal(run.results[0].response.body, "plain wire");
  assert.equal(run.results[0].scriptResponse.body, "");
  assert.deepEqual(seen, ["/first", "/later"]);
  assert.equal(
    (await new Store(app.root).get(p.id)).environments[0].variables.afterFalse,
    "committed",
  );
});

test("native Text assertions and picks preserve an empty wire body and observe each later body edit", async (t) => {
  const seen = [];
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.end("");
  });
  const app = await application(t),
    p = await app.store.create("mixed Text operations");
  await app.store.save(p);
  const plan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [
      {
        request: {
          url: base + "/first",
          inheritSharedScripts: false,
          nativeTasks: tasks([
            assertion("empty wire", ""),
            pick("empty"),
            script(
              "Unicode",
              "apt.response.setBody(" +
                JSON.stringify(" \r\n雪 🧪 e\u0301 \t") +
                ");",
            ),
            assertion("Unicode included", "雪 🧪", "includes"),
            pick("unicode", diagnosticPath),
            script("next", 'apt.response.setBody("next-token");'),
            assertion("new view", "next-token"),
            pick("token"),
            script(
              "after",
              'pm.environment.set("observed",pm.environment.get("empty")+"|"+pm.environment.get("unicode"));',
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
  assert.equal(run.results[0].response.body, "");
  assert.equal(run.results[0].scriptResponse.body, "next-token");
  assert.equal(seen.at(-1).authorization, "Bearer next-token");
  const saved = await new Store(app.root).get(p.id);
  assert.equal(saved.environments[0].variables.empty, "");
  assert.equal(
    saved.environments[0].variables.unicode,
    " \r\n雪 🧪 e\u0301 \t",
  );
  assert.equal(saved.environments[0].variables.token, "next-token");
  assert.equal(
    saved.plans[0].steps[0].request.nativeTasks.after.find(
      (entry) => entry.id === "pick-unicode",
    ).data.variables[0].expression,
    diagnosticPath,
  );
});

test("native Text assertion cancellation discards post writes after a completed comparison", async (t) => {
  const seen = [],
    commits = [];
  const controller = new AbortController();
  const base = await upstream(t, (req, res) => {
    seen.push(req.url);
    if (req.url === "/pause") {
      controller.abort();
      return;
    }
    res.end("ready");
  });
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: base + "/first",
          inheritSharedScripts: false,
          nativeTasks: tasks(
            [
              assertion("completed", "ready"),
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
