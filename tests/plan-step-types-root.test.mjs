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

test("repeat type and structural diagnostics retain loop context without evaluating hooks", async () => {
  let calls = 0;
  const changes = [
    (steps) => (steps[1].steps[0].type = "repeat"),
    (steps) => (steps[1].steps[0].type = "unknown"),
    (steps) => (steps[0].type = "unknown"),
    (steps) => (steps[1].steps = null),
    (steps) => delete steps[1].steps[0],
    (steps) => (steps[1].steps[0] = null),
    (steps) =>
      Object.defineProperty(steps[1], "steps", {
        enumerable: true,
        get() {
          calls++;
          throw Error("must not read children");
        },
      }),
    (steps) =>
      Object.defineProperty(steps[1].steps[0], "type", {
        enumerable: true,
        get() {
          calls++;
          throw Error("must not read type");
        },
      }),
    (steps) =>
      (steps[1].steps[0] = new Proxy(steps[1].steps[0], {
        getOwnPropertyDescriptor() {
          calls++;
          throw Error("must not trap");
        },
      })),
  ];
  for (const change of changes) {
    const steps = [
      leaf("first", "http://localhost"),
      {
        id: "group",
        type: "repeat",
        enabled: false,
        count: 2,
        steps: [leaf("child", "http://localhost")],
      },
    ];
    change(steps);
    assert.throws(() => snapshotPlan({ steps }), /循环.*步骤类型/);
    await assert.rejects(
      runPlan({ steps }, {}, () => {
        throw Error("must not execute");
      }),
      /循环.*步骤类型/,
    );
  }
  assert.equal(calls, 0);
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
  assert.throws(() => snapshotPlan({ steps: cyclic }), /循环计划/);
  cyclic[0].steps = cyclic;
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

test("restore keeps invalid run-container diagnostics before snapshot admission", () => {
  for (const runs of [{}, "invalid", [null], [[]], [false]])
    assert.throws(
      () =>
        restoreProject({
          version: 1,
          requests: [],
          environments: [],
          plans: [],
          runs,
        }),
      { name: "Error", message: "备份中的 runs 格式无效" },
    );
});

test("type-only preflight preserves Postman OAuth2 diagnostics without invoking disabled auth getters", async () => {
  for (const repeated of [false, true]) {
    let reads = 0;
    const request = {
      id: "getter",
      method: "GET",
      url: "http://127.0.0.1:1/never",
    };
    Object.defineProperty(request, "auth", {
      enumerable: true,
      get() {
        reads++;
        return {
          type: "oauth2",
          postmanOAuth2: { version: 1, accessToken: "owned-fake-token" },
        };
      },
    });
    const leaf = { id: "leaf", enabled: false, request };
    const plan = {
      id: "getter-plan",
      steps: repeated
        ? [
            {
              type: "repeat",
              id: "outer",
              count: 1,
              enabled: false,
              steps: [leaf],
            },
          ]
        : [leaf],
    };
    assert.throws(() => snapshotPlan(plan), /Postman OAuth2/);
    assert.throws(
      () =>
        restoreProject({
          version: 1,
          requests: [],
          environments: [],
          plans: [plan],
        }),
      /Postman OAuth2/,
    );
    await assert.rejects(
      runPlan(plan, {}, () => {
        throw Error("must not execute");
      }),
      /Postman OAuth2/,
    );
    assert.equal(reads, 0);
  }
});

test("native OAuth2 and OAuth1 payload accessors retain existing repeat diagnostics and zero side effects", async () => {
  for (const enabled of [true, false])
    for (const kind of ["oauth2", "oauth1"]) {
      let reads = 0,
        executions = 0;
      const auth =
        kind === "oauth2"
          ? {
              type: "oauth2",
              nativeOAuth2: {
                addTokenTo: "queryParams",
                access_token: "owned-fake-token",
              },
            }
          : {
              type: "oauth1",
              consumerKey: "owned-fake-key",
              parameterPolicy: {
                placement: "auto",
                includeBodyHash: true,
                includeEmptyParams: false,
                headerEncoding: "percent",
              },
            };
      const object = kind === "oauth2" ? auth.nativeOAuth2 : auth;
      Object.defineProperty(
        object,
        kind === "oauth2" ? "access_token" : "consumerKey",
        {
          enumerable: true,
          get() {
            reads++;
            return "owned-fake-value";
          },
        },
      );
      const plan = {
        steps: [
          {
            type: "repeat",
            id: "outer",
            count: 2,
            enabled,
            steps: [
              {
                type: "repeat",
                id: "inner",
                count: 2,
                steps: [
                  {
                    id: "leaf",
                    request: { url: "http://127.0.0.1:1/never", auth },
                  },
                ],
              },
            ],
          },
        ],
      };
      assert.throws(() => snapshotPlan(plan), /循环计划.*访问器/);
      await assert.rejects(
        runPlan(plan, {}, () => {
          executions++;
        }),
        /循环计划.*访问器/,
      );
      assert.equal(reads, 0);
      assert.equal(executions, 0);
    }
});
test("type graph preflight rejects nested node, child-array proxies and children/type accessors without reading payloads", () => {
  for (const position of ["node", "children", "childrenGetter", "typeGetter"]) {
    let calls = 0;
    const step = {
      id: "g",
      type: "repeat",
      enabled: false,
      count: 1,
      steps: [leaf("s", "http://localhost")],
    };
    const fail = () => {
      calls++;
      throw Error("must not inspect");
    };
    if (position === "node")
      step.steps[0] = new Proxy(step.steps[0], {
        get: fail,
        getOwnPropertyDescriptor: fail,
        getPrototypeOf: fail,
      });
    else if (position === "children")
      step.steps = new Proxy(step.steps, {
        get: fail,
        getOwnPropertyDescriptor: fail,
        getPrototypeOf: fail,
      });
    else
      Object.defineProperty(
        position === "childrenGetter" ? step : step.steps[0],
        position === "childrenGetter" ? "steps" : "type",
        { enumerable: true, get: fail },
      );
    assert.throws(() => validatePlanStepTypes([step]), /步骤类型/);
    assert.equal(calls, 0);
  }
  let calls = 0;
  const request = {};
  Object.defineProperty(request, "auth", {
    get() {
      calls++;
      throw Error("payload");
    },
  });
  assert.throws(
    () => validatePlanStepTypes([{ id: "s", type: "unknown", request }]),
    /步骤类型/,
  );
  assert.equal(calls, 0);
});

test("repeat payload Proxy protection runs before OAuth descriptor readers without consuming accessors", async () => {
  for (const position of ["request", "auth", "nativeOAuth2", "extra"]) {
    let traps = 0,
      reads = 0;
    const trap = () => {
      traps++;
      throw Error("must not trap");
    };
    const auth = {
      type: "oauth2",
      nativeOAuth2: { access_token: "owned-fake-token" },
    };
    const request = { url: "http://127.0.0.1:1/never", auth };
    const plan = {
      steps: [
        {
          id: "outer",
          type: "repeat",
          enabled: false,
          count: 1,
          steps: [{ id: "leaf", request }],
        },
      ],
    };
    Object.defineProperty(request, "unused", {
      enumerable: true,
      get() {
        reads++;
        return "must not read";
      },
    });
    const proxy = (value) =>
      new Proxy(value, {
        get: trap,
        getOwnPropertyDescriptor: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
      });
    if (position === "request") plan.steps[0].steps[0].request = proxy(request);
    else if (position === "auth") request.auth = proxy(auth);
    else if (position === "nativeOAuth2")
      auth.nativeOAuth2 = proxy(auth.nativeOAuth2);
    else request.extra = proxy(function () {});
    assert.throws(() => snapshotPlan(plan), /Proxy/);
    await assert.rejects(
      runPlan(plan, {}, () => {
        throw Error("must not execute");
      }),
      /Proxy/,
    );
    assert.throws(
      () =>
        restoreProject({
          version: 1,
          requests: [],
          environments: [],
          plans: [plan],
        }),
      /Proxy/,
    );
    assert.equal(traps, 0);
    assert.equal(reads, 0);
  }
});

test("repeat data rejects inherited Proxy hooks before OAuth inherited-marker detection", async () => {
  for (const position of ["request", "auth", "nativeOAuth2", "extra"]) {
    let traps = 0;
    const trap = () => {
      traps++;
      return false;
    };
    const inherited = Object.create(
      new Proxy(
        {},
        {
          has: trap,
          get() {
            traps++;
            throw Error("trap");
          },
          getOwnPropertyDescriptor() {
            traps++;
            throw Error("trap");
          },
          getPrototypeOf() {
            traps++;
            throw Error("trap");
          },
        },
      ),
    );
    const request = {
      url: "http://127.0.0.1:1/never",
      auth: {
        type: "oauth2",
        nativeOAuth2: { access_token: "owned-fake-token" },
      },
    };
    const step = { id: "leaf", request };
    if (position === "request") step.request = inherited;
    else if (position === "auth") request.auth = inherited;
    else if (position === "nativeOAuth2") request.auth.nativeOAuth2 = inherited;
    else request.extra = inherited;
    const plan = {
      steps: [
        {
          id: "outer",
          type: "repeat",
          count: 1,
          enabled: false,
          steps: [step],
        },
      ],
    };
    assert.throws(() => snapshotPlan(plan), /原型/);
    await assert.rejects(
      runPlan(plan, {}, () => {
        throw Error("must not execute");
      }),
      /原型/,
    );
    assert.throws(
      () =>
        restoreProject({
          version: 1,
          requests: [],
          environments: [],
          plans: [plan],
        }),
      /原型/,
    );
    assert.equal(traps, 0, position);
  }
});

test("type preflight and repeat data safety retain exact group-depth and data-work boundaries", () => {
  const group = (steps, id) => [{ id, type: "repeat", count: 1, steps }];
  let groups = [leaf("s", "http://localhost")];
  for (let i = 0; i < 4; i++) groups = group(groups, "g" + i);
  validatePlanStepTypes(groups);
  snapshotPlan({ steps: groups });
  const deeper = group(groups, "too-deep");
  assert.throws(() => validatePlanStepTypes(deeper));
  assert.throws(() => snapshotPlan({ steps: deeper }));
  const graph = () =>
    group([{ id: "s", request: { url: "http://localhost", extra: 0 } }], "g");
  const depth32 = graph();
  let extra = 0;
  for (let i = 0; i < 27; i++) extra = { child: extra };
  depth32[0].steps[0].request.extra = extra;
  validatePlanStepTypes(depth32);
  snapshotPlan({ steps: depth32 });
  depth32[0].steps[0].request.extra = { child: extra };
  assert.throws(() => validatePlanStepTypes(depth32), /超限/);
  assert.throws(() => snapshotPlan({ steps: depth32 }), /超限/);
  const count = (value) =>
    1 +
    (value && typeof value === "object"
      ? Object.values(value).reduce((sum, item) => sum + count(item), 0)
      : 0);
  const bounded = graph();
  bounded[0].steps[0].request.extra = [];
  const overhead = count(bounded);
  bounded[0].steps[0].request.extra = Array(100000 - overhead).fill(0);
  assert.equal(count(bounded), 100000);
  validatePlanStepTypes(bounded);
  snapshotPlan({ steps: bounded });
  bounded[0].steps[0].request.extra.push(0);
  assert.equal(count(bounded), 100001);
  assert.throws(() => validatePlanStepTypes(bounded), /超限/);
  assert.throws(() => snapshotPlan({ steps: bounded }), /超限/);
});
