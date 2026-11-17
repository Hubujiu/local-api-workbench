import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/runtime.mjs";
import { snapshotPlan } from "../src/core.mjs";
import { writeProject } from "../src/project-files.mjs";

const literal = (value) => ({ literal: value });
const gate = (id, matched, steps) => ({
  id,
  type: "if",
  condition: { left: literal(matched), op: "eq", right: literal(true) },
  steps,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plan-if-cli-"));
  const seen = [],
    children = new Set();
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"token":"cli-response-token"}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(
      [...children].map(async (child) => {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }),
    );
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    project = await store.create("CLI IF"),
    other = await store.create("CLI unrelated");
  const otherBefore = await store.get(other.id);
  const leaf = (id, target, extra = {}) => ({
    id,
    request: {
      name: id,
      method: "GET",
      url: `http://127.0.0.1:${peer.address().port}${target}`,
      ...extra,
    },
  });
  const save = async (id, steps) => {
    const p = await store.get(project.id);
    const plan = snapshotPlan({
      id,
      name: id,
      environmentId: p.environments[0].id,
      steps,
    });
    p.plans.push(plan);
    await store.save(p);
    return (await store.get(project.id)).plans.find((item) => item.id === id);
  };
  const invoke = (planId, { databaseConnections, output } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/run-plan.mjs",
          "--project",
          project.id,
          "--plan",
          planId,
          ...(databaseConnections === undefined ? [] : ["--database-stdin"]),
          ...(output ? ["--output", output] : []),
        ],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: { ...process.env, LOCAL_API_DATA: root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.add(child);
      let stdout = "",
        stderr = "",
        failure;
      const timer = setTimeout(() => {
        failure = Error("owned IF CLI fixture exceeded 8 seconds");
        child.kill("SIGKILL");
      }, 8000);
      const read = (kind, chunk) => {
        if (kind === "out") stdout += chunk;
        else stderr += chunk;
        if (stdout.length + stderr.length > 2 * 1024 * 1024) {
          failure = Error("owned IF CLI fixture exceeded output budget");
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (chunk) => read("out", chunk));
      child.stderr.on("data", (chunk) => read("err", chunk));
      child.stdin.on("error", () => {});
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        if (failure) reject(failure);
        else resolve({ code, signal, stdout, stderr });
      });
      child.stdin.end(
        databaseConnections === undefined
          ? undefined
          : JSON.stringify({ databaseConnections }),
      );
    });
  const database = () => {
    const filename = path.join(root, "owned-sqlite.db");
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('sqlite-if-token')",
    );
    db.close();
    return { type: "sqlite", filename };
  };
  const dbLeaf = (id, query = "SELECT value FROM records") =>
    leaf(id, "/database?value={{dbValue}}", {
      before: [
        {
          type: "database",
          connectionId: "fixture",
          sql: query,
          parameters: [],
          name: "dbValue",
          path: "$.rows[0].value",
        },
      ],
    });
  return {
    root,
    store,
    project,
    otherBefore,
    seen,
    leaf,
    save,
    invoke,
    database,
    dbLeaf,
  };
}
function decode(result, code) {
  assert.equal(result.code, code, result.stderr + result.stdout);
  assert.equal(result.signal, null);
  const run = JSON.parse(result.stdout);
  assert.equal(run.recordSaved, true, JSON.stringify(run.persistenceError));
  assert.equal(run.recordId, run.id);
  return run;
}

test(
  "real CLI false-only, true extraction and condition failure have truthful exit codes and durable decision history",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const falsePlan = await f.save("false-only", [
      gate("false-gate", false, [f.leaf("never", "/never")]),
    ]);
    const truePlan = await f.save("true-extraction", [
      gate("true-gate", true, [
        f.leaf("child", "/child", {
          extract: [{ name: "token", source: "json", path: "$.token" }],
        }),
      ]),
      f.leaf("tail", "/tail?token={{token}}"),
    ]);
    const missing = gate("missing-gate", true, [f.leaf("never", "/never")]);
    missing.condition.left = { scope: "runtime", name: "missing" };
    const failedPlan = await f.save("condition-failure", [
      missing,
      f.leaf("later", "/later"),
    ]);
    const falseResult = await f.invoke(falsePlan.id);
    const falseRun = decode(falseResult, 0);
    assert.equal(falseRun.status, "passed");
    assert.deepEqual(falseRun.results, []);
    assert.equal(falseRun.conditionResults[0].matched, false);
    assert.equal(/^PASSED /m.test(falseResult.stderr), false);
    assert.deepEqual(f.seen, []);
    const output = path.join(f.root, "owned-if-evidence.json");
    const trueRun = decode(await f.invoke(truePlan.id, { output }), 0);
    assert.equal(trueRun.status, "passed");
    assert.equal(trueRun.conditionResults[0].matched, true);
    assert.deepEqual(
      trueRun.results.map((item) => item.stepId),
      ["child", "tail"],
    );
    assert.equal(trueRun.variables.token, "cli-response-token");
    assert.deepEqual(f.seen, ["/child", "/tail?token=cli-response-token"]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), trueRun);
    const failedRun = decode(await f.invoke(failedPlan.id), 1);
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.stopReason, "condition-error");
    assert.deepEqual(failedRun.results, []);
    assert.equal(failedRun.conditionResults[0].status, "failed");
    assert.equal(failedRun.conditionResults[0].code, "PLAN_CONDITION_INVALID");
    assert.equal(
      Object.hasOwn(failedRun.conditionResults[0], "matched"),
      false,
    );
    assert.equal(f.seen.length, 2);
    const reopened = await new Store(f.root).get(f.project.id);
    assert.equal(reopened.runs.length, 3);
    for (const run of [falseRun, trueRun, failedRun]) {
      const record = reopened.runs.find((item) => item.id === run.id);
      assert.equal(record.source, "cli");
      assert.equal(record.status, run.status);
      assert.deepEqual(record.conditionResults, run.conditionResults);
      assert.deepEqual(record.results, run.results);
      assert.deepEqual(record.snapshot, run.snapshot);
    }
    assert.deepEqual(reopened.plans, [falsePlan, truePlan, failedPlan]);
    assert.deepEqual(await f.store.get(f.otherBefore.id), f.otherBefore);
  },
);

test(
  "false enabled IF database leaves still require exact stdin grants before earlier HTTP and never execute skipped SQL",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      config = f.database();
    const plan = await f.save("false-db-potential", [
      f.leaf("earlier", "/earlier"),
      gate("gate", false, [
        f.dbLeaf("database", "SELECT value FROM must_not_exist"),
      ]),
      f.leaf("tail", "/tail"),
    ]);
    const before = await f.store.get(f.project.id);
    for (const mapping of [{}, { foreign: config }]) {
      const rejected = await f.invoke(plan.id, {
        databaseConnections: mapping,
      });
      assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
      assert.equal(rejected.stdout, "");
      assert.match(rejected.stderr, /CLI.*数据库|授权/);
      assert.deepEqual(f.seen, []);
      assert.deepEqual(await f.store.get(f.project.id), before);
    }
    const run = decode(
      await f.invoke(plan.id, { databaseConnections: { fixture: config } }),
      0,
    );
    assert.equal(run.status, "passed");
    assert.equal(run.conditionResults[0].matched, false);
    assert.deepEqual(
      run.results.map((item) => item.stepId),
      ["earlier", "tail"],
    );
    assert.equal(Object.hasOwn(run.variables, "dbValue"), false);
    assert.deepEqual(f.seen, ["/earlier", "/tail"]);
    const disk = await new Store(f.root).get(f.project.id);
    assert.equal(JSON.stringify(disk).includes(config.filename), false);
    assert.equal(JSON.stringify(disk).includes('"databaseConnections"'), false);
    assert.deepEqual(disk.runs[0].conditionResults, run.conditionResults);
    assert.deepEqual(await f.store.get(f.otherBefore.id), f.otherBefore);
  },
);

test(
  "omitting the database flag still enforces the canonical IF declaration-level grant contract",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await f.save("false-db-without-flag", [
      f.leaf("earlier", "/must-not-run-before-grant"),
      gate("gate", false, [f.dbLeaf("database")]),
      f.leaf("tail", "/must-not-run-after-grant"),
    ]);
    const before = await f.store.get(f.project.id);
    const rejected = await f.invoke(plan.id);
    assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /数据库|授权/);
    assert.deepEqual(f.seen, []);
    assert.deepEqual(await f.store.get(f.project.id), before);
  },
);

test(
  "true IF CLI uses invocation-only readonly SQLite grants and preserves database-derived HTTP evidence",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      config = f.database();
    const plan = await f.save("true-db", [
      gate("gate", true, [f.dbLeaf("database")]),
    ]);
    const run = decode(
      await f.invoke(plan.id, { databaseConnections: { fixture: config } }),
      0,
    );
    assert.equal(run.status, "passed");
    assert.equal(run.conditionResults[0].matched, true);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "passed");
    assert.equal(run.variables.dbValue, "sqlite-if-token");
    assert.deepEqual(f.seen, ["/database?value=sqlite-if-token"]);
    const persisted = await new Store(f.root).get(f.project.id);
    assert.deepEqual(persisted.runs[0].conditionResults, run.conditionResults);
    assert.deepEqual(persisted.runs[0].results, run.results);
    assert.equal(JSON.stringify(persisted).includes(config.filename), false);
    assert.equal(
      JSON.stringify(persisted).includes('"databaseConnections"'),
      false,
    );
    const denied = await f.invoke(plan.id, { databaseConnections: {} });
    assert.equal(denied.code, 2, denied.stderr + denied.stdout);
    assert.equal(denied.stdout, "");
    assert.equal(f.seen.length, 1);
    assert.deepEqual(await f.store.get(f.project.id), persisted);
    assert.deepEqual(await f.store.get(f.otherBefore.id), f.otherBefore);
  },
);

test(
  "disabled control ancestors remove database grant requirements without bypassing enabled sibling execution",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      config = f.database();
    const plan = await f.save("disabled-db-ancestor", [
      {
        id: "disabled-repeat",
        type: "repeat",
        enabled: false,
        count: 2,
        steps: [
          gate("inner-if", true, [
            f.dbLeaf("database", "SELECT value FROM must_not_exist"),
          ]),
        ],
      },
      {
        ...gate("disabled-if", true, [
          f.dbLeaf("other-database", "SELECT value FROM must_not_exist"),
        ]),
        enabled: false,
      },
      f.leaf("tail", "/enabled-tail"),
    ]);
    for (const options of [{}, { databaseConnections: {} }]) {
      const run = decode(await f.invoke(plan.id, options), 0);
      assert.equal(run.status, "passed");
      assert.deepEqual(run.conditionResults, []);
      assert.deepEqual(
        run.results.map((item) => item.stepId),
        ["tail"],
      );
      assert.equal(Object.hasOwn(run.variables, "dbValue"), false);
    }
    assert.deepEqual(f.seen, ["/enabled-tail", "/enabled-tail"]);
    const before = await f.store.get(f.project.id);
    const excess = await f.invoke(plan.id, {
      databaseConnections: { fixture: config },
    });
    assert.equal(excess.code, 2, excess.stderr + excess.stdout);
    assert.equal(excess.stdout, "");
    assert.deepEqual(await f.store.get(f.project.id), before);
    assert.equal(f.seen.length, 2);
    assert.deepEqual(await f.store.get(f.otherBefore.id), f.otherBefore);
  },
);

test(
  "IF declaration-level preflight identifies ordinary after operations and native before/after database tasks without executing them",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const native = {
      type: "database",
      enabled: 1,
      data: {
        connectionId: "fixture",
        query: "SELECT value FROM records",
        isConsoleOutput: -1,
        variables: [],
      },
    };
    for (const kind of ["ordinary-after", "native-before", "native-after"]) {
      const child = f.leaf("database", "/must-not-run-database");
      if (kind === "ordinary-after")
        child.request.after = f.dbLeaf("unused").request.before;
      else {
        child.request.inheritSharedScripts = false;
        child.request.nativeTasks = {
          version: 1,
          before: kind === "native-before" ? [native] : [],
          after: kind === "native-after" ? [native] : [],
        };
      }
      const plan = await f.save("declared-" + kind, [
        f.leaf("earlier", "/must-not-run-before-native-preflight"),
        gate("gate", false, [child]),
      ]);
      const before = await f.store.get(f.project.id);
      const rejected = await f.invoke(plan.id);
      assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
      assert.equal(rejected.stdout, "");
      assert.match(rejected.stderr, /CLI.*数据库|授权/);
      assert.deepEqual(f.seen, []);
      assert.deepEqual(await f.store.get(f.project.id), before);
    }
  },
);

test(
  "ordinary linear and repeat CLI plans retain no-flag behavior for disabled database leaves without creating database calls",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const disabledLeaf = {
      ...f.dbLeaf("database", "SELECT value FROM must_not_exist"),
      enabled: false,
    };
    const linear = await f.save("legacy-linear-disabled", [
      disabledLeaf,
      f.leaf("tail", "/linear-tail"),
    ]);
    const repeated = await f.save("legacy-repeat-disabled", [
      {
        id: "disabled-group",
        type: "repeat",
        count: 2,
        enabled: false,
        steps: [f.dbLeaf("database", "SELECT value FROM must_not_exist")],
      },
      f.leaf("tail", "/repeat-tail"),
    ]);
    for (const plan of [linear, repeated]) {
      const run = decode(await f.invoke(plan.id), 0);
      assert.equal(run.status, "passed");
      assert.deepEqual(
        run.results.map((item) => item.stepId),
        ["tail"],
      );
      assert.equal(Object.hasOwn(run, "conditionResults"), false);
      assert.equal(Object.hasOwn(run.variables, "dbValue"), false);
    }
    assert.deepEqual(f.seen, ["/linear-tail", "/repeat-tail"]);
    const disk = await new Store(f.root).get(f.project.id);
    assert.equal(disk.runs.length, 2);
    assert.deepEqual(disk.plans, [linear, repeated]);
    assert.deepEqual(await f.store.get(f.otherBefore.id), f.otherBefore);
  },
);

test(
  "HTTP-only IF does not introduce an unrelated legacy catalogue preflight and retains existing evidence-save failure semantics",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const linear = await f.save("legacy-catalogue-linear", [
      f.leaf("http", "/legacy-linear"),
    ]);
    const conditional = await f.save("legacy-catalogue-if", [
      gate("gate", true, [f.leaf("http", "/legacy-if")]),
    ]);
    const legacy = await f.store.get(f.project.id);
    legacy.settings.apipostDatabases = [
      {
        id: "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20),
        name: "inert historical source",
        type: "unsupported-legacy-engine",
        sourceProjectId: "owned-old-project",
        sourceId: "owned-old-database",
      },
    ];
    // Deliberately reconstruct legacy disk data; current owner admission rejects
    // this catalogue, so both old and IF runs must retain an honest save failure.
    await writeProject(f.store.directory(f.project.id), legacy);
    const before = await f.store.get(f.project.id);
    for (const plan of [linear, conditional]) {
      const outcome = await f.invoke(plan.id);
      assert.equal(outcome.code, 2, outcome.stderr + outcome.stdout);
      const run = JSON.parse(outcome.stdout);
      assert.equal(run.status, "passed");
      assert.equal(run.results.length, 1);
      assert.equal(run.results[0].response.status, 200);
      assert.equal(run.recordSaved, false);
      assert.equal(run.persistenceOutcome.code, "RECORD_SAVE_FAILED");
      assert.equal(run.persistenceOutcome.retry_safe, false);
      assert.equal(outcome.stderr.includes("CLI 数据库来源"), false);
      if (plan.id === conditional.id)
        assert.equal(run.conditionResults[0].matched, true);
      else assert.equal(Object.hasOwn(run, "conditionResults"), false);
      assert.deepEqual(await f.store.get(f.project.id), before);
    }
    assert.deepEqual(f.seen, ["/legacy-linear", "/legacy-if"]);
    assert.deepEqual(await f.store.get(f.otherBefore.id), f.otherBefore);
  },
);
