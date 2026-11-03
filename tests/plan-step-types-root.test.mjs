import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { snapshotPlan, restoreProject, runPlan } from "../src/core.mjs";
import { validatePlanStepTypes } from "../src/plan-step-types.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
const leaf = (id, url, type) => ({ id, type, request: { method: "GET", url } });
test("root repeat admission preserves nested ordering and rejects unknown disabled descendants before any HTTP", async (t) => {
  const seen = [];
  const server = http.createServer((q, s) => {
    seen.push(q.url);
    s.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/ok`;
  const plan = {
    id: "p",
    steps: [
      leaf("first", url),
      {
        id: "g",
        type: "repeat",
        count: 2,
        steps: [leaf("nested", url, "http")],
      },
    ],
  };
  const frozen = snapshotPlan(plan);
  const run = await runPlan(frozen, {}, async (q) => {
    const r = await fetch(q.url);
    return { status: r.status, headers: {}, body: await r.text() };
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(seen, ["/ok", "/ok", "/ok"]);
  for (const type of ["unknown", "", null, false]) {
    const bad = structuredClone(plan);
    bad.steps[1].enabled = false;
    bad.steps[1].steps[0].type = type;
    const count = seen.length;
    assert.throws(() => snapshotPlan(bad));
    await assert.rejects(
      runPlan(bad, {}, () => {
        throw Error("must not execute");
      }),
    );
    assert.throws(() =>
      restoreProject({
        version: 1,
        requests: [],
        environments: [],
        plans: [bad],
      }),
    );
    assert.equal(seen.length, count);
  }
});
test("direct CLI grants reject unknown types before reading connection input", () => {
  let reads = 0;
  const connections = new Proxy([], {
    get() {
      reads++;
      throw Error("must not read");
    },
  });
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        { steps: [leaf("s", "http://localhost", "unknown")] },
        connections,
      ),
    /步骤类型/,
  );
  assert.equal(reads, 0);
});
test("repeat input admission rejects cyclic and proxy data without traps but accepts inert aliases", () => {
  const request = { url: "http://localhost" };
  const steps = [
    {
      id: "g",
      type: "repeat",
      count: 1,
      steps: [
        { id: "a", request },
        { id: "b", request },
      ],
    },
  ];
  validatePlanStepTypes(steps);
  let traps = 0;
  const bad = structuredClone(steps);
  bad[0].steps[0] = new Proxy(bad[0].steps[0], {
    get() {
      traps++;
      throw Error("trap");
    },
    ownKeys() {
      traps++;
      throw Error("trap");
    },
  });
  assert.throws(() => validatePlanStepTypes(bad));
  assert.equal(traps, 0);
  const cyclic = structuredClone(steps);
  cyclic[0].steps[0].request.cycle = cyclic;
  assert.throws(() => validatePlanStepTypes(cyclic));
});

test("restore preflights live and historical type getters before any generic plan traversal", () => {
  for (const history of [false, true]) {
    let calls = 0;
    const step = leaf("s", "http://127.0.0.1:1/never");
    Object.defineProperty(step, "type", {
      enumerable: true,
      get() {
        calls++;
        return "http";
      },
    });
    const backup = {
      version: 1,
      requests: [],
      environments: [],
      plans: history ? [] : [{ steps: [step] }],
      runs: history
        ? [{ id: "r", results: [], snapshot: { steps: [step] } }]
        : [],
    };
    assert.throws(() => restoreProject(backup));
    assert.equal(calls, 0);
  }
});
