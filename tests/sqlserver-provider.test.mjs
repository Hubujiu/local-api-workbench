import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
const connection = {
  type: "sqlserver",
  host: "127.0.0.1",
  user: "inert",
  password: "TEST_ONLY_SECRET",
  database: "inert",
  ssl: true,
};
const request = {
  ...connection,
  sql: "SELECT id FROM dbo.items",
  parameters: [],
};
function gate(t, value) {
  const before = process.env.LOCALAPI_SQLSERVER_PREVIEW;
  if (value === undefined) delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
  else process.env.LOCALAPI_SQLSERVER_PREVIEW = value;
  t.after(() => {
    if (before === undefined) delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
    else process.env.LOCALAPI_SQLSERVER_PREVIEW = before;
  });
}
test("host gate defaults closed and cannot be enabled by requests or grants", async (t) => {
  gate(t, undefined);
  for (const flag of [undefined, "true", "1", "READ-ONLY"]) {
    if (flag === undefined) delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
    else process.env.LOCALAPI_SQLSERVER_PREVIEW = flag;
    await assert.rejects(queryRemoteDatabase({ ...request, preview: true }), {
      code: "SQLSERVER_PREVIEW_DISABLED",
    });
    assert.throws(
      () =>
        new DatabaseSessions().register("p", {
          ...connection,
          name: "fixture",
        }),
      { code: "SQLSERVER_PREVIEW_DISABLED" },
    );
  }
});
test("preview still rejects write, arbitrary SQL, insecure TLS, SSH and driver options", async (t) => {
  gate(t, "read-only");
  for (const change of [
    { sql: "DELETE FROM dbo.items" },
    { sql: "SELECT @@VERSION" },
    { ssl: false },
    { allowWrite: true },
    { exactOutput: false },
    { trustServerCertificate: true },
    { connectionString: "ignored" },
    { ssh: {} },
    { port: 0 },
  ])
    await assert.rejects(queryRemoteDatabase({ ...request, ...change }));
  const sessions = new DatabaseSessions();
  for (const change of [
    { ssl: false },
    { port: 0 },
    { ssh: {} },
    { trustServerCertificate: true },
    { authSource: "x" },
    { filename: "x" },
  ])
    assert.throws(() =>
      sessions.register("p", { ...connection, name: "fixture", ...change }),
    );
  sessions.close();
});
test("MCP preview remains explicit project-scoped ephemeral authority", async (t) => {
  gate(t, "read-only");
  let policy = { enabled: true, write: true, execute: true, projects: ["p"] };
  const grants = new MCPDatabaseGrants(() => policy);
  const g = grants.register({ id: "p" }, { ...connection, name: "fixture" });
  assert.equal(g.type, "sqlserver");
  assert.ok(!JSON.stringify(grants.list("p")).includes(connection.password));
  assert.throws(() => grants.list("other"));
  policy = { ...policy, execute: false };
  assert.throws(() => grants.list("p"));
  grants.invalidate();
});
test("disabling preview blocks previously issued sessions without reconnecting", async (t) => {
  gate(t, "read-only");
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  const grant = sessions.register("p", { ...connection, name: "fixture" });
  delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
  await assert.rejects(
    sessions.query("p", {
      connectionId: grant.id,
      sql: request.sql,
      parameters: [],
    }),
    { code: "SQLSERVER_PREVIEW_DISABLED" },
  );
});
async function inertEndpoint(t, onConnect) {
  let count = 0,
    closed = false,
    resolveClosed;
  const closure = new Promise((r) => (resolveClosed = r));
  const sockets = new Set();
  const server = createServer((s) => {
    count++;
    sockets.add(s);
    s.on("error", () => {});
    s.on("data", () => {}); // no TDS/TLS replies, no database or login service
    s.on("close", () => {
      sockets.delete(s);
      closed = true;
      resolveClosed();
    });
    onConnect();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return {
    port: server.address().port,
    closure,
    get count() {
      return count;
    },
    get closed() {
      return closed;
    },
  };
}
test("public dispatcher uses actual owned process and cancellation closes inert TCP endpoint", async (t) => {
  gate(t, "read-only");
  const controller = new AbortController();
  const endpoint = await inertEndpoint(t, () => controller.abort());
  await assert.rejects(
    queryRemoteDatabase(
      { ...request, port: endpoint.port },
      { signal: controller.signal },
    ),
    { code: "SQLSERVER_PREP_CANCELLED" },
  );
  await endpoint.closure;
  assert.equal(endpoint.count, 1);
  assert.equal(endpoint.closed, true);
});
test("revoking a public session aborts actual owned SQL Server process, no replay", async (t) => {
  gate(t, "read-only");
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  let grant;
  const endpoint = await inertEndpoint(t, () => sessions.revoke("p", grant.id));
  grant = sessions.register("p", {
    ...connection,
    port: endpoint.port,
    name: "fixture",
  });
  await assert.rejects(
    sessions.query("p", {
      connectionId: grant.id,
      sql: request.sql,
      parameters: [],
    }),
    /撤销/,
  );
  await endpoint.closure;
  assert.equal(endpoint.count, 1);
  assert.deepEqual(sessions.list("p"), []);
});
test("owner HTTP exposes only gated registration; writes and malformed reads remain denied", async (t) => {
  gate(t, "read-only");
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(join(tmpdir(), "sqlserver-preview-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("SQL Server preview");
  const send = (action, body, token = app.token) =>
    fetch(`${app.url}/api/projects/${project.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-local-token": token },
      body: JSON.stringify(body),
    });
  const registered = await send("database-connections", {
    ...connection,
    name: "fixture",
  });
  assert.equal(registered.status, 200);
  assert.ok(!(await registered.text()).includes(connection.password));
  for (const body of [
    { ...request, allowWrite: true },
    { ...request, sql: "EXEC sp_help" },
  ]) {
    const r = await send("database", body);
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes(connection.password));
  }
  const controller = new AbortController();
  const endpoint = await inertEndpoint(t, () => controller.abort());
  await assert.rejects(
    fetch(`${app.url}/api/projects/${project.id}/database`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify({ ...request, port: endpoint.port }),
    }),
    { name: "AbortError" },
  );
  await endpoint.closure;
  assert.equal(endpoint.count, 1);
  const denied = await send(
    "database-connections",
    { ...connection, name: "fixture" },
    "wrong",
  );
  assert.notEqual(denied.status, 200);
});
