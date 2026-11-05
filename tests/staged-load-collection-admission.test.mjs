import test from "node:test";
import assert from "node:assert/strict";
import { prepareStagedLoad, runStagedLoad } from "../src/staged-load-plan.mjs";
import { preparePostmanCollection } from "../src/postman-collection-scopes.mjs";

const schedule = {
  initialVUs: 1,
  stages: [{ durationSeconds: 1, targetVUs: 1 }],
  maxIterations: 1,
};
const project = () => ({
  environments: [{ id: "env", name: "env", variables: {} }],
  activeEnvironmentId: "env",
  requests: [],
  plans: [],
  cases: [],
  postmanCollections: {
    version: 1,
    items: [
      preparePostmanCollection(
        { info: { name: "a" }, item: [], variable: [] },
        () => "a",
      ),
    ],
  },
});
const plan = (id = "a") => ({
  steps: [
    { id: "active", request: { url: "http://127.0.0.1:1/never" } },
    {
      id: "disabled",
      enabled: false,
      request: { postmanCollectionId: id, url: "http://127.0.0.1:1/never" },
    },
  ],
});

test("preparation validates disabled collection identities and registry before environment access", () => {
  for (const id of ["missing", null, "", "__proto__"]) {
    const p = project();
    Object.defineProperty(p, "environments", {
      get() {
        assert.fail("environment read before rejection");
      },
    });
    assert.throws(() => prepareStagedLoad(p, plan(id), schedule), /collection/);
  }
  const p = project();
  p.postmanCollections.items[0].variables.invalid = 1;
  assert.throws(() => prepareStagedLoad(p, plan(), schedule), /collection/);
});

test("direct execution revalidates prepared bindings against current project before scopes and reports", async () => {
  const p = project();
  const prepared = prepareStagedLoad(p, plan(), schedule);
  for (const mutate of [
    (p) => {
      p.postmanCollections.items = [];
    },
    (_p, value) => {
      value.snapshot.steps[1].request.postmanCollectionId = "missing";
    },
    (p) => {
      p.postmanCollections.items[0].definitions.bad = {
        initialValue: 0,
        type: "unknown",
        description: "",
      };
    },
  ]) {
    const current = structuredClone(p);
    const value = structuredClone(prepared);
    mutate(current, value);
    Object.defineProperty(current, "environments", {
      get() {
        assert.fail("environment read before rejection");
      },
    });
    await assert.rejects(
      runStagedLoad(current, value, {
        onProgress() {
          assert.fail("report before rejection");
        },
      }),
      /collection/,
    );
  }
});
