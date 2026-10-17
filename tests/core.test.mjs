import test from "node:test";
import assert from "node:assert/strict";
import {
  interpolate,
  jsonPath,
  evaluateAssertions,
  importDocument,
  exportOpenAPI,
  snapshotPlan,
  runPlan,
  normalizeRequest,
} from "../src/core.mjs";
test("variables substitute deeply and unresolved variables fail", () => {
  assert.equal(
    interpolate("{{host}}/a", { host: "http://localhost" }),
    "http://localhost/a",
  );
  assert.throws(() => interpolate("{{missing}}", {}), /missing/);
});
test("JSON paths preserve falsy values and reject prototype traversal", () => {
  assert.equal(jsonPath({ a: [{ b: false }] }, "$.a[0].b"), false);
  assert.throws(() => jsonPath({}, "__proto__.x"));
});
test("assertions distinguish expected errors and missing values", () => {
  let r = { status: 404, body: '{"count":0}', duration: 5, headers: {} };
  assert(
    evaluateAssertions(r, [
      { target: "status", op: "eq", value: 404 },
      { target: "$.count", op: "eq", value: 0 },
    ]).every((x) => x.passed),
  );
  assert.equal(
    evaluateAssertions(r, [{ target: "$.none", op: "exists" }])[0].passed,
    false,
  );
});
test("OpenAPI import/export preserves HTTP definitions", () => {
  const requests = importDocument({
    openapi: "3.0.3",
    info: { title: "Test" },
    servers: [{ url: "http://localhost" }],
    paths: {
      "/users/{id}": {
        get: {
          summary: "Get user",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert(exportOpenAPI({ name: "Test", requests }).paths["/users/{id}"].get);
});
test("plans snapshot request state and freeze evidence", async () => {
  const request = normalizeRequest({
    name: "one",
    url: "http://localhost",
    assertions: [{ target: "status", op: "eq", value: 200 }],
  });
  let plan = snapshotPlan({ name: "flow", steps: [{ request }] });
  request.url = "changed";
  assert.equal(plan.steps[0].request.url, "http://localhost");
  const run = await runPlan(plan, {}, async () => ({
    status: 200,
    body: "{}",
    headers: {},
    duration: 1,
  }));
  assert.equal(run.status, "passed");
  assert.equal(run.results.length, 1);
  assert.equal(run.planHash.length, 64);
});
test("plans continue after failure and extract variables", async () => {
  const p = snapshotPlan({
    name: "chain",
    steps: [
      {
        request: {
          url: "http://localhost/a",
          extract: [{ name: "token", path: "$.token" }],
        },
      },
      { request: { url: "http://localhost/{{token}}" } },
    ],
  });
  let urls = [];
  let r = await runPlan(p, {}, async (req) => {
    urls.push(req.url);
    return {
      status: urls.length === 1 ? 500 : 200,
      body: '{"token":"abc"}',
      headers: {},
      duration: 1,
    };
  });
  assert.equal(r.status, "failed");
  assert.equal(r.results.length, 2);
  assert.equal(urls[1], "http://localhost/abc");
});
test("unsafe or invalid imports rejected", () => {
  assert.throws(() => importDocument({ bad: true }));
  assert.throws(() => normalizeRequest({ url: "file:///etc/passwd" }));
});
test("extraction failure retains actual request and response evidence", async () => {
  const p = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://localhost",
          extract: [{ name: "id", path: "$.missing" }],
        },
      },
    ],
  });
  const r = await runPlan(p, {}, async () => ({
    status: 200,
    body: '{"hello":1}',
    headers: {},
    duration: 1,
  }));
  assert.equal(r.status, "failed");
  assert.equal(r.results[0].response.body, '{"hello":1}');
  assert.match(r.results[0].error, /无法提取/);
});
test("empty plan cannot falsely pass", async () => {
  await assert.rejects(
    runPlan(snapshotPlan({ steps: [] }), {}, async () => {}),
    /没有可执行/,
  );
});
test("backup restore preserves environments and plans without overwriting source", async () => {
  const { restoreProject } = await import("../src/core.mjs");
  const source = {
    version: 1,
    id: "old",
    revision: 4,
    name: "source",
    requests: [{ url: "http://localhost" }],
    environments: [{ id: "env", name: "local", variables: { a: "b" } }],
    plans: [
      { name: "plan", steps: [{ request: { url: "http://localhost" } }] },
    ],
  };
  const copy = restoreProject(source);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.environments[0].variables.a, "b");
  assert.equal(copy.plans.length, 1);
  assert.equal(copy.revision, undefined);
  assert.equal(source.revision, 4);
});
test("OpenAPI references resolve locally and never fetch remote documents", async () => {
  const { resolveLocalReferences } = await import("../src/core.mjs");
  const d = resolveLocalReferences({
    components: {
      schemas: {
        User: { type: "object", properties: { id: { type: "integer" } } },
      },
    },
    sample: { $ref: "#/components/schemas/User" },
  });
  assert.equal(d.sample.properties.id.type, "integer");
  assert.throws(
    () =>
      resolveLocalReferences({ x: { $ref: "https://example.test/schema" } }),
    /外部/,
  );
  assert.deepEqual(resolveLocalReferences({ a: { $ref: "#/a" } }).a, {
    $ref: "#/a",
  });
});
test("schema sample generation respects examples and falsy defaults", async () => {
  const { sampleFromSchema } = await import("../src/core.mjs");
  assert.deepEqual(
    sampleFromSchema({
      type: "object",
      properties: {
        count: { type: "integer", default: 0 },
        active: { type: "boolean" },
        name: { type: "string", example: "test" },
      },
    }),
    { count: 0, active: false, name: "test" },
  );
});
test("Postman import preserves auth, params, forms and script hierarchy", () => {
  const requests = importDocument({
    info: { name: "Collection" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
    event: [
      { listen: "prerequest", script: { exec: ['console.log("collection")'] } },
    ],
    item: [
      {
        name: "Folder",
        item: [
          {
            name: "Update",
            event: [
              { listen: "test", script: { exec: ['console.log("test")'] } },
            ],
            request: {
              method: "POST",
              url: {
                raw: "http://localhost/users/:id?a=1",
                query: [{ key: "a", value: "1" }],
                variable: [{ key: "id", value: "7" }],
              },
              body: {
                mode: "formdata",
                formdata: [
                  { key: "file", type: "file", src: "/private/never-read.txt" },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  assert.equal(requests[0].auth.type, "bearer");
  assert.equal(requests[0].url, "http://localhost/users/{id}");
  assert.equal(requests[0].query.length, 1);
  assert.equal(requests[0].form[0].requiresFile, true);
  assert.match(requests[0].beforeScript, /collection/);
  assert.match(requests[0].afterScript, /test/);
});
test("OpenAPI YAML imports without code execution or duplicate keys", () => {
  const result = importDocument(
    'openapi: 3.0.3\ninfo:\n  title: YAML\npaths:\n  /ping:\n    get:\n      summary: Ping\n      responses:\n        "200":\n          description: OK\n',
  );
  assert.equal(result[0].name, "Ping");
  assert.throws(
    () => importDocument("openapi: 3.0.3\nopenapi: 3.1.0\npaths: {}"),
    /unique|duplicate/i,
  );
});
test("malformed imports cannot persist fields that crash the workbench", () => {
  assert.throws(() => normalizeRequest({ headers: { bad: true } }), /数组/);
  assert.throws(() => normalizeRequest({ query: [null] }), /数组/);
  assert.throws(() => normalizeRequest({ auth: [] }), /对象/);
  assert.equal(normalizeRequest({ body: { ok: true } }).body, '{"ok":true}');
});
test("OpenAPI sync is idempotent and retains recursive schema components", async () => {
  const { importIntoProject } = await import("../src/core.mjs");
  const project = { name: "Sync", requests: [], environments: [] };
  const document = {
    openapi: "3.0.3",
    info: { title: "Sync" },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
    paths: {
      "/nodes": {
        post: {
          operationId: "createNode",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Node" },
              },
            },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
  const first = importIntoProject(project, document, { sync: true })[0].id;
  document.paths["/nodes"].post.summary = "Changed";
  importIntoProject(project, document, { sync: true });
  assert.equal(project.requests.length, 1);
  assert.equal(project.requests[0].id, first);
  assert.equal(project.requests[0].name, "Changed");
  assert(exportOpenAPI(project).components.schemas.Node);
});
test("Postman collection variables are retained as a separate environment", async () => {
  const { importIntoProject } = await import("../src/core.mjs");
  const project = { requests: [], environments: [] };
  importIntoProject(project, {
    info: { name: "Collection" },
    variable: [{ key: "baseUrl", value: "http://localhost" }],
    item: [],
  });
  assert.equal(project.environments[0].variables.baseUrl, "http://localhost");
});
