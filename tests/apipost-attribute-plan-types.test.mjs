import test from "node:test";
import assert from "node:assert/strict";
import {
  importIntoProject,
  snapshotPlan,
  restoreProject,
  runPlan,
} from "../src/core.mjs";
import { versionPlan } from "../src/plan-version.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { blankAttributeProject } from "./fixtures/apipost-export-attributes.mjs";
import {
  combinedDocument,
  catalogueSemantics,
} from "./fixtures/apipost-attribute-catalogues.mjs";
function fixture() {
  const p = blankAttributeProject("catalogue-plan-source");
  importIntoProject(p, combinedDocument("http://127.0.0.1:1/no-network"));
  return p;
}
function repeated(p) {
  const leaf = (id, type) => ({
    id,
    type,
    request: structuredClone(p.requests[0]),
  });
  return {
    id: "repeat-plan",
    name: "Frozen",
    environmentId: p.environments[0].id,
    statusPolicy: "strict200",
    steps: [
      leaf("first"),
      {
        id: "group",
        type: "repeat",
        count: 2,
        steps: [leaf("nested", "http")],
      },
    ],
  };
}

test("three catalogues and values survive typed repeat dispatch and backup without implying native repeat export support", async () => {
  const p = fixture(),
    expected = catalogueSemantics(p),
    plan = snapshotPlan(repeated(p));
  p.plans = [plan];
  const before = structuredClone(p),
    seen = [];
  const result = await runPlan(plan, {}, async (request) => {
    seen.push(structuredClone(request.attributes));
    return { status: 200, headers: {}, body: "{}" };
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(seen, Array(3).fill(p.requests[0].attributes));
  const restored = restoreProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(catalogueSemantics(restored), expected);
  assert.deepEqual(restored.plans[0].steps, plan.steps);
  assert.equal(restored.plans[0].steps[1].type, "repeat");
  assert.equal(restored.plans[0].steps[1].count, 2);
  for (const encode of [exportApipost, exportApipostDirectory])
    assert.throws(() => encode(p));
  assert.deepEqual(p, before);
});

test("unknown disabled repeat descendants reject before dispatch, binding or CLI grant input with all three catalogues unchanged", async () => {
  for (const type of ["unknown", "HTTP", "", null, false, 0, {}, []]) {
    const p = fixture(),
      plan = repeated(p);
    plan.steps[1].enabled = false;
    plan.steps[1].steps[0].type = type;
    const before = structuredClone(p),
      planBefore = structuredClone(plan);
    let calls = 0,
      reads = 0;
    assert.throws(() => snapshotPlan(plan));
    assert.throws(() => versionPlan(undefined, plan, "manual", p));
    await assert.rejects(
      runPlan(plan, {}, async () => {
        calls++;
        return { status: 200 };
      }),
    );
    const connections = new Proxy([], {
      get() {
        reads++;
        throw Error("must not access grant data");
      },
    });
    assert.throws(() => prepareCLIDatabaseGrants(p.id, plan, connections));
    assert.throws(() => restoreProject({ ...p, plans: [plan] }));
    assert.equal(calls, 0);
    assert.equal(reads, 0);
    assert.deepEqual(p, before);
    assert.deepEqual(plan, planBefore);
  }
});

test("valid empty-attribute HTTP snapshots and all three catalogues roundtrip the native directory twice, invalid type never becomes HTTP", () => {
  const p = fixture(),
    expected = catalogueSemantics(p),
    request = { ...structuredClone(p.requests[0]), attributes: {} };
  p.plans = [
    snapshotPlan({
      id: "p",
      name: "HTTP",
      statusPolicy: "strict200",
      environmentId: p.environments[0].id,
      steps: [{ id: "s", type: "http", name: request.name, request }],
    }),
  ];
  let current = p;
  for (let i = 0; i < 2; i++) {
    const before = structuredClone(current),
      output = JSON.parse(JSON.stringify(exportApipostDirectory(current))),
      next = blankAttributeProject("generation-" + i);
    importIntoProject(next, output);
    assert.deepEqual(catalogueSemantics(next), expected);
    assert.equal(next.plans.length, 1);
    assert.deepEqual(next.plans[0].steps[0].request.attributes, {});
    assert.deepEqual(current, before);
    current = next;
  }
  const malformed = structuredClone(p);
  malformed.plans[0].steps[0].type = "unsupported";
  const before = structuredClone(malformed);
  assert.throws(() => exportApipostDirectory(malformed));
  assert.deepEqual(malformed, before);
});

test("typed restore preflight keeps three catalogue data and historical getter boundaries intact", () => {
  for (const history of [false, true]) {
    const p = fixture(),
      expected = catalogueSemantics(p);
    let calls = 0;
    const step = {
      id: "invalid",
      request: { url: "http://127.0.0.1:1/never" },
    };
    Object.defineProperty(step, "type", {
      enumerable: true,
      get() {
        calls++;
        return "http";
      },
    });
    if (history)
      p.runs = [{ id: "r", results: [], snapshot: { steps: [step] } }];
    else p.plans = [{ id: "p", steps: [step] }];
    assert.throws(() => restoreProject(p));
    assert.equal(calls, 0);
    assert.deepEqual(catalogueSemantics(p), expected);
  }
});
