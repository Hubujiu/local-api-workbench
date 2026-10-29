import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const assertion = (id, type, path, compareType, compareValue) => ({
  type: "assert",
  id,
  name: id,
  enabled: 1,
  data: {
    type,
    expression: {
      ...(path === undefined ? {} : { path }),
      compareType,
      ...(compareValue === undefined ? {} : { compareValue }),
    },
  },
});
const pick = (enabled = 1) => ({
  type: "pickVars",
  id: "pick",
  name: "pick",
  enabled,
  data: {
    source: "responseText",
    variables: [{ name: "token", type: "envVars" }],
  },
});
const tasks = (after, before = []) => ({ version: 1, before, after });
const unary = new Set(["null", "notnull", "exist", "notexist"]);

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
  const root = await mkdtemp(
    path.join(tmpdir(), "native-comparator-workflow-"),
  );
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
      'order.push("api");const body=pm.response.json();body.score+=1;apt.response.setBody(body);',
    ),
    assertion("Code lt", "responseCode", "", "lt", "300"),
    assertion("Code lte", "responseCode", "", "lte", "200"),
    assertion("Header gt", "responseHeader", "X-NUM", "gt", "9"),
    assertion("Header gte", "responseHeader", "x-num", "gte", "10"),
    assertion("business score", "responseJson", "$.score", "gt", "10"),
    assertion("empty is null", "responseJson", "$.empty", "null"),
    assertion("null string is notnull", "responseJson", "$.nothing", "notnull"),
    assertion("null does not exist", "responseJson", "$.nothing", "notexist"),
    assertion("zero exists", "responseJson", "$.zero", "exist"),
    assertion("missing does not exist", "responseJson", "$.absent", "notexist"),
    assertion(
      "Header membership",
      "responseHeader",
      "x-choice",
      "belongscollection",
      "red,blue",
    ),
    assertion(
      "JSON no trim",
      "responseJson",
      "$.choice",
      "notbelongscollection",
      "red,blue",
    ),
    script(
      "after",
      'order.push("after");const token="wire-"+pm.response.json().tenant;pm.environment.set("token",token);pm.environment.set("order",order.join(","));pm.globals.set("sharedToken",token);pm.variables.set("localOnly","temporary");',
    ),
  ];
  return source;
}

const secondPhase = (base) => ({
  request: {
    url: base + "/xml",
    inheritSharedScripts: false,
    nativeTasks: tasks([
      assertion("XML eq", "responseXml", "string(/root/value)", "eq", "Alpha"),
      assertion(
        "XML uneq",
        "responseXml",
        "string(/root/value)",
        "uneq",
        "Beta",
      ),
      assertion(
        "XML includes",
        "responseXml",
        "string(/root/value)",
        "includes",
        "lph",
      ),
      assertion(
        "XML unincludes",
        "responseXml",
        "string(/root/value)",
        "unincludes",
        "alpha",
      ),
      assertion("XML null", "responseXml", "string(/root/empty)", "null"),
      assertion("XML exist", "responseXml", "string(/root/value)", "exist"),
      assertion("XML notnull", "responseXml", "string(/root/value)", "notnull"),
      script("Text view", 'apt.response.setBody(" blue");'),
      assertion(
        "Text exact member",
        "responseText",
        undefined,
        "belongscollection",
        "red, blue",
      ),
      assertion(
        "Text no trim",
        "responseText",
        undefined,
        "notbelongscollection",
        "red,blue",
      ),
      script(
        "second complete",
        'pm.environment.set("secondPhase","committed");pm.test("local isolation",()=>pm.expect(pm.variables.get("localOnly")).to.equal(undefined));',
      ),
    ]),
  },
});

function assertUnaryAbsence(plan) {
  let count = 0;
  for (const step of plan.steps)
    for (const entry of step.request.nativeTasks?.after ?? [])
      if (
        entry.type === "assert" &&
        unary.has(entry.data.expression.compareType)
      ) {
        assert(!Object.hasOwn(entry.data.expression, "compareValue"));
        count++;
      }
  assert.equal(count, 8);
}

test("all fourteen native comparators close five-source HTTP soft failure, frozen plans, unary absence, receipts and restart", async (t) => {
  const seen = [];
  let success = false;
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("x-num", "10");
    res.setHeader("x-choice", "blue");
    if (req.url === "/xml") {
      res.setHeader("content-type", "application/xml");
      res.end("<root><value>Alpha</value><empty/></root>");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tenant: req.url.split("/").at(-1),
          score: success ? 20 : 5,
          empty: "",
          nothing: null,
          zero: 0,
          choice: " blue",
        }),
      );
    }
  });
  const app = await application(t),
    source = sourceFor(base),
    original = structuredClone(source);
  const p = await app.store.create("native comparators");
  importIntoProject(p, source);
  assert.deepEqual(source, original);
  assert.equal(p.requests[0].nativeTasks.after.length, 16);
  p.environments[0].variables.tenant = "A";
  p.environments.push({
    id: "comparator-B",
    name: "B",
    variables: { tenant: "B" },
  });
  await app.store.save(p);
  const later = {
    request: {
      url: base + "/later",
      auth: { type: "bearer", token: "{{token}}" },
    },
  };
  const plan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [{ request: p.requests[0] }, secondPhase(base), later],
  });
  assertUnaryAbsence(plan);
  const comparators = new Set(
    plan.steps.flatMap((step) =>
      (step.request.nativeTasks?.after ?? [])
        .filter((entry) => entry.type === "assert")
        .map((entry) => entry.data.expression.compareType),
    ),
  );
  assert.equal(comparators.size, 14);
  const live = await app.store.get(p.id);
  live.requests[0].nativeTasks.after.find(
    (entry) => entry.name === "business score",
  ).data.expression.compareValue = "999";
  await app.store.save(live);
  for (const [environmentId, tenant, passes] of [
    [p.environments[0].id, "A", false],
    ["comparator-B", "B", true],
  ]) {
    success = passes;
    const run = await app.post(`/api/projects/${p.id}/run`, {
      planId: plan.id,
      environmentId,
    });
    assert.equal(run.status, passes ? "passed" : "failed", JSON.stringify(run));
    assert.equal(run.recordSaved, true);
    assert.equal(run.results.length, 3);
    assert.equal(run.results[1].status, "passed");
    assert.equal(run.results[2].status, "passed");
    const firstTests = run.results[0].assertions;
    assert.equal(firstTests.length, 12);
    assert.equal(
      firstTests.find((entry) => entry.name === "business score").passed,
      passes,
    );
    assert(
      firstTests
        .filter((entry) => entry.name !== "business score")
        .every((entry) => entry.passed),
    );
    assert(run.results[1].assertions.every((entry) => entry.passed));
    assert.equal(
      JSON.parse(run.results[0].response.body).score,
      passes ? 20 : 5,
    );
    assert.equal(
      JSON.parse(run.results[0].scriptResponse.body).score,
      passes ? 21 : 6,
    );
    assert.equal(seen.at(-1).authorization, `Bearer wire-${tenant}`);
    assert.deepEqual(
      run.results[0].request.nativeTasks,
      plan.steps[0].request.nativeTasks,
    );
    const saved = await new Store(app.root).get(p.id),
      env = saved.environments.find((entry) => entry.id === environmentId);
    assert.equal(env.variables.token, `wire-${tenant}`);
    assert.equal(env.variables.order, "project,folder,api,after");
    assert.equal(env.variables.secondPhase, "committed");
    assert.equal(saved.globalVariables.sharedToken, `wire-${tenant}`);
    assert(!Object.hasOwn(env.variables, "localOnly"));
    assert.equal(
      saved.runs.find((entry) => entry.id === run.id).status,
      run.status,
    );
    assertUnaryAbsence(saved.plans[0]);
  }
  success = false;
  const executed = await app.post(`/api/projects/${p.id}/execute`, {
    request: { ...plan.steps[0].request, url: base + "/login/receipt" },
    environmentId: "comparator-B",
  });
  assert.equal(executed.outcome, "failed");
  assert.equal(executed.variableWrites.environmentId, "comparator-B");
  assert.equal(executed.variableWrites.commits, 1);
  assert(
    executed.variableWrites.changes.some(
      (change) =>
        change.scope === "environment" &&
        change.name === "token" &&
        change.after.value === "wire-receipt",
    ),
  );
  const disk = await new Store(app.root).get(p.id);
  assert.equal(disk.environments[0].variables.token, "wire-A");
  assert.equal(disk.environments[1].variables.token, "wire-receipt");
  const restored = await app.post("/api/restore", { document: disk }, 201);
  assert.deepEqual(restored.plans[0].steps, plan.steps);
  assertUnaryAbsence(restored.plans[0]);
  await app.restart();
  success = true;
  const rerun = await app.post(`/api/projects/${restored.id}/run`, {
    planId: plan.id,
    environmentId: "comparator-B",
  });
  assert.equal(rerun.status, "passed", JSON.stringify(rerun));
  assert.equal(rerun.recordSaved, true);
  assert.equal(seen.at(-1).authorization, "Bearer wire-B");
  const other = await app.store.create("other comparator project");
  importIntoProject(other, source);
  other.environments[0].variables.tenant = "C";
  await app.store.save(other);
  const otherPlan = await app.post(`/api/projects/${other.id}/plans`, {
    steps: [{ request: other.requests[0] }, secondPhase(base), later],
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

test("native numeric NaN is a completed soft failure and active pick alone adds strict rollback", async (t) => {
  const seen = [];
  const base = await upstream(t, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.end("not-a-number");
  });
  const app = await application(t);
  for (const sample of [
    { name: "assert-only NaN", prefix: [], soft: true },
    { name: "disabled pick NaN", prefix: [pick(0)], soft: true },
    { name: "active pick NaN", prefix: [pick()], strict: true },
    {
      name: "nonnumeric expected is NaN",
      prefix: [script("numeric actual", 'apt.response.setBody("5");')],
      expected: "not-numeric",
      soft: true,
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
                  ...sample.prefix,
                  ...["lt", "lte", "gt", "gte"].map((compareType) =>
                    assertion(
                      compareType,
                      "responseText",
                      undefined,
                      compareType,
                      sample.expected ?? "0",
                    ),
                  ),
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
      assert.equal(run.results[0].assertions.length, 4);
      assert(
        run.results[0].assertions.every((entry) => entry.passed === false),
      );
      if (!sample.strict)
        assert.equal(seen.at(-1).authorization, "Bearer stale");
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
    });
});

test("native comparator HTTP phases keep raw null, infinity and literal collection semantics distinct", async (t) => {
  const base = await upstream(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/raw")
      res.end(
        '{"empty":"","nil":null,"zero":0,"no":false,"space":" ","inf":"Infinity","neg":"-Infinity"}',
      );
    else
      res.end(
        JSON.stringify({
          empty: "",
          comma: "one,two",
          space: " blue",
          plain: "blue",
          quoted: '"blue"',
        }),
      );
  });
  const app = await application(t),
    p = await app.store.create("literal comparator semantics");
  await app.store.save(p);
  const plan = await app.post(`/api/projects/${p.id}/plans`, {
    steps: [
      {
        request: {
          url: base + "/raw",
          inheritSharedScripts: false,
          nativeTasks: tasks([
            assertion("empty only null", "responseJson", "$.empty", "null"),
            assertion("null is not empty", "responseJson", "$.nil", "null"),
            assertion(
              "null is string nonempty",
              "responseJson",
              "$.nil",
              "notnull",
            ),
            assertion("null absent", "responseJson", "$.nil", "notexist"),
            assertion(
              "undefined string nonempty",
              "responseJson",
              "$.absent",
              "notnull",
            ),
            assertion(
              "undefined absent",
              "responseJson",
              "$.absent",
              "notexist",
            ),
            assertion("zero present", "responseJson", "$.zero", "exist"),
            assertion("false present", "responseJson", "$.no", "exist"),
            assertion(
              "whitespace not empty",
              "responseJson",
              "$.space",
              "notnull",
            ),
            assertion(
              "positive infinity",
              "responseJson",
              "$.inf",
              "gt",
              "1e308",
            ),
            assertion(
              "infinity equality gte",
              "responseJson",
              "$.inf",
              "gte",
              "Infinity",
            ),
            assertion(
              "negative infinity",
              "responseJson",
              "$.neg",
              "lt",
              "-1e308",
            ),
            assertion(
              "negative infinity lte",
              "responseJson",
              "$.neg",
              "lte",
              "-Infinity",
            ),
            script(
              "after soft false",
              'pm.environment.set("rawFinished",true);',
            ),
          ]),
        },
      },
      {
        request: {
          url: base + "/collection",
          inheritSharedScripts: false,
          nativeTasks: tasks([
            assertion(
              "empty member",
              "responseJson",
              "$.empty",
              "belongscollection",
              "a,,b",
            ),
            assertion(
              "single empty member",
              "responseJson",
              "$.empty",
              "belongscollection",
              "",
            ),
            assertion(
              "empty not a member",
              "responseJson",
              "$.empty",
              "notbelongscollection",
              "a,b",
            ),
            assertion(
              "whitespace member",
              "responseJson",
              "$.space",
              "belongscollection",
              "red, blue",
            ),
            assertion(
              "no trimmed member",
              "responseJson",
              "$.space",
              "notbelongscollection",
              "red,blue",
            ),
            assertion(
              "literal split not CSV",
              "responseJson",
              "$.comma",
              "notbelongscollection",
              '"one,two",three',
            ),
            assertion(
              "quotes literal",
              "responseJson",
              "$.quoted",
              "belongscollection",
              'red,"blue"',
            ),
            assertion(
              "plain is not quoted",
              "responseJson",
              "$.plain",
              "notbelongscollection",
              'red,"blue"',
            ),
            script(
              "collection done",
              'pm.environment.set("collectionFinished",true);',
            ),
          ]),
        },
      },
    ],
  });
  const run = await app.post(`/api/projects/${p.id}/run`, { planId: plan.id });
  assert.equal(run.status, "failed", JSON.stringify(run));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, 2);
  assert.deepEqual(
    run.results[0].assertions
      .filter((entry) => !entry.passed)
      .map((entry) => entry.name),
    ["null is not empty"],
  );
  assert.equal(run.results[1].status, "passed", JSON.stringify(run.results[1]));
  assert(run.results[1].assertions.every((entry) => entry.passed));
  const saved = await new Store(app.root).get(p.id);
  assert.equal(saved.environments[0].variables.rawFinished, true);
  assert.equal(saved.environments[0].variables.collectionFinished, true);
});

test("native comparator malformed imports and API plan creation reject atomically", async (t) => {
  const app = await application(t),
    p = await app.store.create("atomic comparator input");
  const original = structuredClone(p);
  for (const alter of [
    (entry) => delete entry.data.expression.compareValue,
    (entry) => (entry.data.expression.compareValue = 10),
    (entry) => (entry.data.expression.compareValue = ["{{secret}}"]),
    (entry) => (entry.data.expression.compareType = "regex"),
    (entry) => (entry.data.expression.unexpected = true),
    (entry) => {
      entry.data.expression.compareType = "exist";
      entry.data.expression.compareValue = null;
    },
  ]) {
    const source = sourceFor("http://127.0.0.1:1"),
      target = source.apis[1].request.post_tasks.find(
        (entry) => entry.type === "assert",
      );
    alter(target);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, original);
    await app.post(
      `/api/projects/${p.id}/plans`,
      {
        steps: [
          {
            request: {
              url: "http://127.0.0.1:1",
              inheritSharedScripts: false,
              nativeTasks: tasks([target]),
            },
          },
        ],
      },
      400,
    );
    const saved = await new Store(app.root).get(p.id);
    assert.equal(saved.plans.length, 0);
    assert.equal(saved.runs.length, 0);
    assert.deepEqual(saved.environments, original.environments);
  }
});
