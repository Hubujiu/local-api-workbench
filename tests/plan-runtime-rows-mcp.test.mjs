import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server.mjs";
import { readMCPActivities } from "../src/mcp-activity.mjs";

const decode = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
import { snapshotPlan } from "../src/core.mjs";
import { createMCP } from "../src/mcp.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
import { createMCPStdioContext } from "../src/mcp-stdio-bootstrap.mjs";
import { DatabaseSync } from "node:sqlite";
const literal = (value) => ({ literal: value });
const rows = (steps, extra = {}) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 3,
  steps,
  ...extra,
});
const gate = (left, right, steps) => ({
  id: "gate",
  type: "if",
  condition: { left, op: "eq", right },
  steps,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-rows-mcp-"));
  const app = await createApp({ root, port: 0 });
  const clients = [],
    seen = [];
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        items: req.url === "/empty" ? [] : [{ name: "a" }, { name: "b" }],
      }),
    );
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    app.server.closeAllConnections();
    peer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => peer.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const allowed = await app.store.create("IF SDK allowed");
  const denied = await app.store.create("IF SDK denied");
  denied.globalVariables = { foreignOnly: 1 };
  await app.store.save(denied);
  const owner = async (route, body, method = "POST") => {
    const response = await fetch(app.url + "/api/" + route, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const configure = async (options = {}) => {
    const response = await owner("mcp/config", {
      enabled: true,
      projects: [allowed.id],
      write: true,
      execute: true,
      remember: false,
      ...options,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return response.value;
  };
  const connect = async (transport = "http", options = {}) => {
    const client = new Client({
      name: "canonical-if-fixture",
      version: "1.0.0",
    });
    clients.push(client);
    if (transport === "http") {
      const config = await configure(options);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
        { timeout: 5000 },
      );
    } else {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(import.meta.dirname, "../src/mcp.mjs"),
            "--project",
            allowed.id,
            "--write",
            "--execute",
          ],
          env: { ...process.env, LOCAL_API_DATA: root },
          stderr: "pipe",
        }),
        { timeout: 5000 },
      );
    }
    return client;
  };
  const call = (client, name, args) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
  const leaf = (id, target = "/must-not-run") => ({
    id,
    request: {
      name: id,
      method: "GET",
      url: `http://127.0.0.1:${peer.address().port}${target}`,
    },
  });
  const activity = async (planId) => {
    const config = await owner("mcp/config", undefined, "GET");
    assert.equal(config.status, 200);
    const found = config.value.activities.find(
      (entry) =>
        entry.tool === "localapi_run_plan" &&
        entry.projectId === allowed.id &&
        entry.planId === planId,
    );
    assert.ok(found, JSON.stringify(config.value.activities));
    return found;
  };
  return {
    root,
    app,
    allowed,
    denied,
    seen,
    owner,
    connect,
    call,
    leaf,
    activity,
  };
}

async function seed(f, id, steps, variables = {}) {
  const p = await f.app.store.get(f.allowed.id);
  p.environments[0].variables = variables;
  p.plans.push(
    snapshotPlan({ id, name: id, steps }, { allowRuntimeRows: true }),
  );
  await f.app.store.save(p);
  return id;
}
const args = (f, planId) => ({ projectId: f.allowed.id, planId });

for (const transport of ["http", "stdio"])
  test(
    `official SDK ${transport} executes runtime rows and reports potential terminal progress for empty rows`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const client = await f.connect(transport);
      for (const [id, target, expected] of [
        ["nonempty", "/produce", 3],
        ["empty", "/empty", 1],
      ]) {
        await seed(f, id, [
          {
            ...f.leaf("producer", target),
            request: {
              ...f.leaf("producer", target).request,
              extract: [{ name: "items", source: "json", path: "$.items" }],
            },
          },
          rows([
            {
              ...f.leaf("child", "/child/{{name}}"),
              request: {
                ...f.leaf("child", "/child/{{name}}").request,
                beforeScript:
                  "pm.environment.set('name',pm.iterationData.get('name'));",
              },
            },
          ]),
        ]);
        const result = decode(
          await f.call(client, "localapi_run_plan", args(f, id)),
        );
        assert.equal(result.status, "passed", JSON.stringify(result));
        assert.equal(result.recordSaved, true);
        assert.equal(result.results.length, expected);
        assert.equal(result.conditionResults, undefined);
        const activity =
          transport === "http"
            ? await f.activity(id)
            : (await readMCPActivities(f.root)).find(
                (entry) => entry.planId === id && entry.source === "stdio",
              );
        assert.equal(activity.finished, true);
        assert.equal(activity.totalIsPotential, true);
        assert.equal(activity.total, 4);
        assert.equal(activity.completed, expected);
      }
      await seed(f, "zero", [rows([f.leaf("no-run")])], { items: [] });
      const zero = decode(
        await f.call(client, "localapi_execute_flow", args(f, "zero")),
      );
      assert.equal(zero.results.length, 0);
      assert.equal(zero.status, "failed");
      assert.equal(zero.stopReason, "runtime-rows-error");
      const activities =
        transport === "http"
          ? (await f.owner("mcp/config", undefined, "GET")).value.activities
          : await readMCPActivities(f.root);
      const final = activities.find(
        (entry) =>
          entry.planId === "zero" && entry.tool === "localapi_execute_flow",
      );
      assert.equal(final.finished, true);
      assert.equal(final.completed, 0);
      assert.equal(final.total, 3);
      assert.equal(final.totalIsPotential, true);
      assert.equal(f.seen.length, 4);
    },
  );

for (const transport of ["http", "stdio"])
  test(
    `official SDK ${transport} preflights empty and false DB branches before producer side effects`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const client = await f.connect(transport);
      const dbChild = f.leaf("database-child");
      dbChild.request.before = [
        {
          type: "database",
          connectionId: "not-granted",
          sql: "SELECT 1",
          name: "dbResult",
          parameters: [],
        },
      ];
      await seed(
        f,
        "denied-db",
        [
          f.leaf("producer", "/must-not-run"),
          rows([gate(literal(false), literal(true), [dbChild])]),
        ],
        { items: [] },
      );
      const result = await f.call(
        client,
        "localapi_run_plan",
        args(f, "denied-db"),
      );
      assert.equal(result.isError, true);
      assert.deepEqual(f.seen, []);
      assert.deepEqual((await f.app.store.get(f.allowed.id)).runs, []);
      assert.equal(
        (
          await f.call(client, "localapi_run_plan", {
            ...args(f, "denied-db"),
            projectId: f.denied.id,
          })
        ).isError,
        true,
      );
      assert.deepEqual(f.seen, []);
    },
  );

test("canonical MCP uses project scoped grant preflight and rejects revoked authority without any request", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, "fixture.db");
  new DatabaseSync(filename).close();
  const policy = {
    enabled: true,
    write: true,
    execute: true,
    projects: [f.allowed.id],
  };
  const grants = new MCPDatabaseGrants(
    () => policy,
    (id) => f.app.store.get(id),
  );
  t.after(() => grants.invalidate());
  const epoch = grants.capture();
  const connection = grants.register(
    f.allowed,
    { name: "db", type: "sqlite", filename },
    epoch,
  );
  const child = f.leaf("db-child", "/db");
  child.request.before = [
    {
      type: "database",
      connectionId: connection.id,
      sql: "SELECT 1",
      name: "dbResult",
      parameters: [],
    },
  ];
  await seed(f, "db", [rows([child])], { items: [] });
  const progress = [];
  const dispatch = createMCP({
    store: f.app.store,
    projects: [f.allowed.id],
    write: true,
    execute: true,
    databaseExecutor: (id, op, signal) => grants.query(epoch, id, op, signal),
    databasePreflight: (id, ids, signal) =>
      grants.preflight(epoch, id, ids, signal),
    onProgress: (event) => progress.push(event),
  });
  const invoke = () =>
    dispatch({
      id: 1,
      method: "tools/call",
      params: { name: "localapi_run_plan", arguments: args(f, "db") },
    });
  const first = decode((await invoke()).result);
  assert.equal(first.status, "failed", JSON.stringify(first));
  assert.equal(first.stopReason, "runtime-rows-error");
  assert.equal(progress.at(-1).finished, true);
  grants.revoke(f.allowed.id, connection.id, epoch);
  assert.equal((await invoke()).result.isError, true);
  assert.deepEqual(f.seen, []);
  assert.equal((await f.app.store.get(f.allowed.id)).runs.length, 1);
});

test("stdio grants preflight maps aliases as one batch and close revokes authority", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, "fixture.db");
  new DatabaseSync(filename).close();
  const grantfile = path.join(f.root, "grants.json");
  await writeFile(
    grantfile,
    JSON.stringify({
      version: 1,
      projects: [
        {
          projectId: f.allowed.id,
          databaseConnections: { alias: { type: "sqlite", filename } },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const context = await createMCPStdioContext(
    [
      "--project",
      f.allowed.id,
      "--write",
      "--execute",
      "--database-grants-file",
      grantfile,
    ],
    f.root,
  );
  t.after(() => context.close());
  await context.databasePreflight(f.allowed.id, ["alias"]);
  await assert.rejects(
    context.databasePreflight(f.allowed.id, ["alias", "missing"]),
    /未获本次授权/,
  );
  await assert.rejects(
    context.databasePreflight(f.denied.id, ["alias"]),
    /未获本次授权/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    context.databasePreflight(f.allowed.id, ["alias"], controller.signal),
    /取消/,
  );
  context.close();
  await assert.rejects(
    context.databasePreflight(f.allowed.id, ["alias"]),
    /已关闭/,
  );
});

for (const transport of ["http", "stdio"])
  test(
    `official SDK ${transport} executes granted runtime-row DB operations without ambient credentials`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t);
      const filename = path.join(f.root, "granted.db");
      new DatabaseSync(filename).close();
      let client, connectionId;
      if (transport === "http") {
        client = await f.connect();
        const grant = await f.owner(
          `projects/${f.allowed.id}/mcp-database-connections`,
          { name: "fixture", type: "sqlite", filename },
        );
        assert.equal(grant.status, 200, JSON.stringify(grant));
        connectionId = grant.value.id;
      } else {
        connectionId = "ownerAlias";
        const grantfile = path.join(f.root, "owner.json");
        await writeFile(
          grantfile,
          JSON.stringify({
            version: 1,
            projects: [
              {
                projectId: f.allowed.id,
                databaseConnections: {
                  [connectionId]: { type: "sqlite", filename },
                },
              },
            ],
          }),
          { mode: 0o600 },
        );
        client = new Client({ name: "rows-granted", version: "1" });
        t.after(() => client.close());
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, "../src/mcp.mjs"),
              "--project",
              f.allowed.id,
              "--write",
              "--execute",
              "--database-grants-file",
              grantfile,
            ],
            env: { ...process.env, LOCAL_API_DATA: f.root },
            stderr: "pipe",
          }),
        );
      }
      const producer = f.leaf("producer", "/produce");
      producer.request.extract = [
        { name: "items", source: "json", path: "$.items" },
      ];
      const child = f.leaf("child", "/db-child");
      child.request.before = [
        {
          type: "database",
          connectionId,
          sql: "SELECT 1",
          name: "dbResult",
          parameters: [],
        },
      ];
      await seed(f, "granted", [producer, rows([child])]);
      const run = decode(
        await f.call(client, "localapi_run_plan", args(f, "granted")),
      );
      assert.equal(run.status, "passed", JSON.stringify(run));
      assert.equal(run.recordSaved, true);
      assert.equal(run.results.length, 3);
      assert.deepEqual(f.seen, ["/produce", "/db-child", "/db-child"]);
      if (transport === "http") {
        const revoke = await f.owner(
          `projects/${f.allowed.id}/mcp-database-connections`,
          { id: connectionId },
          "DELETE",
        );
        assert.equal(revoke.status, 200);
        assert.equal(
          (await f.call(client, "localapi_run_plan", args(f, "granted")))
            .isError,
          true,
        );
        assert.equal(f.seen.length, 3);
      }
    },
  );

for (const outcome of ["failed", "unknown", "cancelled", "progress"])
  test(`canonical MCP runtime rows preserves ${outcome} evidence without replay`, async (t) => {
    const f = await fixture(t);
    const producer = f.leaf("producer", "/produce");
    producer.request.extract = [
      { name: "items", source: "json", path: "$.items" },
    ];
    await seed(f, "evidence", [producer, rows([f.leaf("child", "/child")])]);
    const controller = new AbortController();
    const original = f.app.store.append.bind(f.app.store);
    let saves = 0;
    f.app.store.append = async (...values) => {
      saves++;
      if (outcome === "failed") throw Error("test storage failure");
      if (outcome === "unknown") {
        const { ProjectCommitUncertain } = await import(
          "../src/project-commit-outcome.mjs"
        );
        throw new ProjectCommitUncertain(
          f.allowed.id,
          Error("test unknown commit"),
        );
      }
      return original(...values);
    };
    const dispatch = createMCP({
      store: f.app.store,
      projects: [f.allowed.id],
      write: true,
      execute: true,
      onProgress: (progress) => {
        if (outcome === "cancelled" && progress.completed === 1)
          controller.abort();
        if (outcome === "progress") throw Error("test reporter failure");
      },
    });
    const rpc = await dispatch(
      {
        id: 1,
        method: "tools/call",
        params: { name: "localapi_run_plan", arguments: args(f, "evidence") },
      },
      { signal: controller.signal },
    );
    const run = decode(rpc.result);
    assert.equal(saves, 1);
    assert.equal(
      f.seen.length,
      ["cancelled", "progress"].includes(outcome) ? 1 : 3,
    );
    assert.equal(run.results[0].response.status, 200);
    if (["failed", "unknown"].includes(outcome)) {
      assert.equal(run.recordSaved, false);
      assert.equal(run.persistenceOutcome.retry_safe, false);
      if (outcome === "unknown")
        assert.equal(run.persistenceOutcome.commit_outcome, "unknown");
    } else {
      assert.equal(run.recordSaved, true);
      assert.equal(
        run.status,
        outcome === "cancelled" ? "cancelled" : "failed",
      );
    }
  });

test("native MCP refuses runtime rows before executing a canonical stored plan", async (t) => {
  const f = await fixture(t);
  await seed(f, "native-denied", [f.leaf("producer"), rows([f.leaf("child")])]);
  const client = await f.connect();
  const result = await f.call(client, "apipost_execute_flow", {
    project_id: f.allowed.id,
    flow_id: "native-denied",
  });
  assert.equal(result.isError, true);
  assert.deepEqual(f.seen, []);
  assert.deepEqual((await f.app.store.get(f.allowed.id)).runs, []);
});

test("canonical MCP admits disabled runtime graphs with an active sibling and freezes live row children", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  await seed(f, "disabled", [
    f.leaf("sibling", "/sibling"),
    rows([f.leaf("never")], { enabled: false }),
  ]);
  const zero = decode(
    await f.call(client, "localapi_run_plan", args(f, "disabled")),
  );
  assert.equal(zero.status, "passed");
  assert.equal(zero.results.length, 1);
  assert.equal(zero.conditionResults, undefined);
  const activity = await f.activity("disabled");
  assert.equal(activity.finished, true);
  assert.equal(activity.totalIsPotential, true);
  assert.equal(activity.total, 1);
  assert.equal(activity.completed, 1);
  const p = await f.app.store.get(f.allowed.id);
  p.requests.push({
    ...f.leaf("live-source", "/live").request,
    id: "live-source",
  });
  await f.app.store.save(p);
  const producer = f.leaf("producer", "/produce");
  producer.request.extract = [
    { name: "items", source: "json", path: "$.items" },
  ];
  await seed(f, "live", [
    producer,
    rows([{ ...f.leaf("child", "/stale"), liveRequestId: "live-source" }]),
  ]);
  const live = decode(
    await f.call(client, "localapi_execute_flow", args(f, "live")),
  );
  assert.equal(live.status, "passed", JSON.stringify(live));
  assert.equal(live.liveBindings.length, 1);
  assert.deepEqual(f.seen, ["/sibling", "/produce", "/live", "/live"]);
});
