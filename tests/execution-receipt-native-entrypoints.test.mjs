// Independent combined acceptance. Only fictional loopback effects and owned
// disk obstacles; all Store/journal/recovery implementations remain real.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { normalizeRequest, snapshotPlan } from "../src/core.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function fixture(t, kind) {
  const directory = await mkdtemp(path.join(tmpdir(), "native-receipt-"));
  const root = path.join(directory, "data"),
    wire = [];
  let beforeRespond = async () => {};
  const peer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    wire.push({ url: req.url, body, token: req.headers["x-scope-token"] });
    await beforeRespond();
    if (res.destroyed) return;
    res.writeHead(200, {
      "content-type": "application/json",
      "x-fixture": "once-only",
    });
    res.end(JSON.stringify({ token: "fresh-token-" + wire.length }));
  });
  let app, client, transport;
  const stderr = [];
  t.after(async () => {
    await client?.close().catch(() => {});
    if (app) await closeServer(app.server);
    await closeServer(peer);
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  if (kind === "http") app = await createApp({ root, port: 0 });
  const store = app?.store || new Store(root);
  const project = await store.create("Native receipt project");
  const other = await store.create("Independent canonical project");
  const denied = await store.create("Outside MCP allowlist");
  const envId = project.environments[0].id;
  project.environments[0].variables.token = "stale-target";
  project.environments.push({
    id: "untouched-env",
    name: "Untouched",
    variables: { token: "separate-env" },
  });
  other.environments[0].variables.token = "other-project";
  const request = normalizeRequest({
    id: "receipt-native-request",
    name: "Once-only native login",
    method: "POST",
    url: `http://127.0.0.1:${peer.address().port}/native`,
    bodyType: "json",
    body: '{"fixture":"native-receipt"}',
    headers: [{ key: "X-Scope-Token", value: "{{token}}", enabled: true }],
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [],
      after: [
        {
          type: "pickVars",
          enabled: 1,
          data: {
            source: "responseJson",
            variables: [
              { name: "token", expression: "$.token", type: "envVars" },
            ],
          },
        },
        {
          type: "customScript",
          enabled: 1,
          data: 'pm.variables.set("onlyThisRequest","private-local");',
        },
      ],
    },
  });
  project.requests = [request];
  project.plans = [
    snapshotPlan({
      id: "receipt-native-flow",
      name: "Native frozen flow",
      environmentId: envId,
      steps: [{ request }],
    }),
  ];
  other.requests = [
    normalizeRequest({
      ...request,
      id: "other-request",
      name: "Canonical isolation",
      url: request.url.replace("/native", "/other"),
      nativeTasks: undefined,
    }),
  ];
  await store.save(project);
  await store.save(other);
  const post = async (route, body) => {
    const response = await fetch(app.url + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const connect = async (nodeArgs = []) => {
    await client?.close();
    client = new Client(
      { name: "native-receipt-acceptance", version: "1" },
      { capabilities: {} },
    );
    if (kind === "http") {
      const config = await post("/api/mcp/config", {
        enabled: true,
        projects: [project.id, other.id],
        write: true,
        execute: true,
        remember: false,
      });
      transport = new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      });
    } else {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          ...nodeArgs,
          fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
          "--project",
          project.id,
          "--project",
          other.id,
          "--write",
          "--execute",
        ],
        env: { LOCAL_API_DATA: root },
        stderr: "pipe",
      });
      transport.stderr.setEncoding("utf8");
      transport.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    await client.connect(transport);
  };
  return {
    directory,
    root,
    store,
    project,
    other,
    denied,
    request,
    envId,
    wire,
    stderr,
    post,
    connect,
    beforeRespond(fn) {
      beforeRespond = fn;
    },
    get client() {
      return client;
    },
    call: (name, args, options) =>
      client.callTool({ name, arguments: args }, undefined, options),
  };
}

// A single project and stage select the fault. This function is also serialized
// into a private --import fixture for a real child. No fake Store return/errors.
function installFault(store, config) {
  const originalSave = store.save;
  let armed = true,
    attempts = 0;
  store.save = async function (project, options) {
    const match =
      project.id === config.projectId &&
      (config.mode === "scope"
        ? !options?.activity &&
          project.environments.some(
            (env) =>
              env.id === config.envId &&
              env.variables.token === "fresh-token-1",
          )
        : options?.activity);
    if (!match) return originalSave.call(this, project, options);
    attempts++;
    const originalRead = this.readUnlocked;
    let readRevision;
    if (armed) {
      armed = false;
      this.readUnlocked = async function (id) {
        const previous = await originalRead.call(this, id);
        this.readUnlocked = originalRead;
        readRevision = previous.revision;
        await rename(config.history, config.kept);
        await writeFile(
          config.history,
          "owned obstacle private-password-marker",
        );
        return previous;
      };
    }
    try {
      return await originalSave.call(this, project, options);
    } catch (error) {
      await writeFile(
        config.observation + ".tmp",
        JSON.stringify({
          attempts,
          readRevision,
          typed: error instanceof ProjectCommitUncertain,
          code: error.code,
        }),
      );
      // The cancellation test polls this file without a tool response barrier.
      // Publish atomically so it cannot read a partial JSON write on any OS.
      await rename(config.observation + ".tmp", config.observation);
      throw error;
    } finally {
      this.readUnlocked = originalRead;
    }
  };
  return () => {
    store.save = originalSave;
  };
}

async function obstacle(t, f, kind, mode = "activity") {
  const directory = f.store.directory(f.project.id);
  const config = {
    projectId: f.project.id,
    envId: f.envId,
    mode,
    history: path.join(directory, "history"),
    kept: path.join(directory, "history-owned-backup"),
    observation: path.join(f.directory, "fault.json"),
  };
  let restore = () => {},
    repaired = false;
  t.after(() => restore());
  if (kind === "http") restore = installFault(f.store, config);
  else {
    const preload = path.join(f.directory, "receipt-fault.mjs");
    await writeFile(
      preload,
      [
        'import { rename, writeFile } from "node:fs/promises";',
        `import { Store } from ${JSON.stringify(new URL("../src/runtime.mjs", import.meta.url).href)};`,
        `import { ProjectCommitUncertain } from ${JSON.stringify(new URL("../src/project-commit-outcome.mjs", import.meta.url).href)};`,
        installFault.toString(),
        `installFault(Store.prototype, ${JSON.stringify(config)});`,
      ].join("\n"),
    );
    await f.connect(["--import", pathToFileURL(preload).href]);
  }
  const journalFile = path.join(directory, ".transaction.json");
  return {
    config,
    journalFile,
    observation: async () =>
      JSON.parse(await readFile(config.observation, "utf8")),
    journal: async () => JSON.parse(await readFile(journalFile, "utf8")),
    async repair() {
      restore();
      if (repaired) return;
      await rm(config.history);
      await rename(config.kept, config.history);
      repaired = true;
    },
  };
}

function unknown(projectId) {
  return {
    code: "PROJECT_COMMIT_UNCERTAIN",
    project_id: projectId,
    commit_outcome: "unknown",
    retry_safe: false,
  };
}
function privateReceipt(value, f) {
  const text = JSON.stringify(value);
  for (const hidden of [
    f.directory,
    JSON.stringify(f.directory).slice(1, -1),
    "private-password-marker",
    "ENOTDIR",
    "EISDIR",
    '"cause"',
    '"stack"',
  ])
    assert(!text.includes(hidden), hidden);
}

for (const [kind, scope, collection] of [
  ["http", "api", "history"],
  ["stdio", "flow", "runs"],
])
  test(
    `official SDK ${kind} native ${scope} keeps the attempted receipt and once-only picked scopes after journal failure`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t, kind);
      if (kind === "http") await f.connect();
      const before = await f.store.get(f.project.id),
        deniedBefore = await f.store.get(f.denied.id);
      const fault = await obstacle(t, f, kind);
      for (const [name, args] of [
        [
          "apipost_execute_api",
          { project_id: f.denied.id, target_id: f.request.id },
        ],
        [
          "localapi_execute_api",
          { projectId: f.denied.id, apiId: f.request.id },
        ],
      ])
        assert.equal((await f.call(name, args)).isError, true);
      assert.deepEqual(f.wire, []);
      const value = decode(
        await f.call("apipost_execute_" + scope, {
          project_id: f.project.id,
          environment_id: f.envId,
          ...(scope === "api"
            ? { target_id: f.request.id }
            : { flow_id: f.project.plans[0].id }),
        }),
      );
      assert.equal(value.status, "passed");
      assert.equal(value.scope, scope);
      assert.equal(value.record_saved, false);
      const observed = await fault.observation();
      assert.equal(observed.typed, true);
      assert.equal(observed.code, "PROJECT_COMMIT_UNCERTAIN");
      assert.equal(observed.attempts, 1);
      assert.equal((await stat(fault.config.history)).isFile(), true);
      const journal = await fault.journal();
      assert.equal(journal[collection].length, 1);
      const record = journal[collection][0];
      assert.equal(record.id, value.run_id);
      assert.equal(record.source, "mcp");
      const result = scope === "api" ? record : record.results[0];
      assert.equal(result.response.status, 200);
      assert.equal(result.response.body, '{"token":"fresh-token-1"}');
      assert.equal(result.response.headers["x-fixture"], "once-only");
      assert.equal(result.scopeCommit, undefined);
      assert.equal(journal.environments[0].variables.token, "fresh-token-1");
      assert.equal(
        journal.environments[0].variables.onlyThisRequest,
        undefined,
      );
      assert.deepEqual(journal.environments[1], before.environments[1]);
      assert.equal(
        journal.configRevision,
        before.configRevision + 1,
        "pickVars commits before the failing activity append",
      );
      assert.deepEqual(f.wire, [
        {
          url: "/native",
          body: '{"fixture":"native-receipt"}',
          token: "stale-target",
        },
      ]);
      // These exact new fields were dropped by the original native adapter.
      assert.equal(value.attempted_record_id, record.id);
      assert.equal(value.record_id, null);
      assert.deepEqual(value.persistence_outcome, unknown(f.project.id));
      assert.equal(typeof value.persistence_error, "string");
      privateReceipt(value, f);

      // A canonical request in another permitted project remains independently
      // executable and uses only its own environment, not the native debug cache.
      const canonical = decode(
        await f.call("localapi_execute_api", {
          projectId: f.other.id,
          apiId: "other-request",
        }),
      );
      assert.equal(canonical.status, "passed");
      assert.equal(canonical.recordSaved, true);
      assert.equal(canonical.recordId, canonical.attemptedRecordId);
      assert.equal(canonical.persistenceOutcome, undefined);
      assert.equal(canonical.variables.token, "other-project");
      assert.equal(canonical.variables.onlyThisRequest, undefined);
      assert.equal(f.wire[1].token, "other-project");
      assert.deepEqual(await f.store.get(f.denied.id), deniedBefore);
      await fault.repair();
      const recovered = await new Store(f.root).get(f.project.id);
      assert.equal(recovered[collection].length, 1);
      assert.deepEqual(recovered[collection][0], record);
      assert.equal(recovered.environments[0].variables.token, "fresh-token-1");
      await assert.rejects(readFile(fault.journalFile), { code: "ENOENT" });
      await f.connect(); // Actual new stdio process, or new official HTTP SDK session.
      const detail = decode(
        await f.call("apipost_get_execution_result", {
          project_id: f.project.id,
          run_id: value.attempted_record_id,
        }),
      );
      assert.equal(detail.run.run_id, record.id);
      assert.deepEqual(
        scope === "api" ? detail.run.response : detail.run.results[0].response,
        result.response,
      );
      assert.deepEqual(await new Store(f.root).get(f.project.id), recovered);
      assert.equal((await fault.observation()).attempts, 1);
      assert.equal(f.wire.length, 2);
      assert(!f.stderr.join("").includes("private-password-marker"));
    },
  );

for (const repairBeforeHistory of [true, false])
  test(
    `manual pickVars scope uncertainty remains distinct from ${repairBeforeHistory ? "confirmed" : "unconfirmed"} history persistence`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, "http");
      const before = await f.store.get(f.project.id);
      const fault = await obstacle(t, f, "http", "scope");
      const originalAppend = f.store.append;
      let appendAttempts = 0,
        scopeJournal,
        recordAttempt;
      f.store.append = async function (projectId, field, record, ...rest) {
        if (projectId === f.project.id && field === "history") {
          appendAttempts++;
          // Persisted evidence is JSON; absent optional fields are not emitted.
          recordAttempt = JSON.parse(JSON.stringify(record));
          scopeJournal = await fault.journal();
          // Boundary orchestration, not a fabricated successful append: remove
          // only our obstacle, then let the original append recover and save.
          if (repairBeforeHistory) await fault.repair();
        }
        return originalAppend.call(this, projectId, field, record, ...rest);
      };
      t.after(() => {
        f.store.append = originalAppend;
      });
      const value = await f.post(`/api/projects/${f.project.id}/execute`, {
        runId: "manual-scope-receipt-attempt",
        environmentId: f.envId,
        request: f.request,
      });
      assert.equal(appendAttempts, 1);
      assert.equal((await fault.observation()).attempts, 1);
      assert.equal((await fault.observation()).typed, true);
      assert.equal(scopeJournal.history.length, 0);
      assert.equal(
        scopeJournal.environments[0].variables.token,
        "fresh-token-1",
      );
      assert.equal(scopeJournal.configRevision, before.configRevision + 1);
      assert.deepEqual(recordAttempt.scopeCommit, {
        outcome: "unknown",
        retrySafe: false,
      });
      assert.equal(recordAttempt.response.status, 200);
      assert.equal(recordAttempt.response.body, '{"token":"fresh-token-1"}');
      assert.equal(value.status, 200);
      assert.equal(value.body, recordAttempt.response.body);
      assert.equal(value.headers["x-fixture"], "once-only");
      assert.equal(value.outcome, "failed");
      assert.equal(
        value.error,
        "变量持久化提交未确认；请重新读取项目，勿自动重试已完成请求",
      );
      assert.equal(value.variableWrites.commits, 0);
      assert.equal(value.extracted.token, "stale-target");
      assert.equal(value.attemptedRecordId, recordAttempt.id);
      assert.equal(value.recordSaved, repairBeforeHistory);
      if (repairBeforeHistory) {
        assert.equal(value.recordId, recordAttempt.id);
        assert.equal(value.persistenceOutcome, undefined);
        assert.equal(value.persistenceError, undefined);
      } else {
        assert.equal(value.recordId, null);
        assert.deepEqual(value.persistenceOutcome, unknown(f.project.id));
      }
      // Execution scopes and history acknowledgement are independent receipts.
      // Neither saving the history nor failing it resolves the earlier scope error.
      assert.deepEqual(value.scopeCommit, {
        outcome: "unknown",
        retrySafe: false,
      });
      privateReceipt(
        {
          persistenceError: value.persistenceError,
          persistenceOutcome: value.persistenceOutcome,
        },
        f,
      );
      await fault.repair();
      const recovered = await new Store(f.root).get(f.project.id);
      assert.equal(recovered.environments[0].variables.token, "fresh-token-1");
      assert.equal(
        recovered.environments[0].variables.onlyThisRequest,
        undefined,
      );
      assert.deepEqual(recovered.environments[1], before.environments[1]);
      assert.equal(recovered.history.length, repairBeforeHistory ? 1 : 0);
      if (repairBeforeHistory) {
        assert.equal(recovered.history[0].id, value.recordId);
        assert.deepEqual(recovered.history[0].scopeCommit, value.scopeCommit);
        assert.deepEqual(recovered.history[0].response, recordAttempt.response);
      } else {
        assert(
          !recovered.history.some(
            (item) => item.id === value.attemptedRecordId,
          ),
        );
      }
      await assert.rejects(readFile(fault.journalFile), { code: "ENOENT" });
      assert.deepEqual(await new Store(f.root).get(f.project.id), recovered);
      assert.deepEqual(f.wire, [
        {
          url: "/native",
          body: '{"fixture":"native-receipt"}',
          token: "stale-target",
        },
      ]);
    },
  );

test(
  "official SDK stdio native cancellation reconciles the same journaled run without replay or later HTTP",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "stdio");
    const started = Promise.withResolvers(),
      release = Promise.withResolvers();
    f.beforeRespond(async () => {
      started.resolve();
      await release.promise;
    });
    t.after(() => release.resolve());
    const state = await f.store.get(f.project.id);
    state.plans = [
      snapshotPlan({
        ...state.plans[0],
        steps: [
          { request: f.request },
          {
            request: normalizeRequest({
              id: "must-not-run",
              name: "No later request",
              url: f.request.url.replace("/native", "/later"),
            }),
          },
        ],
      }),
    ];
    await f.store.save(state);
    const before = await f.store.get(f.project.id),
      otherBefore = await f.store.get(f.other.id);
    const fault = await obstacle(t, f, "stdio");
    const controller = new AbortController();
    // Client cancellation intentionally suppresses a success/tool response. Do not
    // invent a returned receipt: reconcile the single attempted ID from its real
    // journal, then read it through the official native result tool after recovery.
    const rejected = assert.rejects(
      f.call(
        "apipost_execute_flow",
        {
          project_id: f.project.id,
          flow_id: state.plans[0].id,
          environment_id: f.envId,
        },
        { signal: controller.signal },
      ),
      /abort|cancel/i,
    );
    await started.promise;
    controller.abort();
    await rejected;
    const deadline = Date.now() + 10000;
    let observed;
    while (!observed) {
      try {
        observed = await fault.observation();
      } catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(observed.typed, true);
    assert.equal(observed.code, "PROJECT_COMMIT_UNCERTAIN");
    assert.equal(observed.attempts, 1);
    const journal = await fault.journal();
    assert.equal(journal.runs.length, 1);
    const cancelled = journal.runs[0];
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.source, "mcp");
    assert.equal(cancelled.results.length, 1);
    assert.equal(cancelled.results[0].response, undefined);
    assert.equal(cancelled.results[0].scopeCommit, undefined);
    assert.equal(journal.configRevision, before.configRevision);
    assert.deepEqual(journal.environments, before.environments);
    assert.equal(f.wire.length, 1);
    assert.equal(f.wire[0].url, "/native");
    release.resolve();
    await f.client.ping();
    await fault.repair();
    const recovered = await new Store(f.root).get(f.project.id);
    assert.deepEqual(recovered.runs, [cancelled]);
    await f.connect();
    const detail = decode(
      await f.call("apipost_get_execution_result", {
        project_id: f.project.id,
        run_id: cancelled.id,
      }),
    );
    assert.equal(detail.run.run_id, cancelled.id);
    assert.equal(detail.run.status, "cancelled");
    assert.deepEqual(detail.run.results, cancelled.results);
    assert.deepEqual(await new Store(f.root).get(f.project.id), recovered);
    assert.deepEqual(await f.store.get(f.other.id), otherBefore);
    assert.equal((await fault.observation()).attempts, 1);
    assert.equal(f.wire.length, 1);
  },
);
