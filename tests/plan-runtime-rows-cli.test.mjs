import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { materializeLivePlan } from "../src/live-plan-materialize.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";

const group = (steps, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const gate = (steps) => ({
  id: "gate",
  type: "if",
  condition: { left: { literal: false }, op: "eq", right: { literal: true } },
  steps,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-rows-cli-"));
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        items:
          req.url === "/empty"
            ? []
            : req.url.startsWith("/live/")
              ? [{ name: "replaced" }]
              : [{ name: "a" }, { name: "b" }],
      }),
    );
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    project = await store.create("Runtime rows CLI");
  const leaf = (id, url, extra = {}) => ({
    id,
    request: {
      name: id,
      method: "GET",
      url: `http://127.0.0.1:${peer.address().port}${url}`,
      ...extra,
    },
  });
  const producer = (url = "/produce") =>
    leaf("produce", url, {
      extract: [{ name: "items", source: "json", path: "$.items" }],
    });
  const save = async (id, steps) => {
    const p = await store.get(project.id);
    const plan = snapshotPlan(
      { id, name: id, steps },
      { allowRuntimeRows: true },
    );
    p.plans.push(plan);
    await store.save(p);
    return (await store.get(project.id)).plans.find((item) => item.id === id);
  };
  const invoke = (plan, connections, output) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/run-plan.mjs",
          "--project",
          project.id,
          "--plan",
          plan.id,
          ...(connections === undefined ? [] : ["--database-stdin"]),
          ...(output ? ["--output", output] : []),
        ],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: { ...process.env, LOCAL_API_DATA: root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.stdin.on("error", () => {});
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
      child.stdin.end(
        connections === undefined
          ? undefined
          : JSON.stringify({ databaseConnections: connections }),
      );
    });
  return { root, store, project, seen, leaf, producer, save, invoke };
}
const decode = (result, code = 0) => {
  assert.equal(result.signal, null);
  assert.equal(result.code, code, result.stderr + result.stdout);
  const run = JSON.parse(result.stdout);
  assert.equal(run.recordSaved, true);
  return run;
};

test("real CLI runtime rows use extracted runtime values, freeze live definitions and preserve task snapshots", async (t) => {
  const f = await fixture(t);
  const p = await f.store.get(f.project.id);
  p.requests.push({
    ...f.leaf("source", "/live/{{name}}/{{index}}/{{count}}").request,
    id: "source",
    beforeScript: "throw Error('source tasks must not replace plan tasks')",
  });
  await f.store.save(p);
  const body = {
    ...f.leaf("body", "/stale", {
      extract: [{ name: "items", source: "json", path: "$.items" }],
      beforeScript:
        "pm.environment.set('name',pm.iterationData.get('name'));pm.environment.set('index',pm.info.iteration);pm.environment.set('count',pm.info.iterationCount);",
    }),
    liveRequestId: "source",
  };
  const plan = await f.save("live-runtime", [
    f.producer(),
    group([body]),
    f.leaf("tail", "/tail/{{outer}}", {
      beforeScript:
        "pm.environment.set('outer',pm.iterationData.get('name') === undefined);",
    }),
  ]);
  const output = path.join(f.root, "evidence.json");
  const run = decode(await f.invoke(plan, undefined, output));
  assert.equal(run.status, "passed");
  assert.deepEqual(f.seen, [
    "/produce",
    "/live/a/0/2",
    "/live/b/1/2",
    "/tail/true",
  ]);
  assert.deepEqual(run.variables.items, [{ name: "replaced" }]);
  assert.deepEqual(run.liveBindings, [{ stepId: "body", requestId: "source" }]);
  assert.deepEqual(run.snapshot.steps[1].rowsFrom, {
    scope: "runtime",
    name: "items",
  });
  assert.equal(run.snapshot.steps[1].steps[0].liveRequestId, undefined);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), run);
  const stored = await f.store.get(f.project.id);
  assert.deepEqual(stored.plans, [plan]);
  assert.deepEqual(stored.runs[0].results, run.results);
});

test("runtime rows CLI preflights potential ordinary and native database declarations even for empty rows and false IF", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, "owned.db");
  new DatabaseSync(filename).close();
  const config = { type: "sqlite", filename };
  for (const kind of [
    "before",
    "after",
    "native-before",
    "native-after",
    "false-if",
  ]) {
    const body = f.leaf("database", "/never");
    if (kind.startsWith("native")) body.request.inheritSharedScripts = false;
    if (kind.startsWith("native"))
      body.request.nativeTasks = {
        version: 1,
        before: [],
        after: [],
        [kind.slice(7)]: [
          {
            type: "database",
            enabled: 1,
            data: {
              connectionId: "fixture",
              query: "SELECT * FROM must_not_exist",
              isConsoleOutput: -1,
              variables: [],
            },
          },
        ],
      };
    else
      body.request[kind === "after" ? "after" : "before"] = [
        {
          type: "database",
          connectionId: "fixture",
          sql: "SELECT * FROM must_not_exist",
          parameters: [],
          name: "dbRows",
        },
      ];
    const plan = await f.save(kind, [
      f.producer(kind === "false-if" ? "/produce" : "/empty"),
      group(kind === "false-if" ? [gate([body])] : [body]),
      f.leaf("tail", "/tail"),
    ]);
    const before = await f.store.get(f.project.id),
      seen = f.seen.length;
    for (const connections of [undefined, {}, { foreign: config }]) {
      const rejected = await f.invoke(plan, connections);
      assert.equal(rejected.code, 2, rejected.stderr);
      assert.equal(rejected.stdout, "");
      assert.match(rejected.stderr, /数据库|授权/);
      assert.equal(f.seen.length, seen);
      assert.deepEqual(await f.store.get(f.project.id), before);
    }
    const run = decode(await f.invoke(plan, { fixture: config }));
    assert.equal(run.status, "passed");
    if (kind === "false-if")
      assert.deepEqual(
        run.conditionResults.map((result) => result.matched),
        [false, false],
      );
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      ["produce", "tail"],
    );
    assert.equal(
      JSON.stringify(await f.store.get(f.project.id)).includes(filename),
      false,
    );
  }
});

test("runtime rows CLI disabled ancestor excludes grants and runtime source never falls back to environment", async (t) => {
  const f = await fixture(t);
  const body = f.leaf("db", "/never", {
    before: [
      {
        type: "database",
        connectionId: "fixture",
        sql: "SELECT 1",
        name: "dbRows",
      },
    ],
  });
  const disabled = await f.save("disabled", [
    group([body], { enabled: false }),
    f.leaf("tail", "/tail"),
  ]);
  assert.equal(decode(await f.invoke(disabled)).status, "passed");
  const p = await f.store.get(f.project.id);
  p.environments[0].variables.items = [{ name: "environment" }];
  await f.store.save(p);
  const missing = await f.save("missing", [
    group([f.leaf("body", "/never")]),
    f.leaf("later", "/never"),
  ]);
  const run = decode(await f.invoke(missing), 1);
  assert.equal(run.stopReason, "runtime-rows-error");
  assert.deepEqual(run.results, []);
  assert.deepEqual(f.seen, ["/tail"]);
});

test("live materialization and CLI grants retain default closed admission", () => {
  const plan = snapshotPlan(
    {
      steps: [
        group([
          {
            id: "body",
            liveRequestId: "api",
            request: { url: "http://example.test/old" },
          },
        ]),
      ],
    },
    { allowRuntimeRows: true },
  );
  const project = {
    requests: [{ id: "api", url: "http://example.test/new" }],
    settings: {},
    environments: [],
  };
  assert.throws(() => materializeLivePlan(project, plan), /尚未启用/);
  const frozen = materializeLivePlan(project, plan, { allowRuntimeRows: true });
  assert.equal(
    frozen.plan.steps[0].steps[0].request.url,
    "http://example.test/new",
  );
  assert.throws(
    () => prepareCLIDatabaseGrants("p", frozen.plan, {}),
    /尚未启用/,
  );
  const grants = prepareCLIDatabaseGrants("p", frozen.plan, {}, [], {
    allowRuntimeRows: true,
  });
  grants.close();
});

test("runtime rows CLI resolves every live reference before earlier HTTP even when its IF is false", async (t) => {
  const f = await fixture(t);
  const live = {
    ...f.leaf("missing", "/stale-must-not-run"),
    liveRequestId: "deleted-api",
  };
  const plan = await f.save("missing-live", [
    f.producer("/empty"),
    group([gate([live])]),
  ]);
  const before = await f.store.get(f.project.id);
  const output = path.join(f.root, "must-not-write.json");
  const result = await f.invoke(plan, undefined, output);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /实时计划引用/);
  assert.deepEqual(f.seen, []);
  assert.deepEqual(await f.store.get(f.project.id), before);
});

test("runtime rows CLI validates the entire source before first child and never executes empty-row custom scripts", async (t) => {
  const f = await fixture(t);
  const invalid = await f.save("over-limit", [
    f.producer(),
    group([f.leaf("body", "/never")], { maxRows: 1 }),
    f.leaf("tail", "/never"),
  ]);
  const failed = decode(await f.invoke(invalid), 1);
  assert.equal(failed.stopReason, "runtime-rows-error");
  assert.deepEqual(f.seen, ["/produce"]);
  const empty = await f.save("script-empty", [
    f.producer("/empty"),
    group([
      f.leaf("script", "/never", {
        beforeScript:
          "throw Error('custom script must not execute or become static grant requirements');",
      }),
    ]),
    f.leaf("tail", "/tail"),
  ]);
  const run = decode(await f.invoke(empty));
  assert.equal(run.status, "passed");
  assert.deepEqual(f.seen, ["/produce", "/empty", "/tail"]);
});

test("CLI database preflight checks aliases, cancellation and closure without opening database files", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "runtime-rows-cli-preflight-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  // A nonexistent file is intentional: authorization inspection must not query,
  // connect, or open a database merely to admit a potential declaration.
  const filename = path.join(root, "must-not-open.db");
  const plan = snapshotPlan(
    {
      steps: [
        group([
          {
            id: "body",
            request: {
              url: "http://example.test",
              before: [
                {
                  type: "database",
                  connectionId: "fixture",
                  sql: "SELECT 1",
                  name: "dbRows",
                },
                {
                  type: "database",
                  connectionId: "second",
                  sql: "SELECT 2",
                  name: "secondRows",
                },
              ],
            },
          },
        ]),
      ],
    },
    { allowRuntimeRows: true },
  );
  const grants = prepareCLIDatabaseGrants(
    "p",
    plan,
    {
      fixture: { type: "sqlite", filename },
      second: { type: "sqlite", filename },
    },
    [],
    { allowRuntimeRows: true },
  );
  t.after(() => grants.close());
  await grants.preflight(["fixture", "second"]);
  await assert.rejects(readFile(filename), { code: "ENOENT" });
  await assert.rejects(grants.preflight(["foreign"]), /授权/);
  await assert.rejects(
    grants.preflight(["fixture"], AbortSignal.abort()),
    /取消|abort/i,
  );
  const pending = grants.preflight(["fixture", "second"]);
  grants.close();
  await assert.rejects(pending, /撤销|关闭|失效/);
  await assert.rejects(grants.preflight(["fixture"]), /关闭/);
  await assert.rejects(grants.preflight([]), /关闭/);
});

test("real CLI database-produced runtime rows execute with invocation-only readonly grants", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, "owned-rows.db");
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE records(name TEXT); INSERT INTO records VALUES ('sql-a'), ('sql-b')",
  );
  db.close();
  const plan = await f.save("db-rows", [
    f.leaf("produce", "/db-produce", {
      before: [
        {
          type: "database",
          connectionId: "fixture",
          sql: "SELECT name FROM records ORDER BY name",
          parameters: [],
          name: "items",
          path: "$.rows",
        },
      ],
    }),
    group([
      f.leaf("body", "/db/{{name}}", {
        beforeScript:
          "pm.environment.set('name',pm.iterationData.get('name'));",
      }),
    ]),
  ]);
  const run = decode(
    await f.invoke(plan, { fixture: { type: "sqlite", filename } }),
  );
  assert.equal(run.status, "passed");
  assert.deepEqual(f.seen, ["/db-produce", "/db/sql-a", "/db/sql-b"]);
  assert.deepEqual(run.variables.items, [{ name: "sql-a" }, { name: "sql-b" }]);
  assert.equal(
    JSON.stringify(await f.store.get(f.project.id)).includes(filename),
    false,
  );
});

const deepLegacySchema = () => {
  let schema = { type: "string" };
  for (let i = 0; i < 34; i++) schema = { not: schema };
  return schema;
};

test("runtime-row opt-in preserves deep legacy linear materialization and CLI grant validation", async () => {
  const request = {
    url: "http://example.test/legacy",
    schema: deepLegacySchema(),
  };
  const definition = snapshotPlan({
    steps: [{ id: "leaf", request, liveRequestId: "api" }],
  });
  const project = {
    requests: [{ ...request, id: "api" }],
    settings: {},
    environments: [],
  };
  const frozen = materializeLivePlan(project, definition, {
    allowRuntimeRows: true,
  });
  assert.deepEqual(frozen.plan.steps[0].request.schema, request.schema);
  const grants = prepareCLIDatabaseGrants("p", frozen.plan, {}, [], {
    allowRuntimeRows: true,
  });
  await grants.preflight([]);
  grants.close();
  // The legacy exception must not change the strict control-graph boundary.
  assert.throws(
    () =>
      materializeLivePlan(
        project,
        { steps: [group(definition.steps)] },
        { allowRuntimeRows: true },
      ),
    /超限/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        { steps: [group(frozen.plan.steps)] },
        {},
        [],
        { allowRuntimeRows: true },
      ),
    /超限/,
  );
});

test("real CLI keeps deep legacy linear schemas executable with and without live freezing and database stdin", async (t) => {
  const f = await fixture(t);
  const p = await f.store.get(f.project.id);
  const source = {
    ...f.leaf("source", "/deep-live", { schema: deepLegacySchema() }).request,
    id: "api",
  };
  p.requests.push(source);
  for (const live of [false, true]) {
    p.plans.push(
      snapshotPlan({
        id: live ? "deep-live" : "deep-frozen",
        steps: [
          {
            ...f.leaf("body", "/deep-frozen", { schema: deepLegacySchema() }),
            ...(live ? { liveRequestId: "api" } : {}),
          },
        ],
      }),
    );
  }
  await f.store.save(p);
  for (const plan of p.plans)
    for (const connections of [undefined, {}]) {
      const run = decode(await f.invoke(plan, connections));
      assert.equal(run.status, "passed");
      assert.deepEqual(run.snapshot.steps[0].request.schema, source.schema);
    }
  assert.deepEqual(f.seen, [
    "/deep-frozen",
    "/deep-frozen",
    "/deep-live",
    "/deep-live",
  ]);
});

test("real CLI rejects missing database result names before any HTTP, scope commit or evidence even for empty rows and false IF", async (t) => {
  const f = await fixture(t);
  const filename = path.join(
    f.root,
    "must-not-open-for-invalid-declaration.db",
  );
  for (const mode of ["empty", "false-if"]) {
    for (const phase of ["before", "after"]) {
      const child = f.leaf("invalid-database", "/must-not-run", {
        [phase]: [
          {
            type: "database",
            connectionId: "fixture",
            sql: "SELECT 1",
            parameters: [],
          },
        ],
      });
      const producer = f.producer(mode === "empty" ? "/empty" : "/produce");
      producer.request.beforeScript =
        "pm.environment.set('mustNotCommit','executed');";
      const plan = await f.save(`invalid-name-${mode}-${phase}`, [
        producer,
        group(mode === "false-if" ? [gate([child])] : [child]),
        f.leaf("tail", "/must-not-run"),
      ]);
      const before = await f.store.get(f.project.id);
      const output = path.join(f.root, `must-not-write-${mode}-${phase}.json`);
      const result = await f.invoke(
        plan,
        { fixture: { type: "sqlite", filename } },
        output,
      );
      assert.equal(result.signal, null);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /数据库结果变量名无效/);
      assert.deepEqual(f.seen, []);
      assert.deepEqual(await f.store.get(f.project.id), before);
      await assert.rejects(readFile(output), { code: "ENOENT" });
      await assert.rejects(readFile(filename), { code: "ENOENT" });
    }
  }
});
