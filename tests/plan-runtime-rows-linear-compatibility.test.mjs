import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { validateRepeatGraph } from "../src/plan-repeat.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
import { materializeLivePlan } from "../src/live-plan-materialize.mjs";

const optIn = { allowRuntimeRows: true };
let schema = { type: "string" };
for (let i = 0; i < 34; i++) schema = { properties: { child: schema } };
for (const [label, metadata] of [
  ["deep schema", schema],
  ["Date", new Date("2026-01-01")],
  ["NaN", NaN],
]) {
  test(`opt-in preserves legacy linear ${label} across validator/core/grants/live`, async () => {
    const plan = {
      id: "plan",
      steps: [
        {
          id: "leaf",
          request: {
            url: "http://example.test",
            extract: [],
            assertions: [],
            unusedMetadata: metadata,
          },
        },
      ],
    };
    for (const options of [{}, optIn]) {
      assert.equal(validateRepeatGraph(plan.steps, options), false);
      assert.equal(snapshotPlan(plan, options).steps.length, 1);
      let requests = 0;
      const result = await runPlan(
        plan,
        {},
        async () => {
          requests++;
          return { status: 200, headers: {}, body: "{}" };
        },
        options,
      );
      assert.equal(result.status, "passed");
      assert.equal(requests, 1);
      const grants = prepareCLIDatabaseGrants("project", plan, {}, [], options);
      await grants.preflight([]);
      grants.close();
      const livePlan = structuredClone(plan);
      livePlan.steps[0].liveRequestId = "api";
      const project = {
        id: "project",
        requests: [
          {
            id: "api",
            name: "source",
            method: "GET",
            url: "http://example.test/fresh",
            unusedMetadata: metadata,
          },
        ],
        environments: [{ id: "env", name: "env", variables: {} }],
        settings: {},
      };
      const materialized = materializeLivePlan(project, livePlan, options);
      assert.equal(materialized.bindings.length, 1);
      assert.equal(
        materialized.plan.steps[0].request.url,
        "http://example.test/fresh",
      );
    }
    assert.throws(() =>
      validateRepeatGraph(
        [{ id: "fixed", type: "repeat", count: 1, steps: plan.steps }],
        optIn,
      ),
    );
  });
}

test("linear opt-in fast path never invokes graph getters or Proxy traps", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw Error("trap");
  };
  const proxy = new Proxy(
    {},
    {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    },
  );
  const getterType = { id: "leaf", request: {} };
  Object.defineProperty(getterType, "type", { enumerable: true, get: trap });
  const getterEntry = [];
  Object.defineProperty(getterEntry, "0", { enumerable: true, get: trap });
  for (const steps of [
    new Proxy([], { get: trap, getOwnPropertyDescriptor: trap }),
    [proxy],
    [getterType],
    getterEntry,
  ]) {
    assert.throws(() => validateRepeatGraph(steps, optIn));
  }
  assert.equal(calls, 0);
});
