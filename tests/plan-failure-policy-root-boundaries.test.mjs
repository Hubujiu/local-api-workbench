// Pure injected-executor composition checks, not owner/SDK or transport acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotPlan,
  runPlan,
  importIntoProject,
  restoreProject,
} from "../src/core.mjs";
import { httpFinalizationFailure } from "../src/http-finalization.mjs";
import { httpRedirectFailure } from "../src/http-redirect.mjs";
import { requestTimeout } from "../src/request-control.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";
import { blankAttributeProject } from "./fixtures/apipost-export-attributes.mjs";
import {
  combinedDocument,
  catalogueSemantics,
} from "./fixtures/apipost-attribute-catalogues.mjs";
import { sampleFromSchema } from "../src/schema-sample.mjs";

const leaf = (id, extra = {}) => ({
  id,
  request: {
    id: "request-" + id,
    url: "http://127.0.0.1:1/" + id,
    method: "POST",
    ...extra,
  },
});
const gate = (id, steps, left = { literal: true }) => ({
  id,
  type: "if",
  condition: { op: "eq", left, right: { literal: true } },
  steps,
});
const policy = (value) => (value === undefined ? {} : { failurePolicy: value });
const response = (status = 200) => ({
  status,
  headers: {},
  body: '{"accepted":true}',
});

for (const value of [undefined, "continue", "stop"]) {
  const label = value ?? "omitted";
  for (const asynchronous of [false, true])
    test(`${label} retains root ${asynchronous ? "async" : "sync"} progress failure before optional stop`, async () => {
      let calls = 0;
      const plan = snapshotPlan({
        ...policy(value),
        steps: [gate("first", [leaf("failed")]), gate("never", [leaf("tail")])],
      });
      const run = await runPlan(
        plan,
        {},
        async () => {
          calls++;
          return response(401);
        },
        {
          onStep() {
            if (asynchronous) return Promise.reject(Error("private-observer"));
            throw Error("private-observer");
          },
        },
      );
      assert.equal(calls, 1);
      assert.equal(run.status, "failed");
      assert.equal(run.stopReason, "progress-failure");
      assert.equal(run.failureStop, undefined);
      assert.equal(run.progressFailure.retry_safe, false);
      assert.equal(run.results.length, 1);
      assert.equal(run.results[0].response.status, 401);
      assert.equal(run.results[0].response.body, '{"accepted":true}');
      assert.equal(run.conditionResults.length, 1);
      assert.doesNotMatch(JSON.stringify(run), /private-observer/);
    });

  for (const kind of ["finalization", "redirect"])
    test(`${label} cannot override trusted HTTP ${kind} hard stop or relabel its completed response`, async () => {
      let calls = 0;
      const completed = response(kind === "redirect" ? 302 : 200);
      const run = await runPlan(
        snapshotPlan({
          ...policy(value),
          steps: [
            gate("first", [
              leaf("completed", {
                after: [{ type: "set", name: "leak", value: "bad" }],
              }),
            ]),
            gate("never", [leaf("tail")]),
          ],
        }),
        {},
        async () => {
          calls++;
          throw kind === "finalization"
            ? httpFinalizationFailure(completed, requestTimeout())
            : httpRedirectFailure(
                completed,
                "origin",
                [],
                "http://127.0.0.1:2/blocked",
                false,
                true,
              );
        },
      );
      assert.equal(calls, 1);
      assert.equal(run.status, "failed");
      assert.equal(run.failureStop, undefined);
      assert.equal(run.stopReason, undefined);
      assert.deepEqual(run.results[0].response, completed);
      assert.equal(
        run.results[0][kind === "redirect" ? "redirectFailure" : "failure"]
          .retry_safe,
        false,
      );
      assert.equal(run.variables.leak, undefined);
      assert.equal(run.conditionResults.length, 1);
      assert.equal(run.results.length, 1);
    });

  test(`${label} cannot hide native SET authority behind a failure or false IF`, async () => {
    const project = blankAttributeProject("policy-native-authority");
    importIntoProject(
      project,
      nativeRedisFixture("http://127.0.0.1:1/never", {
        method: "set",
        query: JSON.stringify({ key: "fixture-key", value: "fixture-value" }),
      }),
    );
    let calls = 0,
      preparations = 0,
      queries = 0;
    const plan = snapshotPlan({
      ...policy(value),
      steps: [
        leaf("would-fail"),
        gate("false", [leaf("write", project.requests[0])], { literal: false }),
      ],
    });
    await assert.rejects(
      runPlan(
        plan,
        {},
        async () => {
          calls++;
          return response(401);
        },
        {
          prepareRequest(request) {
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
    assert.deepEqual([calls, preparations, queries], [0, 0, 0]);
  });

  test(`${label} retains condition error instead of inventing an ordinary failure leaf`, async () => {
    let calls = 0;
    const run = await runPlan(
      snapshotPlan({
        ...policy(value),
        steps: [
          leaf("completed"),
          gate("missing", [leaf("never")], {
            scope: "runtime",
            name: "missing",
          }),
        ],
      }),
      {},
      async () => {
        calls++;
        return response();
      },
    );
    assert.equal(calls, 1);
    assert.equal(run.stopReason, "condition-error");
    assert.equal(run.failureStop, undefined);
    assert.equal(run.results[0].status, "passed");
    assert.equal(run.conditionResults[0].status, "failed");
  });
}

test("stop keeps confirmed collection scope selection before a failing leaf, without entering a later collection", async () => {
  const collections = ["a", "b"].map((collectionId) => ({
    collectionId,
    collection: { only: collectionId },
    collectionTypes: { only: "any" },
  }));
  const before = structuredClone(collections),
    seen = [];
  const selected = (id, collection) =>
    leaf(id, {
      postmanCollectionId: collection,
      url: "http://127.0.0.1:1/{{only}}",
    });
  const run = await runPlan(
    snapshotPlan({
      failurePolicy: "stop",
      steps: [
        selected("accepted-a", "a"),
        gate("fail-b", [selected("failed-b", "b")]),
        selected("never-a", "a"),
      ],
    }),
    {},
    async (request) => {
      seen.push([request.postmanCollectionId, request.url]);
      return response(seen.length === 2 ? 401 : 200);
    },
    { collectionScopes: collections },
  );
  assert.deepEqual(seen, [
    ["a", "http://127.0.0.1:1/a"],
    ["b", "http://127.0.0.1:1/b"],
  ]);
  assert.equal(run.stopReason, "step-failure");
  assert.equal(run.failureStop.stepId, "failed-b");
  assert.deepEqual(
    run.results.map((r) => r.status),
    ["passed", "failed"],
  );
  assert.deepEqual(collections, before);
});

for (const value of [undefined, "continue", "stop"])
  test(`${value ?? "omitted"} preserves repeat evidence-limit rather than inventing ordinary failure`, async () => {
    let calls = 0;
    const run = await runPlan(
      snapshotPlan({
        ...policy(value),
        steps: [
          { id: "repeat", type: "repeat", count: 3, steps: [leaf("large")] },
          gate("never", [leaf("tail")]),
        ],
      }),
      {},
      async () => {
        calls++;
        return { ...response(), body: "x".repeat(3 * 1024 * 1024) };
      },
    );
    assert.equal(calls, 3);
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "evidence-limit");
    assert.equal(run.failureStop, undefined);
    assert.equal(run.evidenceBudget.executed, 3);
    assert.equal(run.evidenceBudget.next.stepId, "never");
    assert.ok(run.results.every((record) => record.status === "passed"));
    assert.deepEqual(run.conditionResults, []);
  });

for (const dialect of ["modern", "legacy"])
  test(`stop plan frozen backup preserves ${dialect} tuple and three attribute catalogues before failure`, async () => {
    const project = blankAttributeProject("policy-catalogues");
    importIntoProject(project, combinedDocument("http://127.0.0.1:1/never"));
    const before = catalogueSemantics(project);
    const slots = [{ const: { value: 0 } }, { const: { value: false } }];
    const schema = {
      type: "array",
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
      ...(dialect === "modern"
        ? { prefixItems: slots, items: false }
        : { items: slots, additionalItems: false }),
    };
    project.requests[0].schema = schema;
    project.plans = [
      snapshotPlan({
        failurePolicy: "stop",
        steps: [
          {
            id: "repeat",
            type: "repeat",
            count: 2,
            steps: [
              leaf("sample", project.requests[0]),
              leaf("failed"),
              leaf("never"),
            ],
          },
        ],
      }),
    ];
    const copy = restoreProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(catalogueSemantics(copy), before);
    assert.equal(copy.plans[0].failurePolicy, "stop");
    let calls = 0;
    const run = await runPlan(copy.plans[0], {}, async (request) => {
      calls++;
      if (calls === 1) {
        assert.deepEqual(request.attributes, project.requests[0].attributes);
        assert.deepEqual(sampleFromSchema(request.schema), [
          { value: 0 },
          { value: false },
        ]);
      }
      return response(calls === 1 ? 200 : 401);
    });
    assert.equal(calls, 2);
    assert.equal(run.stopReason, "step-failure");
    assert.equal(run.failureStop.stepId, "failed");
    assert.equal(run.failureStop.repeat.iteration, 0);
    assert.deepEqual(catalogueSemantics(copy), before);
  });
