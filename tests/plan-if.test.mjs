import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { snapshotPlan, runPlan, restoreProject } from "../src/core.mjs";
import { executeRequest } from "../src/runtime.mjs";

const literal = (value) => ({ literal: value });
const variable = (name, scope = "runtime") => ({ scope, name });
const leaf = (id, url, extract = []) => ({
  id,
  request: { method: "GET", url, extract },
});
const conditional = (id, left, op, right, steps) => ({
  type: "if",
  id,
  condition: { left, op, right },
  steps,
});
async function fixture(t) {
  const seen = [];
  let entered;
  const held = new Promise((resolve) => {
    entered = resolve;
  });
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/hold") {
      entered();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        count: req.url === "/setup" ? 1 : 0,
        token: "committed",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { seen, held, url: `http://127.0.0.1:${server.address().port}` };
}

test(
  "IF reads committed extraction when reached and false children produce no network or fake successes",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const plan = snapshotPlan({
      steps: [
        leaf("setup", f.url + "/setup", [
          { name: "count", source: "json", path: "$.count" },
        ]),
        conditional("yes", variable("count"), "eq", literal(1), [
          leaf("yes-child", f.url + "/yes"),
        ]),
        conditional("no", variable("count"), "gt", literal(1), [
          leaf("no-child", f.url + "/never"),
        ]),
        leaf("last", f.url + "/last"),
      ],
    });
    const before = structuredClone(plan);
    const result = await runPlan(plan, {}, executeRequest);
    assert.equal(result.status, "passed");
    assert.deepEqual(f.seen, ["/setup", "/yes", "/last"]);
    assert.deepEqual(
      result.results.map((r) => r.stepId),
      ["setup", "yes-child", "last"],
    );
    assert.deepEqual(
      result.conditionResults.map((r) => [r.stepId, r.matched]),
      [
        ["yes", true],
        ["no", false],
      ],
    );
    assert.deepEqual(plan, before);
    assert.deepEqual(result.snapshot, before);
    assert.ok(
      result.conditionResults.every(
        (r) => !Object.hasOwn(r, "left") && !Object.hasOwn(r, "right"),
      ),
    );
  },
);

test(
  "false-only IF succeeds as a decision with no HTTP result and missing inputs fail instead of becoming false",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const plan = snapshotPlan({
      steps: [
        conditional("if", literal(1), "eq", literal(2), [
          leaf("never", f.url + "/never"),
        ]),
      ],
    });
    const result = await runPlan(plan, {}, executeRequest);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.results, []);
    assert.equal(result.conditionResults[0].matched, false);
    plan.steps[0].condition.left = variable("absent");
    const failure = await runPlan(plan, {}, executeRequest);
    assert.equal(failure.status, "failed");
    assert.equal(failure.stopReason, "condition-error");
    assert.equal(failure.conditionResults[0].status, "failed");
    assert.equal(Object.hasOwn(failure.conditionResults[0], "matched"), false);
    assert.deepEqual(f.seen, []);
  },
);

test(
  "IF nested in repeat reevaluates scopes per iteration and enclosing IF gates a complete repeat",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const plan = snapshotPlan({
      steps: [
        leaf("setup", f.url + "/setup", [
          { name: "count", source: "json", path: "$.count" },
        ]),
        {
          type: "repeat",
          id: "repeat",
          count: 2,
          steps: [
            conditional("once", variable("count"), "eq", literal(1), [
              leaf("consume", f.url + "/consume", [
                { name: "count", source: "json", path: "$.count" },
              ]),
            ]),
          ],
        },
        conditional("gate", literal(false), "eq", literal(true), [
          {
            type: "repeat",
            id: "blocked-repeat",
            count: 2,
            steps: [leaf("blocked", f.url + "/blocked")],
          },
        ]),
      ],
    });
    const result = await runPlan(plan, {}, executeRequest);
    assert.equal(result.status, "passed");
    assert.deepEqual(f.seen, ["/setup", "/consume"]);
    assert.deepEqual(
      result.conditionResults.map((r) => r.matched),
      [true, false, false],
    );
    assert.notEqual(
      result.conditionResults[0].occurrenceId,
      result.conditionResults[1].occurrenceId,
    );
    assert.deepEqual(result.results[1].repeat.path, undefined);
    assert.equal(result.results[1].repeat.iteration, 0);
  },
);

test(
  "cancelling a held true child starts no later child, IF or sibling",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      controller = new AbortController();
    const plan = snapshotPlan({
      steps: [
        conditional("if", literal(true), "eq", literal(true), [
          leaf("hold", f.url + "/hold"),
          leaf("later", f.url + "/later"),
        ]),
        leaf("tail", f.url + "/tail"),
      ],
    });
    const running = runPlan(plan, {}, executeRequest, {
      signal: controller.signal,
    });
    await Promise.race([
      f.held,
      running.then(() => {
        throw Error("run completed before held request");
      }),
    ]);
    controller.abort();
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(f.seen, ["/hold"]);
    assert.equal(result.conditionResults.length, 1);
    assert.equal(result.results.length, 1);
  },
);

test(
  "IF full-tree admission rejects invalid disabled children before an earlier real request",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    for (const mutate of [
      (g) => (g.condition.op = "eval"),
      (g) => (g.steps[0].type = "unknown"),
      (g) => (g.condition.left = literal("")),
      (g) => (g.condition.left = literal(Infinity)),
    ]) {
      const group = conditional("if", literal(1), "eq", literal(1), [
        leaf("child", f.url + "/never"),
      ]);
      group.enabled = false;
      mutate(group);
      const plan = { steps: [leaf("first", f.url + "/first"), group] };
      assert.throws(() => snapshotPlan(plan));
      await assert.rejects(runPlan(plan, {}, executeRequest));
    }
    assert.deepEqual(f.seen, []);
  },
);

test(
  "IF rejects scope getters, proxies, custom serialization and nonfinite values before cloning or wire",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      plan = snapshotPlan({
        steps: [
          conditional(
            "if",
            variable("count", "environment"),
            "eq",
            literal(1),
            [leaf("child", f.url + "/never")],
          ),
        ],
      });
    let calls = 0;
    for (const values of [
      Object.defineProperty({}, "count", {
        enumerable: true,
        get() {
          calls++;
          return 1;
        },
      }),
      new Proxy(
        { count: 1 },
        {
          ownKeys() {
            calls++;
            return ["count"];
          },
        },
      ),
      {
        count: {
          toJSON() {
            calls++;
            return 1;
          },
        },
      },
      { count: NaN },
      { count: Infinity },
    ])
      await assert.rejects(runPlan(plan, values, executeRequest));
    assert.equal(calls, 0);
    assert.deepEqual(f.seen, []);
  },
);

test(
  "false and disabled children run no scripts, native tasks, database, extraction or prepare callbacks",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const script = leaf("script", f.url + "/script");
    script.request.beforeScript =
      'pm.environment.set("unexpected", "script"); throw Error("must not execute");';
    script.request.extract = [
      { name: "unexpected", source: "json", path: "$.token" },
    ];
    const native = leaf("native", f.url + "/native");
    native.request.inheritSharedScripts = false;
    native.request.nativeTasks = {
      version: 1,
      before: [
        {
          type: "customScript",
          enabled: 1,
          data: 'pm.environment.set("unexpected", "native");',
        },
        {
          type: "database",
          enabled: 1,
          data: {
            connectionId: "unbound",
            query: "SELECT 1",
            isConsoleOutput: -1,
            variables: [],
          },
        },
      ],
      after: [],
    };
    const plan = snapshotPlan({
      steps: [
        conditional("false", literal(false), "eq", literal(true), [
          script,
          native,
        ]),
        {
          ...conditional("disabled", variable("missing"), "eq", literal(1), [
            leaf("disabled-leaf", f.url + "/disabled"),
          ]),
          enabled: false,
        },
        leaf("tail", f.url + "/tail"),
      ],
    });
    let prepared = 0,
      queries = 0,
      commits = 0;
    const result = await runPlan(plan, {}, executeRequest, {
      prepareRequest: (request) => {
        prepared++;
        return request;
      },
      databaseQuery: () => {
        queries++;
        throw Error("must not query");
      },
      onScopeChanges: () => {
        commits++;
        throw Error("must not persist");
      },
    });
    assert.equal(result.status, "passed");
    assert.deepEqual(f.seen, ["/tail"]);
    assert.equal(prepared, 1);
    assert.equal(queries, 0);
    assert.equal(commits, 0);
    assert.equal(result.variables.unexpected, undefined);
    assert.equal(result.conditionResults.length, 1);
  },
);

test(
  "scope selection is explicit, hidden names stay hidden, and nested condition error stops the entire tree",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    for (const scope of ["globals", "environment", "runtime"]) {
      const values = {
        globals: { x: 1 },
        environment: { x: 2 },
        runtime: { x: 3 },
      };
      const plan = snapshotPlan({
        steps: [
          conditional(
            "if",
            variable("x", scope),
            "eq",
            literal(values[scope].x),
            [leaf("child", f.url + "/" + scope)],
          ),
        ],
      });
      const result = await runPlan(plan, {}, executeRequest, {
        variableScopes: values,
      });
      assert.equal(result.status, "passed");
      assert.equal(result.conditionResults[0].matched, true);
      const hidden = await runPlan(plan, {}, executeRequest, {
        variableScopes: { ...values, hidden: ["x"] },
      });
      assert.equal(hidden.stopReason, "condition-error");
      assert.equal(hidden.results.length, 0);
    }
    const plan = snapshotPlan({
      steps: [
        leaf("before", f.url + "/before"),
        conditional("outer", literal(true), "eq", literal(true), [
          conditional("missing", variable("missing"), "eq", literal(1), [
            leaf("inner", f.url + "/never"),
          ]),
          leaf("inner-tail", f.url + "/never"),
        ]),
        leaf("tail", f.url + "/never"),
      ],
    });
    const result = await runPlan(plan, {}, executeRequest);
    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "condition-error");
    assert.equal(result.results.length, 1);
    assert.equal(result.conditionResults.length, 2);
    assert.deepEqual(f.seen, [
      "/globals",
      "/environment",
      "/runtime",
      "/before",
    ]);
  },
);

test(
  "IF cancellation before dispatch reads no condition and creates no request or mutation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      controller = new AbortController();
    controller.abort();
    const plan = snapshotPlan({
      steps: [
        conditional("missing", variable("missing"), "eq", literal(1), [
          leaf("never", f.url + "/never"),
        ]),
      ],
    });
    const result = await runPlan(plan, {}, executeRequest, {
      signal: controller.signal,
    });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.conditionResults, []);
    assert.deepEqual(result.results, []);
    assert.deepEqual(f.seen, []);
  },
);
