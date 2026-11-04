// Integration-only contracts: preserve the accepted root's write, collection,
// progress, native-projection and catalogue/Mock boundaries when IF is added.
// Pure model/executor checks, not real transport or provider acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv from "ajv";
import {
  importIntoProject,
  restoreProject,
  runPlan,
  snapshotPlan,
} from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { assertNativeLinearPlan } from "../src/native-mcp-plan.mjs";
import { assertNativeLinearResult } from "../src/native-mcp-tools.mjs";
import { sampleFromSchema } from "../src/schema-sample.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";
import { blankAttributeProject } from "./fixtures/apipost-export-attributes.mjs";
import {
  combinedDocument,
  catalogueSemantics,
} from "./fixtures/apipost-attribute-catalogues.mjs";
const literal = (value) => ({ literal: value });
const variable = (scope, name) => ({ scope, name });
const gate = (id, left, right, steps, enabled = true) => ({
  id,
  type: "if",
  enabled,
  condition: { op: "eq", left, right },
  steps,
});
const leaf = (id, request = {}) => ({
  id,
  request: {
    name: id,
    method: "GET",
    url: "http://127.0.0.1:1/never",
    ...request,
  },
});
const response = () => ({ status: 200, headers: {}, body: "{}" });

test("false IF cannot hide an enabled native Redis SET from whole-plan authority preflight", async () => {
  const project = blankAttributeProject("if-write");
  importIntoProject(
    project,
    nativeRedisFixture("http://127.0.0.1:1/never", {
      method: "set",
      query: JSON.stringify({ key: "fixture-key", value: "fixture-value" }),
    }),
  );
  const request = project.requests[0];
  assert.ok(
    request.nativeTasks.before.some(
      (task) => task.data?.writeIntent === "redis-set",
    ),
  );
  let executions = 0,
    preparations = 0,
    queries = 0;
  const plan = snapshotPlan({
    steps: [
      leaf("prefix"),
      gate("false", literal(false), literal(true), [leaf("write", request)]),
    ],
  });
  await assert.rejects(
    runPlan(
      plan,
      {},
      async () => {
        executions++;
        return response();
      },
      {
        prepareRequest: (request) => {
          preparations++;
          return request;
        },
        databaseQuery: async () => {
          queries++;
        },
      },
    ),
    { code: "NATIVE_WRITE_AUTHORITY_REQUIRED" },
  );
  assert.deepEqual([executions, preparations, queries], [0, 0, 0]);
  plan.steps[1].enabled = false;
  const result = await runPlan(
    plan,
    {},
    async () => {
      executions++;
      return response();
    },
    {
      databaseQuery: async () => {
        queries++;
      },
    },
  );
  assert.equal(result.status, "passed");
  assert.deepEqual(result.conditionResults, []);
  assert.deepEqual(
    result.results.map((r) => r.stepId),
    ["prefix"],
  );
  assert.equal(executions, 1);
  assert.equal(queries, 0);
});

for (const asynchronous of [false, true])
  test(`IF preserves ${asynchronous ? "async" : "sync"} leaf progress fail-stop before any later decision`, async () => {
    let executions = 0,
      reports = 0;
    const result = await runPlan(
      snapshotPlan({
        steps: [
          leaf("completed"),
          gate(
            "must-not-evaluate",
            variable("runtime", "missing"),
            literal(1),
            [leaf("must-not-send")],
          ),
        ],
      }),
      {},
      async () => {
        executions++;
        return response();
      },
      {
        onStep: () => {
          reports++;
          if (asynchronous)
            return Promise.reject(Error("private reporter detail"));
          throw Error("private reporter detail");
        },
      },
    );
    assert.equal(executions, 1);
    assert.equal(reports, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "progress-failure");
    assert.equal(result.progressFailure.code, "EXECUTION_PROGRESS_FAILED");
    assert.equal(result.progressFailure.retry_safe, false);
    assert.equal(result.results[0].status, "passed");
    assert.equal(result.results[0].response.status, 200);
    assert.deepEqual(result.conditionResults, []);
    assert.equal(
      JSON.stringify(result).includes("private reporter detail"),
      false,
    );
  });

test("IF decisions use explicit scopes while A/false-B/B/A leaves keep collection identities", async () => {
  const collectionScopes = ["a", "b"].map((id) => ({
    collectionId: id,
    collection: { only: id, decision: "collection-" + id },
    collectionTypes: { only: "any", decision: "any" },
  }));
  const selected = (id, collection) =>
    leaf(id, {
      postmanCollectionId: collection,
      url: "http://127.0.0.1:1/{{only}}",
    });
  const plan = snapshotPlan({
    steps: [
      selected("a-first", "a"),
      gate("false-b", variable("globals", "decision"), literal("not-global"), [
        selected("skip-b", "b"),
      ]),
      gate("true-b", variable("globals", "decision"), literal("global"), [
        selected("b", "b"),
      ]),
      selected("a-last", "a"),
    ],
  });
  const source = structuredClone(collectionScopes),
    seen = [];
  const result = await runPlan(
    plan,
    {},
    async (request) => {
      seen.push([request.postmanCollectionId, request.url]);
      return response();
    },
    {
      variableScopes: {
        globals: { decision: "global" },
        environment: {},
        runtime: {},
        hidden: [],
      },
      collectionScopes,
    },
  );
  assert.equal(result.status, "passed");
  assert.deepEqual(seen, [
    ["a", "http://127.0.0.1:1/a"],
    ["b", "http://127.0.0.1:1/b"],
    ["a", "http://127.0.0.1:1/a"],
  ]);
  assert.deepEqual(
    result.conditionResults.map((d) => d.matched),
    [false, true],
  );
  assert.deepEqual(collectionScopes, source);
  // An explicit runtime lookup must not borrow the previous collection's value.
  plan.steps[1].condition = {
    op: "eq",
    left: variable("runtime", "only"),
    right: literal("a"),
  };
  seen.length = 0;
  const missing = await runPlan(
    plan,
    {},
    async (request) => {
      seen.push(request.url);
      return response();
    },
    { collectionScopes },
  );
  assert.equal(missing.stopReason, "condition-error");
  assert.deepEqual(seen, ["http://127.0.0.1:1/a"]);
  assert.equal(missing.results[0].status, "passed");
});

for (const dialect of ["modern", "legacy"])
  test(`${dialect} unique tuples and three catalogues retain their guards under IF/repeat frozen backup`, async () => {
    const project = blankAttributeProject("if-catalogues");
    importIntoProject(project, combinedDocument("http://127.0.0.1:1/never"));
    const expected = catalogueSemantics(project);
    const slots = [{ const: { a: 1, b: 2 } }, { const: { a: 2 } }];
    const schema = {
      type: "array",
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
      ...(dialect === "modern"
        ? { prefixItems: slots, items: false }
        : { items: slots, additionalItems: false }),
    };
    const validator = (
      dialect === "modern"
        ? new Ajv2020({ strict: false })
        : new Ajv({ strict: false })
    ).compile(schema);
    project.requests[0].schema = schema;
    project.plans = [
      snapshotPlan({
        id: "if-plan",
        steps: [
          gate("false", literal(false), literal(true), [
            leaf("skip", project.requests[0]),
          ]),
          {
            id: "repeat",
            type: "repeat",
            count: 2,
            steps: [
              gate("true", literal(true), literal(true), [
                leaf("run", project.requests[0]),
              ]),
            ],
          },
        ],
      }),
    ];
    const restored = restoreProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(catalogueSemantics(restored), expected);
    let executions = 0;
    const run = await runPlan(restored.plans[0], {}, async (request) => {
      executions++;
      assert.deepEqual(request.attributes, project.requests[0].attributes);
      const sample = sampleFromSchema(request.schema);
      assert.equal(validator(sample), true);
      return { status: 200, headers: {}, body: JSON.stringify(sample) };
    });
    assert.equal(run.status, "passed");
    assert.equal(executions, 2);
    assert.deepEqual(
      run.conditionResults.map((d) => d.matched),
      [false, true, true],
    );
    assert.notEqual(
      run.results[0].repeat.occurrenceId,
      run.results[1].repeat.occurrenceId,
    );
    assert.throws(
      () => assertNativeLinearPlan(restored.plans[0]),
      /循环组或条件组/,
    );
    assert.throws(() => assertNativeLinearResult(run), /循环组或条件组/);
    assert.throws(() => exportApipost(restored), /plans|计划/);
    assert.throws(() => exportApipostDirectory(restored), /HTTP步骤/);
    // Definition-only export is still a supported, deliberately explicit subset.
    const definitions = { ...restored, plans: [] };
    for (const encode of [exportApipost, exportApipostDirectory]) {
      const next = blankAttributeProject("if-definitions");
      importIntoProject(next, JSON.parse(JSON.stringify(encode(definitions))));
      assert.deepEqual(catalogueSemantics(next), expected);
      assert.equal(validator(sampleFromSchema(next.requests[0].schema)), true);
    }
    for (const kind of ["proxy", "getter"]) {
      let hooks = 0;
      const damaged = structuredClone(schema),
        key = dialect === "modern" ? "prefixItems" : "items";
      if (kind === "proxy")
        damaged[key] = new Proxy(damaged[key], {
          get() {
            hooks++;
            throw Error("unexpected hook");
          },
        });
      else
        Object.defineProperty(damaged[key], "0", {
          enumerable: true,
          get() {
            hooks++;
            throw Error("unexpected hook");
          },
        });
      assert.throws(() => sampleFromSchema(damaged), /JSON|访问器|Proxy|稀疏/);
      assert.equal(hooks, 0);
      assert.equal(validator(sampleFromSchema(schema)), true);
      assert.deepEqual(catalogueSemantics(restored), expected);
    }
  });
