import test from "node:test";
import assert from "node:assert/strict";
import {
  createFieldSampler,
  sampleProjectSchema,
} from "../src/mock-fields.mjs";
const settings = (expression) => ({
  mockSeed: 42,
  mockFieldRules: [
    {
      id: "source",
      pattern: "value",
      type: "string",
      mock: expression,
      apipostSource: { projectId: "p", id: "r" },
    },
  ],
});
test("native source rules reuse the upstream Chinese, web, location and color generators as a batch", () => {
  const cases = [
    ["@cfirst", /^[\u3400-\u9fff]+$/],
    ["@clast", /^[\u3400-\u9fff]+$/],
    ["@cname", /^[\u3400-\u9fff]+$/],
    ["@first", /^[A-Za-z]+$/],
    ["@last", /^[A-Za-z]+$/],
    ["@name", /^[A-Za-z ]+$/],
    ["@protocol", /^[a-z]+$/],
    ["@tld", /^[a-z]+$/],
    ["@ip", /^\d{1,3}(\.\d{1,3}){3}$/],
    ["@region", /^[\u3400-\u9fff]+$/],
    ["@province", /^[\u3400-\u9fff]+$/],
    ["@city", /^[\u3400-\u9fff]+$/],
    ["@county", /^[\u3400-\u9fff]+$/],
    ["@zip", /^\d{6}$/],
    ['@url("https","example.test")', /^https:\/\/example\.test\//],
    ['@domain("test")', /\.test$/],
    ['@email("example.test")', /@example\.test$/],
    ["@hex", /^#[0-9a-f]{6}$/],
    ["@rgb", /^rgb\(\d+, \d+, \d+\)$/],
    ["@rgba", /^rgba\(/],
    ["@hsl", /^hsl\(/],
  ];
  for (const [expression, pattern] of cases) {
    const a = createFieldSampler(settings(expression)),
      b = createFieldSampler(settings(expression));
    const value = a("value", { type: "string" });
    assert.match(value, pattern, expression);
    assert.equal(
      value,
      b("value", { type: "string" }),
      expression + " seeded replay",
    );
  }
  assert.equal(
    createFieldSampler(settings('@color("red")'))("value", { type: "string" }),
    "#FF4136",
  );
  assert.equal(
    sampleProjectSchema(
      { settings: settings("@cname") },
      { type: "object", properties: { value: { type: "string" } } },
    ).value.length > 0,
    true,
  );
});

test("native library arguments remain bounded and do not expand Local API expression semantics", () => {
  for (const expression of [
    '@cname("x")',
    "@first(3)",
    "@zip(1000000)",
    '@url("@function")',
    "@email({})",
    '@color("constructor")',
    '@email("' + "x".repeat(257) + '")',
    "@unknown()",
  ])
    assert.throws(() => createFieldSampler(settings(expression)));
  const own = createFieldSampler({
    mockSeed: 42,
    mockFieldRules: [
      { id: "own", pattern: "value", type: "string", mock: "@email()" },
    ],
  });
  assert.match(own("value", { type: "string" }), /@example\.test$/);
  assert.throws(
    () =>
      createFieldSampler(settings("@cname"))("value", {
        type: "string",
        maxLength: 0,
      }),
    /长度/,
  );
  assert.equal(
    createFieldSampler(settings("@cname"))("value", { type: "integer" }),
    undefined,
  );
});

test("native library scopes dispose explicitly and reject unknown or over-quota calls", async () => {
  const { createNativeMockEvaluator } = await import(
    "../src/native-mock-library.mjs"
  );
  const scope = createNativeMockEvaluator(() => 0.5);
  try {
    assert.throws(() => scope.evaluate({ name: "constructor", args: [] }));
    for (let i = 0; i < 1000; i++)
      assert.equal(
        typeof scope.evaluate({ name: "cfirst", args: [] }),
        "string",
      );
    assert.throws(() => scope.evaluate({ name: "cfirst", args: [] }), /额度/);
  } finally {
    scope.dispose();
  }
  scope.dispose();
  assert.throws(() => scope.evaluate({ name: "cfirst", args: [] }), /关闭/);
  assert.throws(() => {
    const invalid = createNativeMockEvaluator(() => NaN);
    try {
      invalid.evaluate({ name: "cfirst", args: [] });
    } finally {
      invalid.dispose();
    }
  }, /随机值/);
});

test("imported library families survive storage and actual Mock HTTP without mutating source data", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { importIntoProject } = await import("../src/core.mjs");
  const { modernApipostFixture } = await import(
    "./fixtures/apipost-modern.mjs"
  );
  const { nativeDirectoryFixture } = await import(
    "./fixtures/apipost-directory.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "native-library-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Upstream Mock families"),
    doc = modernApipostFixture();
  const entries = {
    fullName: "@cname",
    mail: '@email("example.test")',
    color: '@color("red")',
    location: "@city(true)",
    address: "@ip",
  };
  doc.global.mock_custom_rules = Object.entries(entries).map(
    ([name, mock]) => ({
      mock_custom_rule_id: name,
      field_type: "string",
      match_type: "exact",
      match_rule: name,
      match_case: 1,
      mock_type: 1,
      mock_rule_content: mock,
      intro: name,
    }),
  );
  const source = structuredClone(doc);
  importIntoProject(project, nativeDirectoryFixture(doc));
  assert.deepEqual(doc, source);
  const schema = {
    type: "object",
    properties: Object.fromEntries(
      Object.keys(entries).map((name) => [name, { type: "string" }]),
    ),
  };
  project.requests = [
    {
      id: "auto",
      name: "auto",
      url: app.url + "/mock/" + project.id + "/auto",
      responses: [{ status: "200", contentType: "application/json", schema }],
    },
  ];
  await app.store.save(project);
  assert.deepEqual(
    (await app.store.get(project.id)).settings.mockFieldRules,
    project.settings.mockFieldRules,
  );
  const response = await fetch(project.requests[0].url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.fullName, /^[\u3400-\u9fff]+$/);
  assert.match(body.mail, /@example\.test$/);
  assert.equal(body.color, "#FF4136");
  assert.match(body.location, /^[\u3400-\u9fff ]+$/);
  assert(
    body.address.split(".").every((n) => Number(n) >= 0 && Number(n) <= 255),
  );
  const preview = await fetch(
    app.url + "/api/projects/" + project.id + "/sample",
    {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schema }),
    },
  );
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).sample, body);
  const bad = structuredClone(doc);
  bad.global.mock_custom_rules[0].mock_rule_content = "@cname({})";
  const before = structuredClone(project);
  assert.throws(() => importIntoProject(project, bad));
  assert.deepEqual(project, before);
  const { createServer } = await import("node:http");
  const received = [];
  const echo = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString());
    received.push(value);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    echo.closeAllConnections();
    await new Promise((resolve) => echo.close(resolve));
  });
  const { snapshotPlan } = await import("../src/core.mjs");
  const plan = snapshotPlan({
    name: "Native Mock to scripted HTTP",
    statusPolicy: "strict200",
    steps: [
      {
        request: {
          url: project.requests[0].url,
          extract: [
            { name: "generatedMail", path: "$.mail" },
            { name: "generatedName", path: "$.fullName" },
          ],
          afterScript:
            'pm.test("library color",()=>pm.expect(pm.response.json().color).to.equal("#FF4136"));',
        },
      },
      {
        request: {
          url: "http://127.0.0.1:" + echo.address().port,
          method: "POST",
          bodyType: "json",
          body: '{"mail":"{{generatedMail}}","name":"{{generatedName}}","marker":"{{pipelineMarker}}"}',
          beforeScript: 'apt.setVar("pipelineMarker","ready");',
          afterScript:
            'pm.test("pipeline marker",()=>pm.expect(pm.response.json().marker).to.equal("ready"));',
        },
      },
    ],
  });
  project.plans = [plan];
  await app.store.save(project);
  const runResponse = await fetch(
    app.url + "/api/projects/" + project.id + "/run",
    {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ planId: plan.id, runId: "library-chain" }),
    },
  );
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.results.length, 2);
  assert.deepEqual(received, [
    { mail: body.mail, name: body.fullName, marker: "ready" },
  ]);
  const persisted = await app.store.get(project.id);
  assert.equal(persisted.runs[0].planHash, run.planHash);
  assert.equal(persisted.runs[0].status, "passed");
  persisted.plans[0].steps[0].request.afterScript =
    'pm.test("intentional failure",()=>pm.expect(1).to.equal(2));';
  await app.store.save(persisted);
  const failedResponse = await fetch(
    app.url + "/api/projects/" + project.id + "/run",
    {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        planId: plan.id,
        runId: "library-failure-evidence",
      }),
    },
  );
  assert.equal(failedResponse.status, 200);
  const failed = await failedResponse.json();
  assert.equal(failed.status, "failed");
  assert(failed.results[0].assertions.some((item) => item.passed === false));
  assert.equal((await app.store.get(project.id)).runs[0].status, "failed");
});
