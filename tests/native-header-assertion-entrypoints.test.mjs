// Independent combined acceptance of Header eq/uneq. Real native import/export,
// SDK transports, child CLI, sockets and Store journals; no mock execution path.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";

const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  enabled,
  data,
});
const row = (name, expression, type = "envVars") => ({
  name,
  expression,
  type,
});
const pick = (id, variables, enabled = 1) =>
  task(id, "pickVars", { source: "responseHeader", variables }, enabled);
const html = "<html>header-only login, deliberately not JSON</html>";
const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const invoke = (client, name, args) =>
  client.callTool({ name, arguments: args });

const headerAssert = (id, field, expected, comparison = "eq", enabled = 1) =>
  task(
    id,
    "assert",
    {
      type: "responseHeader",
      expression: {
        path: field,
        compareType: comparison,
        compareValue: expected,
      },
    },
    enabled,
  );
function headerSource(base, version, activePick = false) {
  const document = modernApipostFixture();
  document.global.envs = [];
  document.global.servers = [];
  document.global.global_vars = {};
  const login = document.apis[1];
  login.name = "Header assertion login";
  login.url = base + "/login/{{tenant}}";
  login.protocol = version === "2" ? "http/2" : "http/1.1";
  login.request.query.parameter = [];
  login.request.header.parameter = [];
  login.request.pre_tasks = [
    task(
      "before",
      "customScript",
      'pm.environment.set("beforeProof","committed");pm.environment.set("beforeCount",(pm.environment.get("beforeCount")||0)+1);',
    ),
  ];
  login.request.post_tasks = [
    task(
      "prepare",
      "customScript",
      'const prefix="derived:";pm.environment.set("postPending","new");pm.globals.set("postGlobal","new");',
    ),
    pick("optional-pick", [row("token", "x-token")], activePick ? 1 : 0),
    headerAssert("Header eq", "X-StAtE", "ready"),
    headerAssert("Header uneq", "x-state", "blocked", "uneq"),
    headerAssert("empty literal", "x-empty", ""),
    headerAssert(
      "disabled literal",
      "{{HEADER_NAME}}",
      "{{EXPECTED}}",
      "eq",
      0,
    ),
    task(
      "consume",
      "customScript",
      'pm.environment.set("token",response.headers["x-token"]);pm.environment.set("derived",prefix+pm.environment.get("token"));pm.environment.set("followingTask","yes");for(const item of tests)item.passed=true;tests.length=0;tests.push({name:"forged success",passed:true});',
    ),
  ];
  const resource = structuredClone(login);
  resource.target_id = "assertion-resource";
  resource.name = "Protected resource";
  resource.url = base + "/resource";
  resource.request.pre_tasks = [];
  resource.request.post_tasks = [];
  resource.request.auth = { type: "bearer", bearer: { key: "{{token}}" } };
  document.apis.push(resource);
  return document;
}

async function fixture(t, version = "1.1") {
  const root = await mkdtemp(path.join(tmpdir(), "native-header-entry-")),
    wire = [],
    clients = [],
    sessions = new Set();
  let mode = "ok",
    count = 0;
  const peer = version === "2" ? http2.createServer() : http.createServer();
  peer.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  peer.on("request", (req, res) => {
    wire.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/login/")) {
      const token = "wire-header-" + ++count;
      res.setHeader("x-token", token);
      res.setHeader(
        "x-state",
        mode === "duplicate"
          ? ["blocked", "ready"]
          : mode === "blocked"
            ? "blocked"
            : "ready",
      );
      res.setHeader("x-empty", "");
      if (mode === "proof-overflow") {
        for (let i = 0; i < 300; i++) res.setHeader("x-proof-" + i, "v");
        res.setHeader("x-tail", "still-visible");
      }
    }
    res.end(html);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  let app = await createApp({ root, port: 0 });
  const stop = async () => {
    for (const client of clients.splice(0))
      await client.close().catch(() => {});
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  };
  t.after(async () => {
    await stop();
    for (const session of sessions) session.destroy();
    peer.closeAllConnections?.();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, body, method = "POST") => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    root,
    wire,
    call,
    version,
    base: `http://127.0.0.1:${peer.address().port}`,
    get store() {
      return app.store;
    },
    setMode(value) {
      mode = value;
    },
    async import(document) {
      const p = await call("/api/projects", {
        name: "Header entrypoint fixture",
      });
      assert.equal(p.status, 201);
      const imported = await call(`/api/projects/${p.value.id}/import`, {
        document,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported));
      return imported.value;
    },
    async seed(document) {
      const p = await this.import(document);
      p.environments[0].variables = {
        tenant: "selected",
        token: "stale-token",
        beforeCount: 0,
        derived: "old-derived",
        postPending: "old-pending",
        disabled: "unchanged",
        HEADER_NAME: "x-token",
      };
      p.environments.push({
        id: "header-other-env",
        name: "Unselected",
        variables: { tenant: "other", token: "other-env-token" },
      });
      p.globalVariables.postGlobal = "old-global";
      const result = await call(`/api/projects/${p.id}`, p, "PUT");
      assert.equal(result.status, 200, JSON.stringify(result));
      return result.value;
    },
    async connect(
      projectId,
      transport = "http",
      { write = true, execute = true } = {},
    ) {
      const client = new Client(
        { name: "native-header-entrypoints", version: "1" },
        { capabilities: {} },
      );
      clients.push(client);
      if (transport === "http") {
        const configured = await call("/api/mcp/config", {
          enabled: true,
          projects: [projectId],
          write,
          execute,
          remember: false,
        });
        assert.equal(configured.status, 200);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
            requestInit: {
              headers: { Authorization: "Bearer " + configured.value.token },
            },
          }),
        );
      } else {
        const stdio = new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
            "--project",
            projectId,
            ...(write ? ["--write"] : []),
            ...(execute ? ["--execute"] : []),
          ],
          env: { LOCAL_API_DATA: root },
          stderr: "pipe",
        });
        stdio.stderr.resume();
        await client.connect(stdio);
      }
      return client;
    },
    async restart() {
      await stop();
      app = await createApp({ root, port: 0 });
    },
  };
}

async function sdkPlan(client, project, environmentId) {
  return decode(
    await invoke(client, "localapi_create_execution_flow", {
      projectId: project.id,
      plan: {
        name: "Header to Bearer",
        environmentId,
        steps: project.requests.map((request) => ({ request })),
      },
    }),
  );
}
function cli(root, projectId, planId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/run-plan.mjs", import.meta.url)),
        "--project",
        projectId,
        "--plan",
        planId,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LOCAL_API_DATA: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      failure;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      failure = Error("Header CLI fixture timed out");
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        failure = Error("CLI output exceeds bound");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      failure ? reject(failure) : resolve({ code, signal, stdout, stderr });
    });
  });
}
const comparableTasks = (pipeline) =>
  Object.fromEntries(
    Object.entries(pipeline).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(({ id, ...task }) => task) : value,
    ]),
  );

function headerAssertions(run, passed) {
  for (const name of ["Header eq", "Header uneq"])
    assert.equal(
      run.results[0].assertions.find((entry) => entry.name === name)?.passed,
      passed,
      JSON.stringify(run.results[0].assertions),
    );
}
function actualHTML(run) {
  assert.equal(run.results[0].response.status, 200);
  assert.equal(run.results[0].response.body, html);
}

for (const [version, transport] of [
  ["1.1", "http"],
  ["2", "stdio"],
])
  test(
    `Header eq/uneq HTTP/${version} native roundtrip reaches ${transport} SDK and CLI with durable private failures`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t, version),
        document = headerSource(f.base, version),
        untouched = structuredClone(document);
      const original = await f.seed(document),
        originalBefore = await f.store.get(original.id);
      const exported = await f.call(
        `/api/projects/${original.id}/export?format=apipost`,
        undefined,
        "GET",
      );
      assert.equal(exported.status, 200, JSON.stringify(exported));
      const copy = await f.import(exported.value);
      const selected = copy.environments.find(
          (env) => env.variables.tenant === "selected",
        ),
        unselected = copy.environments.find(
          (env) => env.variables.tenant === "other",
        );
      assert(selected && unselected);
      assert.deepEqual(
        comparableTasks(copy.requests[0].nativeTasks),
        comparableTasks(original.requests[0].nativeTasks),
      );
      const disabled = copy.requests[0].nativeTasks.after.find(
        (entry) => entry.type === "assert" && entry.enabled === 0,
      );
      assert.equal(disabled.data.expression.path, "{{HEADER_NAME}}");
      assert.equal(disabled.data.expression.compareValue, "{{EXPECTED}}");
      const reader = await f.connect(copy.id, transport, {
        write: false,
        execute: false,
      });
      assert(
        !(await reader.listTools()).tools.some(
          (entry) => entry.name === "localapi_execute_flow",
        ),
      );
      assert.equal(
        (
          await invoke(reader, "localapi_execute_api", {
            projectId: copy.id,
            apiId: copy.requests[0].id,
          })
        ).isError,
        true,
      );
      const client = await f.connect(copy.id, transport),
        plan = await sdkPlan(client, copy, selected.id);
      for (const args of [
        { projectId: original.id, planId: plan.id },
        {
          projectId: copy.id,
          planId: plan.id,
          environmentId: original.environments[0].id,
        },
      ])
        assert.equal(
          (await invoke(client, "localapi_execute_flow", args)).isError,
          true,
        );
      assert.deepEqual(f.wire, []);
      const first = decode(
        await invoke(client, "localapi_execute_flow", {
          projectId: copy.id,
          planId: plan.id,
        }),
      );
      assert.equal(first.status, "passed");
      assert.equal(first.recordSaved, true);
      assert.equal(first.recordId, first.attemptedRecordId);
      headerAssertions(first, true);
      actualHTML(first);
      assert.equal(
        first.results[0].assertions.some(
          (entry) => entry.name === "disabled literal",
        ),
        false,
      );
      assert.equal(first.variables.derived, "derived:wire-header-1");
      assert.equal(f.wire.at(-1).authorization, "Bearer wire-header-1");
      const stored = await f.store.get(copy.id);
      assert.deepEqual(
        stored.environments.find((env) => env.id === unselected.id),
        unselected,
      );
      // Change the live task while retaining the frozen original equality. A false
      // comparison is soft: following same-phase scripts commit and later HTTP runs.
      stored.requests[0].nativeTasks.after.find(
        (entry) => entry.name === "Header eq",
      ).data.expression.compareValue = "blocked";
      const edit = await f.call(`/api/projects/${copy.id}`, stored, "PUT");
      assert.equal(edit.status, 200);
      f.setMode("blocked");
      const command = await cli(f.root, copy.id, plan.id);
      assert.equal(command.code, 1, command.stderr);
      assert.equal(command.signal, null);
      const failed = JSON.parse(command.stdout);
      assert.equal(failed.status, "failed");
      assert.equal(failed.results.length, 2);
      assert.equal(failed.results[1].status, "passed");
      assert.equal(failed.recordSaved, true);
      headerAssertions(failed, false);
      actualHTML(failed);
      assert.equal(failed.results[0].scopeCommit, undefined);
      assert.equal(failed.variables.token, "wire-header-2");
      assert.equal(failed.variables.derived, "derived:wire-header-2");
      assert.equal(failed.variables.followingTask, "yes");
      assert.equal(f.wire.at(-1).authorization, "Bearer wire-header-2");
      const saved = await f.store.get(copy.id);
      assert.equal(saved.globalVariables.postGlobal, "new");
      assert.equal(
        saved.environments.find((env) => env.id === selected.id).variables
          .beforeCount,
        2,
      );
      headerAssertions(
        saved.runs.find((record) => record.id === failed.id),
        false,
      );
      const backup = await f.call(
        `/api/projects/${copy.id}/export`,
        undefined,
        "GET",
      );
      assert.equal(backup.status, 200);
      const restored = await f.call("/api/restore", { document: backup.value });
      assert.equal(restored.status, 201);
      await f.restart();
      assert.equal(f.wire.length, 4);
      const restoredRead = await f.connect(restored.value.id, transport, {
        write: false,
        execute: false,
      });
      assert.equal(
        (
          await invoke(restoredRead, "localapi_execute_flow", {
            projectId: restored.value.id,
            planId: plan.id,
          })
        ).isError,
        true,
      );
      const prior = decode(
        await invoke(restoredRead, "localapi_get_run", {
          projectId: restored.value.id,
          runId: failed.id,
        }),
      );
      headerAssertions(prior, false);
      f.setMode("ok");
      const again = await cli(f.root, restored.value.id, plan.id);
      assert.equal(again.code, 0, again.stderr);
      const passed = JSON.parse(again.stdout);
      assert.equal(passed.status, "passed");
      headerAssertions(passed, true);
      const restarted = await new Store(f.root).get(restored.value.id);
      assert.equal(restarted.runs.length, 3);
      headerAssertions(
        restarted.runs.find((record) => record.id === failed.id),
        false,
      );
      assert.deepEqual(
        restarted.plans[0].steps[0].request.nativeTasks,
        plan.steps[0].request.nativeTasks,
      );
      assert.deepEqual(
        restarted.environments.find((env) => env.id === unselected.id),
        unselected,
      );
      assert.deepEqual(await f.store.get(copy.id), saved);
      assert.deepEqual(await f.store.get(original.id), originalBefore);
      assert.deepEqual(document, untouched);
      assert.equal(f.wire.length, 6);
      assert.equal(f.wire.at(-1).authorization, "Bearer wire-header-3");
    },
  );

for (const mode of ["blocked", "duplicate"])
  for (const activePick of [false, true])
    test(
      `SDK Header ${mode === "blocked" ? "false comparison" : "wire lookup error"} with ${activePick ? "active" : "disabled"} pick has the exact commit/continuation policy`,
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(t),
          p = await f.seed(headerSource(f.base, "1.1", activePick));
        f.setMode(mode);
        const before = await f.store.get(p.id),
          client = await f.connect(p.id),
          plan = await sdkPlan(client, p, p.environments[0].id);
        const run = decode(
          await invoke(client, "localapi_execute_flow", {
            projectId: p.id,
            planId: plan.id,
          }),
        );
        assert.equal(run.status, "failed");
        assert.equal(run.recordSaved, true);
        assert.equal(run.recordId, run.attemptedRecordId);
        assert.equal(run.results.length, activePick ? 1 : 2);
        actualHTML(run);
        if (mode === "blocked") headerAssertions(run, false);
        else {
          assert.match(run.results[0].error, /响应头|Header|header/);
          assert.equal(
            run.results[0].assertions.some(
              (entry) => entry.name === "Header eq",
            ),
            false,
            "lookup failure is not a fabricated false comparison",
          );
        }
        const soft = mode === "blocked" && !activePick;
        const saved = await new Store(f.root).get(p.id),
          vars = saved.environments[0].variables;
        assert.equal(vars.beforeCount, 1);
        assert.equal(vars.beforeProof, "committed");
        assert.equal(vars.token, soft ? "wire-header-1" : "stale-token");
        assert.equal(
          vars.derived,
          soft ? "derived:wire-header-1" : "old-derived",
        );
        assert.equal(vars.postPending, soft ? "new" : "old-pending");
        assert.equal(vars.followingTask, soft ? "yes" : undefined);
        assert.equal(
          saved.globalVariables.postGlobal,
          soft ? "new" : "old-global",
        );
        assert.deepEqual(saved.environments[1], before.environments[1]);
        assert.deepEqual(saved.runs[0].results, run.results);
        assert.equal(run.results[0].scopeCommit, undefined);
        assert.deepEqual(f.wire, [
          { path: "/login/selected", authorization: undefined },
          ...(!activePick
            ? [
                {
                  path: "/resource",
                  authorization: soft
                    ? "Bearer wire-header-1"
                    : "Bearer stale-token",
                },
              ]
            : []),
        ]);
        // Without active extraction, ordinary phase errors still continue to later
        // requests by the existing plan contract. Only active pick adds fail-stop.
      },
    );

test(
  "SDK soft Header failures survive real final journal uncertainty and recover the same record without replay",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      document = headerSource(f.base, "1.1");
    document.apis[1].request.post_tasks.splice(
      -1,
      0,
      task("bounded-wait", "wait", 10),
    );
    const p = await f.seed(document),
      other = await f.store.create("Unrelated receipt project"),
      otherBefore = await f.store.get(other.id);
    f.setMode("blocked");
    const client = await f.connect(p.id),
      plan = await sdkPlan(client, p, p.environments[0].id),
      before = await f.store.get(p.id);
    const store = f.store,
      originalSave = store.save,
      originalRead = store.readUnlocked;
    const directory = store.directory(p.id),
      history = path.join(directory, "history"),
      kept = path.join(directory, "history-kept"),
      journalFile = path.join(directory, ".transaction.json");
    let attempts = 0,
      readState,
      observed;
    const restore = () => {
      store.save = originalSave;
      store.readUnlocked = originalRead;
    };
    t.after(restore);
    // Only orchestrate an owned filesystem fault after the original locked read.
    // Network, scopes, native assertions, journal publication and apply stay real.
    store.save = async function (value, options) {
      if (value.id !== p.id || !options?.activity)
        return originalSave.call(this, value, options);
      attempts++;
      this.readUnlocked = async function (id) {
        const state = await originalRead.call(this, id);
        readState = structuredClone(state);
        this.readUnlocked = originalRead;
        await rename(history, kept);
        await writeFile(history, "owned Header assertion record obstacle");
        return state;
      };
      try {
        return await originalSave.call(this, value, options);
      } catch (error) {
        observed = error;
        throw error;
      } finally {
        this.readUnlocked = originalRead;
      }
    };
    const run = decode(
      await invoke(client, "localapi_execute_flow", {
        projectId: p.id,
        planId: plan.id,
      }),
    );
    restore();
    assert.equal(
      run.status,
      "failed",
      "record uncertainty cannot erase the private false assertions",
    );
    assert.equal(run.results.length, 2);
    headerAssertions(run, false);
    actualHTML(run);
    assert.equal(run.results[1].status, "passed");
    assert.equal(
      run.results[0].scopeCommit,
      undefined,
      "confirmed scope commit is distinct from final record uncertainty",
    );
    assert.equal(run.variables.token, "wire-header-1");
    assert.equal(run.variables.followingTask, "yes");
    assert.equal(run.recordSaved, false);
    assert.equal(run.recordId, null);
    assert.equal(run.attemptedRecordId, run.id);
    assert.deepEqual(run.persistenceOutcome, {
      code: "PROJECT_COMMIT_UNCERTAIN",
      project_id: p.id,
      commit_outcome: "unknown",
      retry_safe: false,
    });
    assert(observed instanceof ProjectCommitUncertain);
    assert.equal(attempts, 1);
    assert.equal(readState.revision, before.revision + 2);
    assert.equal(readState.environments[0].variables.beforeCount, 1);
    assert.equal(readState.environments[0].variables.token, "wire-header-1");
    assert.equal(
      readState.environments[0].variables.derived,
      "derived:wire-header-1",
    );
    const publicReceipt = JSON.stringify({
      error: run.persistenceError,
      outcome: run.persistenceOutcome,
    });
    for (const hidden of [
      f.root,
      JSON.stringify(f.root).slice(1, -1),
      "ENOTDIR",
      '"cause"',
      "owned Header assertion record obstacle",
    ])
      assert(!publicReceipt.includes(hidden));
    assert.equal((await stat(history)).isFile(), true);
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(journal.revision, readState.revision + 1);
    assert.equal(journal.configRevision, readState.configRevision);
    assert.equal(journal.runs[0].id, run.attemptedRecordId);
    assert.deepEqual(journal.runs[0].results, run.results);
    headerAssertions(journal.runs[0], false);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"))
        .revision,
      readState.revision,
    );
    await assert.rejects(
      new Store(f.root).get(p.id),
      (error) => error instanceof ProjectCommitUncertain,
    );
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    const expectedWire = [
      { path: "/login/selected", authorization: undefined },
      { path: "/resource", authorization: "Bearer wire-header-1" },
    ];
    assert.deepEqual(f.wire, expectedWire);
    await rm(history);
    await rename(kept, history);
    const recovered = await new Store(f.root).get(p.id);
    assert.equal(recovered.runs.length, before.runs.length + 1);
    assert.equal(recovered.runs[0].id, run.attemptedRecordId);
    assert.equal(recovered.runs[0].status, "failed");
    assert.deepEqual(recovered.runs[0].results, run.results);
    headerAssertions(recovered.runs[0], false);
    assert.equal(recovered.environments[0].variables.token, "wire-header-1");
    assert.deepEqual(recovered.environments[1], before.environments[1]);
    await assert.rejects(readFile(journalFile), { code: "ENOENT" });
    await f.restart();
    const reader = await f.connect(p.id, "http", {
      write: false,
      execute: false,
    });
    const reconciled = decode(
      await invoke(reader, "localapi_get_run", {
        projectId: p.id,
        runId: run.attemptedRecordId,
      }),
    );
    assert.equal(reconciled.id, run.attemptedRecordId);
    headerAssertions(reconciled, false);
    assert.deepEqual(await f.store.get(p.id), recovered);
    assert.deepEqual(await f.store.get(other.id), otherBefore);
    assert.equal(attempts, 1);
    assert.deepEqual(f.wire, expectedWire);
  },
);

async function inertAssertionSource(base) {
  const files = [];
  for (const [directory, prefix] of [
    ["directory/", ""],
    ["executions/", "executions/"],
  ]) {
    const root = new URL(
      "./fixtures/original-offline2/" + directory,
      import.meta.url,
    );
    for (const name of (await readdir(root, { recursive: true })).filter(
      (name) => name.endsWith(".json"),
    )) {
      const relative = name.replaceAll("\\", "/");
      files.push({
        path: prefix + relative,
        text: await readFile(new URL(relative, root), "utf8"),
      });
    }
  }
  const file = files.find(
      (entry) => entry.path === "executions/flows/flow_1792937049044.json",
    ),
    flow = JSON.parse(file.text);
  for (const step of flow.steps) {
    step.api_snapshot.url = base + "/inert";
    step.pre_script = "";
    step.post_script = "";
    step.api_snapshot.request.pre_tasks = [
      task(
        "historical-script",
        "customScript",
        'throw Error("historical {{HEADER_NAME}} must not run")',
      ),
    ];
    // Raw enabled declarations are normalized before conversion to inert source:
    // keep these valid literals. Disabled template data is retained, not expanded.
    step.api_snapshot.request.post_tasks = [
      headerAssert("historical-header", "x-state", "must-not-be-observed"),
      headerAssert(
        "historical-disabled",
        "{{HEADER_NAME}}",
        "{{EXPECTED}}",
        "uneq",
        0,
      ),
    ];
  }
  file.text = JSON.stringify(flow);
  return { format: "apipost-offline-directory-v1", files };
}

test(
  "raw Header assertion grammar rejects atomically while native flow source stays inert through CLI and restore",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      document = await inertAssertionSource(f.base),
      untouched = structuredClone(document);
    const created = await f.call("/api/projects", {
      name: "Inert Header assertion source",
    });
    assert.equal(created.status, 201);
    const initial = await f.store.get(created.value.id),
      invalid = structuredClone(document);
    const badFile = invalid.files.find(
        (entry) => entry.path === "executions/flows/flow_1792937049044.json",
      ),
      badFlow = JSON.parse(badFile.text);
    badFlow.steps[0].api_snapshot.request.post_tasks[0].data.expression.path =
      "{{BAD_ENABLED_HEADER}}";
    badFile.text = JSON.stringify(badFlow);
    const rejected = await f.call(`/api/projects/${initial.id}/import`, {
      document: invalid,
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.value.error, /模板/);
    assert.deepEqual(await f.store.get(initial.id), initial);
    assert.deepEqual(f.wire, []);
    const imported = await f.call(`/api/projects/${initial.id}/import`, {
      document,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported));
    const p = imported.value,
      plan = p.plans[0],
      env = p.environments.find((entry) => entry.id === plan.environmentId);
    env.variables.HEADER_NAME = "x-state";
    env.variables.EXPECTED = "ready";
    env.variables.token = "unchanged-inert";
    const seeded = await f.call(`/api/projects/${p.id}`, p, "PUT");
    assert.equal(seeded.status, 200);
    const histories = plan.steps.map((step) =>
      structuredClone(step.request.importedNativeTaskSource),
    );
    for (const [index, step] of plan.steps.entries()) {
      assert.equal(step.request.nativeTasks, undefined);
      assert.equal(step.request.beforeScript, "");
      assert.equal(step.request.afterScript, "");
      assert.equal(histories[index].after[0].enabled, 1);
      assert.equal(histories[index].after[0].data.type, "responseHeader");
      assert.equal(histories[index].after[0].data.expression.path, "x-state");
      assert.equal(
        histories[index].after[1].data.expression.path,
        "{{HEADER_NAME}}",
      );
      assert.equal(
        histories[index].after[1].data.expression.compareValue,
        "{{EXPECTED}}",
      );
    }
    const command = await cli(f.root, p.id, plan.id);
    assert.equal(command.code, 0, command.stderr);
    const run = JSON.parse(command.stdout);
    assert.equal(run.status, "passed");
    assert.equal(run.variables.token, "unchanged-inert");
    assert(
      run.results.every(
        (result) =>
          result.response.body === html && result.assertions.length === 0,
      ),
    );
    assert.deepEqual(
      run.snapshot.steps.map((step) => step.request.importedNativeTaskSource),
      histories,
    );
    assert.deepEqual(
      f.wire,
      Array.from({ length: 2 }, () => ({
        path: "/inert?fixture=original",
        authorization: undefined,
      })),
    );
    const saved = await f.store.get(p.id),
      backup = await f.call(`/api/projects/${p.id}/export`, undefined, "GET");
    assert.equal(backup.status, 200);
    const restored = await f.call("/api/restore", { document: backup.value });
    assert.equal(restored.status, 201);
    await f.restart();
    const reread = await new Store(f.root).get(restored.value.id);
    assert.deepEqual(
      reread.plans[0].steps.map(
        (step) => step.request.importedNativeTaskSource,
      ),
      histories,
    );
    assert.deepEqual(
      reread.runs[0].snapshot.steps.map(
        (step) => step.request.importedNativeTaskSource,
      ),
      histories,
    );
    assert.equal(
      reread.environments.find((entry) => entry.id === plan.environmentId)
        .variables.token,
      "unchanged-inert",
    );
    assert.deepEqual(await f.store.get(p.id), saved);
    assert.deepEqual(document, untouched);
    assert.equal(f.wire.length, 2);
  },
);
