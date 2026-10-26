// Combined acceptance: native pickVars/assert + MCP/CLI/database branches.
// Fictional loopback data only. SQLite tasks below are canonical, not a claim of
// native vendor SQLite import. Extracted values are execution evidence; transient
// database configurations and MCP bearer grants must not enter project evidence.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const script = (id, data) => ({
  type: "customScript",
  id,
  name: id,
  enabled: 1,
  data,
});
const row = (name, expression, type = "envVars") => ({
  name,
  expression,
  type,
});
const pick = (variables) => ({
  type: "pickVars",
  id: "pick-response",
  name: "Extract response",
  enabled: 1,
  data: { source: "responseJson", variables },
});
const nativeAssert = (id, responsePath, expected, type = "responseJson") => ({
  type: "assert",
  id,
  name: id,
  enabled: 1,
  data: {
    type,
    expression: {
      path: responsePath,
      compareType: "eq",
      compareValue: expected,
    },
  },
});
function nativeSource(base) {
  const source = modernApipostFixture();
  source.global.envs = [];
  source.global.servers = [];
  source.global.global_vars = {};
  source.global.global_param.post_tasks = [
    script("project", 'const order=["project"];'),
  ];
  source.apis[0].request.post_tasks = [
    script("folder", 'order.push("folder");'),
  ];
  const api = source.apis[1];
  api.url = base + "/login/{{tenant}}";
  api.request.header.parameter = [];
  api.request.query.parameter = [];
  api.request.post_tasks = [
    script(
      "before-pick",
      'order.push("api");const prefix="derived:";const view=pm.response.json();view.session.token+="-view";apt.response.setBody(view);',
    ),
    nativeAssert(
      "native-current-response",
      "$.session.token",
      "wire-entry-view",
    ),
    pick([
      row("token", "$.session.token"),
      row("localToken", "$.session.token", "tempVars"),
      row("zero", "$.zero"),
      row("no", "$.no"),
      row("nothing", "$.nothing", "globalVars"),
    ]),
    script(
      "after-pick",
      'pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("order",order.join(","));pm.test("local scope",()=>pm.expect(pm.variables.get("localToken")).to.equal(pm.environment.get("token")));',
    ),
  ];
  return source;
}
function followup(base) {
  return {
    id: "protected",
    name: "Authenticated followup",
    method: "GET",
    url: base + "/resource",
    auth: { type: "bearer", token: "{{token}}" },
    beforeScript:
      'pm.test("request-local isolation",()=>pm.expect(pm.variables.get("localToken")).to.equal(undefined));',
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pick-entrypoints-"));
  const data = path.join(root, "projects"),
    received = [],
    clients = [];
  const server = http.createServer((request, response) => {
    received.push({
      path: request.url,
      authorization: request.headers.authorization,
      db: request.headers["x-db-value"],
    });
    response.setHeader("content-type", "application/json");
    response.end(
      request.url.startsWith("/login/")
        ? JSON.stringify({
            session: { token: "wire-" + request.url.slice(7) },
            zero: 0,
            no: false,
            nothing: null,
          })
        : JSON.stringify({
            authorization: request.headers.authorization,
            db: request.headers["x-db-value"],
          }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root: data, port: 0 });
  const closeApp = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await closeApp();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    data,
    base,
    received,
    get app() {
      return app;
    },
    async restart() {
      await closeApp();
      app = await createApp({ root: data, port: 0 });
    },
    async connect(projectId) {
      const response = await fetch(app.url + "/api/mcp/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        body: JSON.stringify({
          enabled: true,
          projects: [projectId],
          write: true,
          execute: true,
          remember: false,
        }),
      });
      assert.equal(response.status, 200);
      const config = await response.json();
      assert.ok(config.token);
      const client = new Client({
        name: "native-pick-entrypoints",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
      return { client, grantToken: config.token };
    },
  };
}
async function importedProject(f) {
  const project = await f.app.store.create("Native response extraction");
  const source = nativeSource(f.base),
    original = structuredClone(source);
  importIntoProject(project, source);
  assert.deepEqual(source, original);
  project.environments[0].variables.tenant = "entry";
  project.plans = [
    snapshotPlan({
      id: "login-flow",
      name: "Login then Bearer",
      steps: [{ request: project.requests[0] }, { request: followup(f.base) }],
    }),
  ];
  const frozen = structuredClone(project.plans[0].steps[0].request.nativeTasks);
  // Mutating the editable request cannot change the independently frozen plan.
  project.requests[0].nativeTasks.after.find(
    (task) => task.type === "pickVars",
  ).data.variables[0].expression = "$.notInResponse";
  await f.app.store.save(project);
  return { project, frozen };
}
function assertPassedWire(f, start, token = "wire-entry-view") {
  assert.deepEqual(
    f.received.slice(start).map((entry) => entry.path),
    ["/login/entry", "/resource"],
  );
  assert.equal(f.received.at(-1).authorization, "Bearer " + token);
}
async function assertSaved(f, projectId, run, source, frozen) {
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(run.recordSaved, true);
  assert.equal(
    run.results[0].assertions.find(
      (item) => item.name === "native-current-response",
    )?.passed,
    true,
  );
  assert.deepEqual(
    run.results.map((item) => item.status),
    ["passed", "passed"],
  );
  assert.equal(
    JSON.parse(run.results[0].response.body).session.token,
    "wire-entry",
  );
  assert.equal(
    JSON.parse(run.results[0].scriptResponse.body).session.token,
    "wire-entry-view",
  );
  const saved = await new Store(f.data).get(projectId),
    env = saved.environments[0].variables;
  assert.equal(env.token, "wire-entry-view");
  assert.equal(env.derived, "derived:wire-entry-view");
  assert.equal(env.order, "project,folder,api");
  assert.equal(env.zero, 0);
  assert.equal(env.no, false);
  assert.equal(saved.globalVariables.nothing, null);
  assert.equal(Object.hasOwn(env, "localToken"), false);
  assert.equal(Object.hasOwn(saved.globalVariables, "localToken"), false);
  const evidence = saved.runs.find((item) => item.id === run.id);
  assert.ok(evidence);
  assert.equal(evidence.source, source);
  assert.equal(evidence.status, "passed");
  assert.deepEqual(evidence.snapshot.steps[0].request.nativeTasks, frozen);
  return saved;
}
async function addFailurePlan(f, projectId, sourcePlanId = "login-flow") {
  const saved = await new Store(f.data).get(projectId);
  saved.environments[0].variables.token = "STALE_MUST_NOT_SEND";
  const plan = structuredClone(
    saved.plans.find((item) => item.id === sourcePlanId),
  );
  plan.id = "failed-extraction";
  const after = plan.steps[0].request.nativeTasks.after;
  after.unshift(
    script(
      "pending-post",
      'pm.environment.set("postOnly","must-not-commit");pm.globals.set("postGlobal","must-not-commit");',
    ),
  );
  after
    .find((task) => task.type === "pickVars")
    .data.variables.push(row("absent", "$.missing"));
  saved.plans.push(plan);
  await f.app.store.save(saved);
  return plan;
}
async function assertFailedExtraction(f, projectId, run, start) {
  assert.equal(run.status, "failed");
  assert.equal(run.recordSaved, true);
  assert.equal(
    run.results.length,
    1,
    "enabled pickVars failure stops later requests even with a stale token available",
  );
  assert.match(run.results[0].error, /路径不存在/);
  assert.deepEqual(
    f.received.slice(start).map((entry) => entry.path),
    ["/login/entry"],
  );
  assert.equal(run.variables.token, "STALE_MUST_NOT_SEND");
  assert.equal(Object.hasOwn(run.variables, "postOnly"), false);
  const saved = await new Store(f.data).get(projectId);
  assert.equal(saved.environments[0].variables.token, "STALE_MUST_NOT_SEND");
  assert.equal(
    Object.hasOwn(saved.environments[0].variables, "postOnly"),
    false,
  );
  assert.equal(Object.hasOwn(saved.globalVariables, "postGlobal"), false);
  assert.equal(saved.runs.find((item) => item.id === run.id).results.length, 1);
}
async function mcpRun(client, projectId, planId, environmentId) {
  const response = await client.callTool({
    name: "localapi_execute_flow",
    arguments: { projectId, planId, environmentId },
  });
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}
function cli(f, project, planId, flag, envelope) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/run-plan.mjs",
        "--project",
        project.id,
        "--plan",
        planId,
        "--environment",
        project.environments[0].id,
        ...(flag ? [flag] : []),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, LOCAL_API_DATA: f.data },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    const timer = setTimeout(() => {
      failure = Error("pickVars CLI fixture exceeded 15s");
      child.kill();
    }, 15000);
    const append = (name, bytes) => {
      if (name === "stdout") stdout += bytes;
      else stderr += bytes;
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
        2 * 1024 * 1024
      ) {
        failure = Error("CLI fixture output exceeds 2MiB");
        child.kill();
      }
    };
    child.stdout.on("data", (bytes) => append("stdout", bytes));
    child.stderr.on("data", (bytes) => append("stderr", bytes));
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(
      envelope === undefined ? undefined : JSON.stringify(envelope),
    );
  });
}
function cliResult(output, code) {
  assert.equal(output.signal, null, output.stderr);
  assert.equal(output.code, code, output.stdout + output.stderr);
  return JSON.parse(output.stdout);
}

test(
  "native pickVars: official HTTP MCP ordered login/Bearer, frozen evidence, restart and fail-closed extraction",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      { project, frozen } = await importedProject(f);
    let entry = await f.connect(project.id),
      start = f.received.length;
    let run = await mcpRun(
      entry.client,
      project.id,
      "login-flow",
      project.environments[0].id,
    );
    assertPassedWire(f, start);
    let saved = await assertSaved(f, project.id, run, "mcp", frozen);
    assert.equal(JSON.stringify(saved).includes(entry.grantToken), false);
    await f.restart();
    saved = await new Store(f.data).get(project.id);
    assert.ok(saved.runs.some((item) => item.id === run.id));
    entry = await f.connect(project.id);
    start = f.received.length;
    run = await mcpRun(
      entry.client,
      project.id,
      "login-flow",
      project.environments[0].id,
    );
    assertPassedWire(f, start);
    await assertSaved(f, project.id, run, "mcp", frozen);
    await addFailurePlan(f, project.id);
    start = f.received.length;
    const failed = await mcpRun(
      entry.client,
      project.id,
      "failed-extraction",
      project.environments[0].id,
    );
    await assertFailedExtraction(f, project.id, failed, start);
  },
);

test(
  "native pickVars: true CLI subprocess preserves imported ordered extraction and stops stale-token followup",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      { project, frozen } = await importedProject(f);
    let start = f.received.length;
    const run = cliResult(await cli(f, project, "login-flow"), 0);
    assertPassedWire(f, start);
    await assertSaved(f, project.id, run, "cli", frozen);
    await addFailurePlan(f, project.id);
    start = f.received.length;
    const failed = cliResult(await cli(f, project, "failed-extraction"), 1);
    await assertFailedExtraction(f, project.id, failed, start);
    await f.restart();
    const saved = await new Store(f.data).get(project.id);
    assert.ok(
      saved.runs.some((item) => item.id === run.id && item.status === "passed"),
    );
    assert.ok(
      saved.runs.some(
        (item) => item.id === failed.id && item.status === "failed",
      ),
    );
  },
);

test(
  "native pickVars: true CLI SQLite grant, ordered mixed tasks, exact binding preflight and per-process revocation",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      project = await f.app.store.create("Canonical SQLite plus response pick");
    const filename = path.join(f.root, "private-fixture.db"),
      database = new DatabaseSync(filename);
    database.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('from-sqlite')",
    );
    database.close();
    const connectionId = "sqlite-fixture";
    const dbTask = {
      type: "database",
      id: "read",
      name: "Read fixture",
      enabled: 1,
      data: {
        connectionId,
        query: "SELECT value FROM records",
        isConsoleOutput: -1,
        variables: [
          { name: "dbValue", type: "environment", pattern: "$[0].value" },
        ],
      },
    };
    project.environments[0].variables.tenant = "entry";
    project.environments[0].variables.token = "STALE_MUST_NOT_SEND";
    const request = {
      id: "mixed",
      name: "SQLite then login",
      method: "GET",
      url: f.base + "/login/{{tenant}}",
      inheritSharedScripts: false,
      nativeTasks: {
        version: 1,
        before: [
          script("prefix", 'const lexical="sql:";'),
          dbTask,
          script(
            "after-db",
            'apt.setRequestHeader("x-db-value",lexical+pm.environment.get("dbValue"));',
          ),
        ],
        after: [
          script("post-prefix", 'const postPrefix="post:";'),
          nativeAssert(
            "native-sqlite-response",
            "$.session.token",
            "wire-entry",
          ),
          pick([
            row("token", "$.session.token"),
            row("localToken", "$.session.token", "tempVars"),
            row("zero", "$.zero"),
            row("nothing", "$.nothing", "globalVars"),
          ]),
          script(
            "post-assert",
            'pm.test("local scope",()=>pm.expect(pm.variables.get("localToken")).to.equal(pm.environment.get("token")));pm.environment.set("derived",postPrefix+pm.environment.get("token"));',
          ),
        ],
      },
    };
    project.plans = [
      snapshotPlan({
        id: "mixed",
        steps: [{ request }, { request: followup(f.base) }],
      }),
      snapshotPlan({
        id: "preflight",
        steps: [{ request: { url: f.base + "/must-not-run" } }, { request }],
      }),
    ];
    await f.app.store.save(project);
    const config = { type: "sqlite", filename },
      envelope = { databaseConnections: { [connectionId]: config } };
    for (const [flag, input] of [
      ["--database-stdin", { databaseConnections: {} }],
      [
        "--database-stdin",
        { databaseConnections: { [connectionId]: config, extra: config } },
      ],
      [
        "--database-stdin",
        {
          databaseConnections: {
            [connectionId]: { ...config, allowWrite: true },
          },
        },
      ],
      ["--credentials-stdin", envelope],
    ]) {
      const old = (await new Store(f.data).get(project.id)).runs.length,
        start = f.received.length;
      const output = await cli(f, project, "preflight", flag, input);
      assert.equal(output.code, 2, output.stdout + output.stderr);
      assert.equal(output.signal, null);
      assert.equal(output.stdout, "");
      assert.match(output.stderr, /CLI|databaseConnections|数据库/);
      assert.equal(
        f.received.length,
        start,
        "invalid exact grants fail before earlier HTTP-only step",
      );
      assert.equal((await new Store(f.data).get(project.id)).runs.length, old);
    }
    const start = f.received.length,
      passedOutput = await cli(
        f,
        project,
        "mixed",
        "--database-stdin",
        envelope,
      ),
      run = cliResult(passedOutput, 0);
    assert.equal(run.status, "passed", JSON.stringify(run.results));
    assert.equal(run.recordSaved, true);
    assert.equal(
      run.results[0].assertions.find(
        (item) => item.name === "native-sqlite-response",
      )?.passed,
      true,
    );
    assertPassedWire(f, start, "wire-entry");
    assert.equal(f.received[start].db, "sql:from-sqlite");
    assert.equal(run.results[0].databaseQueries[0].status, "completed");
    assert.equal(run.results[0].databaseQueries[0].phase, "before");
    let saved = await new Store(f.data).get(project.id),
      vars = saved.environments[0].variables;
    assert.equal(vars.dbValue, "from-sqlite");
    assert.equal(vars.token, "wire-entry");
    assert.equal(vars.derived, "post:wire-entry");
    assert.equal(vars.zero, 0);
    assert.equal(saved.globalVariables.nothing, null);
    assert.equal(Object.hasOwn(vars, "localToken"), false);
    assert.equal(saved.runs.find((item) => item.id === run.id).source, "cli");
    for (const evidence of [
      JSON.stringify(saved),
      passedOutput.stdout + passedOutput.stderr,
    ]) {
      assert.equal(evidence.includes(filename), false);
      assert.equal(evidence.includes('"databaseConnections"'), false);
    }
    // A new child has no inherited authority despite persisted database-derived values.
    const noGrantStart = f.received.length,
      denied = cliResult(await cli(f, project, "mixed"), 1);
    assert.equal(denied.status, "failed");
    assert.equal(denied.recordSaved, true);
    assert.equal(denied.results.length, 1);
    assert.match(denied.results[0].error, /未授权/);
    assert.equal(f.received.length, noGrantStart);
    await addFailurePlan(f, project.id, "mixed");
    // A completed before-stage DB read remains committed if later extraction fails.
    const changedDatabase = new DatabaseSync(filename);
    changedDatabase.exec("UPDATE records SET value='before-failed-extraction'");
    changedDatabase.close();
    const failedStart = f.received.length,
      failed = cliResult(
        await cli(
          f,
          project,
          "failed-extraction",
          "--database-stdin",
          envelope,
        ),
        1,
      );
    await assertFailedExtraction(f, project.id, failed, failedStart);
    await f.restart();
    saved = await new Store(f.data).get(project.id);
    assert.ok(
      saved.runs.some((item) => item.id === run.id && item.status === "passed"),
    );
    assert.ok(
      saved.runs.some(
        (item) => item.id === denied.id && item.status === "failed",
      ),
    );
    assert.ok(
      saved.runs.some(
        (item) => item.id === failed.id && item.status === "failed",
      ),
    );
    assert.equal(
      saved.environments[0].variables.dbValue,
      "before-failed-extraction",
    );
    assert.equal(JSON.stringify(saved).includes(filename), false);
  },
);

function nativeAssertionEvidence(record) {
  return record.assertions
    .filter((item) => ["native-false", "native-true"].includes(item.name))
    .map((item) => [item.name, item.passed, item.phase]);
}
async function assertionProject(f, withPick) {
  const project = await f.app.store.create("Native assertion entrypoint");
  const source = nativeSource(f.base),
    api = source.apis[1];
  api.request.pre_tasks = [
    script("before-proof", 'pm.environment.set("beforeProof","committed");'),
  ];
  api.request.post_tasks = [
    script(
      "ordered-start",
      'order.push("api");const afterProof="same-phase-after-assert";',
    ),
    nativeAssert("native-false", "$.no", "true"),
    nativeAssert("native-true", "$.zero", "0"),
    ...(withPick ? [pick([row("token", "$.session.token")])] : []),
    script(
      "tamper-public-tests",
      'for(const item of tests)item.passed=true;tests.length=0;tests.push({name:"forged-public-success",passed:true});pm.environment.set("afterNative",afterProof);pm.globals.set("afterGlobal",afterProof);pm.environment.set("order",order.join(","));console.log("same-phase-after-assert-ran");',
    ),
  ];
  const original = structuredClone(source);
  importIntoProject(project, source);
  assert.deepEqual(source, original);
  Object.assign(project.environments[0].variables, {
    tenant: "entry",
    token: "STALE_MUST_NOT_SEND",
    afterNative: "prior-environment",
  });
  project.globalVariables.afterGlobal = "prior-global";
  project.plans = [
    snapshotPlan({
      id: "assertion-flow",
      steps: [
        { request: project.requests[0] },
        {
          request: {
            method: "GET",
            url: f.base + "/resource",
            auth: { type: "bearer", token: "{{token}}" },
            inheritSharedScripts: false,
            nativeTasks: {
              version: 1,
              before: [],
              after: [
                nativeAssert("next-native-success", "", "200", "responseCode"),
              ],
            },
          },
        },
      ],
    }),
  ];
  await f.app.store.save(project);
  return project;
}
async function assertAssertionRun(f, project, run, start, withPick, source) {
  assert.equal(run.status, "failed", JSON.stringify(run.results));
  assert.equal(run.recordSaved, true);
  assert.equal(run.results.length, withPick ? 1 : 2);
  assert.equal(run.results[0].status, "failed");
  assert.equal(run.results[0].response.status, 200);
  assert.deepEqual(nativeAssertionEvidence(run.results[0]), [
    ["native-false", false, "after"],
    ["native-true", true, "after"],
  ]);
  assert.ok(
    run.results[0].logs.some(
      (item) =>
        item.phase === "after" &&
        item.message.includes("same-phase-after-assert-ran"),
    ),
    "native comparison false remains soft within the ordered VM phase",
  );
  assert.deepEqual(
    f.received.slice(start).map((item) => item.path),
    withPick ? ["/login/entry"] : ["/login/entry", "/resource"],
  );
  if (withPick) assert.match(run.results[0].error, /断言/);
  else {
    assert.equal(
      run.results[0].error,
      undefined,
      "comparison false is not a thrown script failure",
    );
    assert.equal(run.results[1].status, "passed");
    assert.deepEqual(
      run.results[1].assertions.map((item) => [item.name, item.passed]),
      [["next-native-success", true]],
    );
    assert.equal(f.received.at(-1).authorization, "Bearer STALE_MUST_NOT_SEND");
  }
  const saved = await new Store(f.data).get(project.id),
    env = saved.environments[0].variables;
  assert.equal(env.beforeProof, "committed");
  assert.equal(env.token, "STALE_MUST_NOT_SEND");
  assert.equal(
    env.afterNative,
    withPick ? "prior-environment" : "same-phase-after-assert",
  );
  assert.equal(
    saved.globalVariables.afterGlobal,
    withPick ? "prior-global" : "same-phase-after-assert",
  );
  if (!withPick) assert.equal(env.order, "project,folder,api");
  const evidence = saved.runs.find((item) => item.id === run.id);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.source, source);
  assert.deepEqual(
    nativeAssertionEvidence(evidence.results[0]),
    nativeAssertionEvidence(run.results[0]),
  );
  return saved;
}
for (const entrypoint of ["mcp", "cli"])
  for (const withPick of [false, true])
    test(
      `native assertions: actual ${entrypoint} ${withPick ? "pick coexists: rollback and stop" : "assert-only: commit and continue"}, immutable failure evidence and backup/restart`,
      { timeout: 30000 },
      async (t) => {
        const f = await fixture(t),
          project = await assertionProject(f, withPick),
          start = f.received.length;
        const run =
          entrypoint === "mcp"
            ? await mcpRun(
                (await f.connect(project.id)).client,
                project.id,
                "assertion-flow",
                project.environments[0].id,
              )
            : cliResult(await cli(f, project, "assertion-flow"), 1);
        const saved = await assertAssertionRun(
          f,
          project,
          run,
          start,
          withPick,
          entrypoint,
        );
        // Exercise the real backup/restore routes, not only an in-memory clone.
        const backupResponse = await fetch(
          `${f.app.url}/api/projects/${project.id}/export`,
          { headers: { "x-local-token": f.app.token } },
        );
        assert.equal(backupResponse.status, 200);
        const document = await backupResponse.json();
        assert.deepEqual(
          document.runs.find((item) => item.id === run.id).results,
          saved.runs.find((item) => item.id === run.id).results,
        );
        const restoreResponse = await fetch(f.app.url + "/api/restore", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-local-token": f.app.token,
          },
          body: JSON.stringify({ document }),
        });
        assert.equal(
          restoreResponse.status,
          201,
          await restoreResponse.clone().text(),
        );
        const restored = await restoreResponse.json();
        assert.notEqual(restored.id, project.id);
        const calls = f.received.length;
        await f.restart();
        assert.equal(
          f.received.length,
          calls,
          "restore/restart cannot replay the saved flow",
        );
        for (const projectId of [project.id, restored.id]) {
          const disk = await new Store(f.data).get(projectId),
            evidence = disk.runs.find((item) => item.id === run.id);
          assert.equal(evidence.status, "failed");
          assert.equal(evidence.source, entrypoint);
          assert.deepEqual(nativeAssertionEvidence(evidence.results[0]), [
            ["native-false", false, "after"],
            ["native-true", true, "after"],
          ]);
          assert.equal(evidence.results.length, withPick ? 1 : 2);
          assert.deepEqual(
            disk.plans[0].steps[0].request.nativeTasks,
            project.plans[0].steps[0].request.nativeTasks,
          );
          assert.equal(
            disk.environments[0].variables.afterNative,
            withPick ? "prior-environment" : "same-phase-after-assert",
          );
          assert.equal(
            disk.globalVariables.afterGlobal,
            withPick ? "prior-global" : "same-phase-after-assert",
          );
        }
      },
    );
