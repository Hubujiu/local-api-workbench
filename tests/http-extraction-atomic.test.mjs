import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPlan, snapshotPlan, restoreProject } from "../src/core.mjs";
import { executeRequest, Store } from "../src/runtime.mjs";
import { projectScopes, persistScopeChanges } from "../src/variable-scopes.mjs";

async function fixture(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers["x-token"] });
    res.writeHead(req.url === "/failure" ? 500 : 200, {
      "content-type": "application/json",
      "x-token": "header-value",
      "set-cookie": "session=cookie-value; Path=/",
    });
    res.end(
      JSON.stringify({
        token: "fresh",
        last: "last-value",
        zero: 0,
        flag: false,
        empty: null,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}
const row = (name, scope = "runtime", path = "$.token", source = "json") => ({
  name,
  scope,
  path,
  source,
});
const request = (url, extract = [], extra = {}) => ({
  request: { url, method: "GET", extract, ...extra },
});

test("HTTP extraction list rejects missing later values, names and scopes without publishing runtime, hidden or receipts", async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    row("required", "runtime", "$.missing"),
    row("bad", "unknown"),
    row("__proto__"),
    row(" "),
  ]) {
    for (const hidden of [false, true]) {
      const plan = snapshotPlan({
        steps: [
          request(f.url, [row("token"), invalid]),
          request(
            f.url + "/next",
            [],
            hidden
              ? {}
              : {
                  headers: [
                    { key: "x-token", value: "{{token}}", enabled: true },
                  ],
                },
          ),
        ],
      });
      const result = await runPlan(plan, {}, executeRequest, {
        variableScopes: {
          runtime: { token: "old" },
          hidden: hidden ? ["token"] : [],
        },
      });
      assert.equal(result.status, "failed");
      assert.equal(result.results.length, 2);
      assert.equal(result.results[1].status, "passed");
      assert.equal(result.results[0].response.status, 200);
      assert.equal(JSON.parse(result.results[0].response.body).token, "fresh");
      if (!hidden) assert.equal(f.seen.at(-1).token, "old");
      assert.deepEqual(result.results[0].extracted, {});
      assert.equal(Object.hasOwn(result.variables, "token"), !hidden);
      if (!hidden) {
        assert.equal(result.variables.token, "old");
        assert.equal(f.seen.at(-1).token, "old");
      }
    }
  }
  const reverse = await runPlan(
    snapshotPlan({
      steps: [
        request(f.url, [row("missing", "runtime", "$.missing"), row("token")]),
        request(f.url + "/control", [], {
          headers: [{ key: "x-token", value: "{{token}}" }],
        }),
      ],
    }),
    { token: "old" },
    executeRequest,
  );
  assert.deepEqual(reverse.results[0].extracted, {});
  assert.equal(f.seen.at(-1).token, "old");
});

test("HTTP whole extraction list remains visible before post operations and scripts even for status or assertion failures", async (t) => {
  const f = await fixture(t);
  for (const mode of ["success", "status", "assertion"]) {
    const commits = [];
    const plan = snapshotPlan({
      steps: [
        request(
          f.url + (mode === "status" ? "/failure" : "/ok"),
          [
            row("token"),
            row("token", "runtime", "$.last"),
            row("localOnly", "local", "x-token", "header"),
            row("env", "environment", "session", "cookie"),
            row("global", "global", "", "text"),
            row("elapsed", "runtime", "", "duration"),
            row("zero", "runtime", "$.zero"),
            row("flag", "runtime", "$.flag"),
            row("empty", "runtime", "$.empty"),
          ],
          {
            assertions:
              mode === "assertion"
                ? [{ target: "status", op: "eq", value: 201 }]
                : [],
            after: [
              { type: "set", name: "afterValue", value: "operation-value" },
            ],
            afterScript:
              'pm.test("local extraction",()=>pm.expect(pm.variables.get("localOnly")).to.equal("header-value")); pm.test("environment extraction",()=>pm.expect(pm.environment.get("env")).to.equal("cookie-value")); pm.test("post operation",()=>pm.expect(pm.variables.get("afterValue")).to.equal("operation-value")); pm.test("runtime extraction",()=>pm.expect(pm.variables.get("token")).to.equal("last-value"));',
          },
        ),
        request(f.url + "/next", [], {
          headers: [{ key: "x-token", value: "{{token}}" }],
        }),
      ],
    });
    const result = await runPlan(plan, {}, executeRequest, {
      variableScopes: { runtime: { token: "old" }, hidden: ["token"] },
      onScopeChanges: async (changes) => commits.push(changes),
    });
    assert.equal(
      result.status,
      mode === "success" ? "passed" : "failed",
      JSON.stringify(result),
    );
    assert.equal(result.results[1].status, "passed");
    assert.equal(f.seen.at(-1).token, "last-value");
    assert.equal(result.results[0].extracted.token, "last-value");
    assert.equal(result.variables.afterValue, "operation-value");
    assert.equal(result.variables.zero, 0);
    assert.equal(result.variables.flag, false);
    assert.equal(result.variables.empty, null);
    assert.equal(typeof result.results[0].extracted.elapsed, "number");
    assert.equal(
      result.results[0].extracted.global,
      result.results[0].response.body,
    );
    assert.equal(Object.hasOwn(result.variables, "localOnly"), false);
    assert.equal(
      result.results[0].assertions
        .filter((a) => a.phase === "after")
        .every((a) => a.passed),
      true,
    );
    assert(commits.some((changes) => changes.length === 2));
  }
});

test("HTTP successful prior scopes survive failed extraction lists in frozen plans, disk history, backup and restart", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(path.join(tmpdir(), "http-extract-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("atomic"),
    other = await store.create("other");
  const otherBefore = await store.get(other.id),
    envId = p.environments[0].id;
  const definition = {
    steps: [
      request(f.url + "/prime", [
        row("runtime"),
        row("env", "environment"),
        row("global", "global"),
      ]),
      request(f.url + "/broken", [
        row("runtime", "runtime", "$.last"),
        row("env", "environment", "$.last"),
        row("global", "global", "$.last"),
        row("local", "local", "$.last"),
        row("missing", "runtime", "$.missing"),
      ]),
      request(f.url + "/{{runtime}}/{{env}}/{{global}}"),
    ],
  };
  const plan = snapshotPlan(definition);
  p.plans.push(plan);
  await store.save(p);
  definition.steps[0].request.url = "http://127.0.0.1:1/not-frozen";
  const execute = async (project) => {
    const result = await runPlan(project.plans[0], {}, executeRequest, {
      variableScopes: projectScopes(project, envId),
      onScopeChanges: async (changes) =>
        (await persistScopeChanges(store, project.id, envId, changes)).scopes,
    });
    assert.deepEqual(
      result.results.map((r) => r.status),
      ["passed", "failed", "passed"],
    );
    assert.deepEqual(result.results[1].extracted, {});
    assert.equal(f.seen.at(-1).url, "/fresh/fresh/fresh");
    assert.deepEqual(result.snapshot, JSON.parse(JSON.stringify(plan)));
    await store.append(project.id, "runs", result);
    const disk = await new Store(root).get(project.id);
    assert.equal(disk.environments[0].variables.env, "fresh");
    assert.equal(disk.globalVariables.global, "fresh");
    assert.deepEqual(
      disk.runs.find((r) => r.id === result.id).results,
      JSON.parse(JSON.stringify(result.results)),
    );
    return disk;
  };
  const backup = await execute(await store.get(p.id));
  const restored = restoreProject(backup);
  await store.save(restored);
  assert.deepEqual(restored.plans, backup.plans);
  assert.deepEqual(restored.runs, backup.runs);
  await execute(await new Store(root).get(restored.id));
  assert.equal((await store.get(p.id)).runs.length, 1);
  assert.equal((await store.get(restored.id)).runs.length, 2);
  assert.deepEqual(await store.get(other.id), otherBefore);
});

test("HTTP extraction atomicity does not extend to later post-operation failures or change scope persistence callbacks", async (t) => {
  const f = await fixture(t);
  for (const failure of ["post-operation", "scope-save"]) {
    const result = await runPlan(
      snapshotPlan({
        steps: [
          request(
            f.url,
            [row("token"), row("env", "environment")],
            failure === "post-operation"
              ? { after: [{ type: "set", name: "__proto__", value: "reject" }] }
              : {},
          ),
          request(f.url + "/next", [], {
            headers: [{ key: "x-token", value: "{{token}}" }],
          }),
        ],
      }),
      {},
      executeRequest,
      {
        variableScopes: {
          environment: { env: "old-env" },
          runtime: { token: "old" },
        },
        onScopeChanges: async () => {
          if (failure === "scope-save") throw Error("fixture storage failure");
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].response.status, 200);
    assert.deepEqual(result.results[0].extracted, {
      token: "fresh",
      env: "fresh",
    });
    assert.equal(
      f.seen.at(-1).token,
      "fresh",
      "completed list retains existing runtime behavior after a later independent failure",
    );
    assert.equal(
      result.variables.env,
      "old-env",
      "existing environment rollback is unchanged",
    );
  }
});
