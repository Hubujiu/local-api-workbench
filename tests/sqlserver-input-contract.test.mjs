import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareSQLServerReadInput as prepare } from "../src/sqlserver-input-contract.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
const secret = "FICTIONAL_PRIVATE_INPUT_SENTINEL";
const input = () => ({
  type: "sqlserver",
  host: "fixture.invalid",
  user: "用户😀",
  password: secret,
  database: "库😀",
  ssl: true,
  sql: "SELECT id FROM dbo.fixture WHERE id = @p0",
  parameters: [{ type: "int64", value: "9223372036854775807" }],
});
const rejected = async (value) =>
  assert.rejects(
    prepare(value),
    (e) =>
      e.message === "SQL Server input contract: invalid read input" &&
      !e.stack.includes(secret),
  );
test("inert adapter projects only connection fields, preserves exact parameters and explicit TLS", async () => {
  const value = input(),
    pending = prepare(value);
  value.password = "changed";
  value.parameters[0].value = "0";
  const { config, plan } = await pending;
  assert.equal(config.options.port, 1433);
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal(config.authentication.options.password, secret);
  assert.equal(config.authentication.options.userName, "用户😀");
  assert.equal(config.options.database, "库😀");
  assert.equal(plan.parameters[0].value, "9223372036854775807");
  assert.deepEqual(Object.keys(config).sort(), [
    "authentication",
    "options",
    "server",
  ]);
  for (const port of [1, 1433, 65535])
    assert.equal(
      (await prepare({ ...input(), port })).config.options.port,
      port,
    );
});
test("strict fields reject authority/transport extras and hostile data without invoking code", async () => {
  for (const key of [
    "allowWrite",
    "ssh",
    "name",
    "bindingId",
    "filename",
    "authSource",
    "url",
    "factory",
    "timeout",
    "__proto__",
  ])
    await rejected(
      Object.defineProperty(input(), key, { value: secret, enumerable: true }),
    );
  let hits = 0;
  await rejected(
    Object.defineProperty(input(), "host", {
      get() {
        hits++;
        throw Error(secret);
      },
    }),
  );
  await rejected(
    new Proxy(input(), {
      getPrototypeOf() {
        hits++;
        throw Error(secret);
      },
    }),
  );
  const p = Proxy.revocable(input(), {});
  p.revoke();
  await rejected(p.proxy);
  assert.equal(hits, 0);
  await rejected(Object.assign(Object.create(null), input()));
  await rejected({ ...input(), type: "mssql" });
});
test("defaults are deliberate and unsafe TLS, credentials and parameters are redacted", async () => {
  for (const port of [
    null,
    0,
    "",
    "1433",
    true,
    [],
    {},
    NaN,
    Infinity,
    1.5,
    -1,
    65536,
  ])
    await rejected({ ...input(), port });
  for (const ssl of [undefined, false, 1, "true"])
    await rejected({ ...input(), ssl });
  for (const key of ["host", "user", "password", "database", "ca"])
    for (const value of [undefined, secret + "\ud800", secret + "\0", {}]) {
      if (key === "ca" && value === undefined) continue;
      await rejected({ ...input(), [key]: value });
    }
  for (const value of [
    9007199254740992,
    1.1,
    { type: "int64", value: "9223372036854775808" },
    secret + "\ud800",
  ])
    await rejected({ ...input(), parameters: [value] });
  for (const value of [
    null,
    true,
    -2147483648,
    2147483647,
    "文本😀",
    { type: "int64", value: "-9223372036854775808" },
  ]) {
    const r = await prepare({ ...input(), parameters: [value] });
    assert.equal(
      r.plan.parameters[0].value,
      typeof value === "object" && value !== null ? value.value : value,
    );
  }
});
test("pre-abort touches no input; abort during compilation discards candidate without reason leak", async () => {
  const c = new AbortController();
  c.abort(secret);
  await assert.rejects(
    prepare(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Error(secret);
          },
        },
      ),
      { signal: c.signal },
    ),
    { name: "AbortError", message: "SQL Server input contract: cancelled" },
  );
  const d = new AbortController(),
    pending = prepare(input(), { signal: d.signal });
  d.abort(secret);
  await assert.rejects(pending, {
    name: "AbortError",
    message: "SQL Server input contract: cancelled",
  });
  assert.ok((await prepare(input())).plan);
});
test("public dispatch, session, MCP and CLI grants still reject SQL Server; UI remains closed", async () => {
  await assert.rejects(queryRemoteDatabase(input()), /数据库类型无效/);
  const sessions = new DatabaseSessions();
  assert.throws(
    () => sessions.register("p", { ...input(), name: "fixture" }),
    /数据库类型无效/,
  );
  assert.deepEqual(sessions.list("p"), []);
  const grants = new MCPDatabaseGrants(() => ({
    enabled: true,
    write: true,
    execute: true,
    projects: ["p"],
  }));
  const { sql, parameters, ...connection } = input();
  assert.throws(
    () => grants.register({ id: "p" }, { ...connection, name: "fixture" }),
    /数据库类型无效/,
  );
  assert.deepEqual(grants.list("p"), []);
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        {
          steps: [
            {
              request: {
                before: [{ type: "database", connectionId: "fixture" }],
              },
            },
          ],
        },
        { fixture: connection },
      ),
    /CLI/,
  );
  for (const file of [
    "server.mjs",
    "remote-database.mjs",
    "database-sessions.mjs",
    "mcp.mjs",
    "mcp-stdio-database-grants.mjs",
    "cli-database-grants.mjs",
  ])
    assert.doesNotMatch(
      await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      /sqlserver-(?:input-contract|prep-process|read-prep|tedious-prep)/,
    );
  assert.doesNotMatch(
    await readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    /<option value="(?:sqlserver|mssql)"/,
  );
});

test("owner HTTP read/write/register and MCP stdio reject without enabling provider", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { loadMCPStdioDatabaseGrants } = await import(
    "../src/mcp-stdio-database-grants.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "sqlserver-inert-entry-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("Inert SQL Server");
  for (const [action, body] of [
    ["database", input()],
    ["database", { ...input(), allowWrite: true }],
    ["database-connections", { ...input(), name: "fixture" }],
  ]) {
    const r = await fetch(`${app.url}/api/projects/${project.id}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400);
    const result = await r.text();
    assert.ok(!result.includes(secret));
  }
  const { sql, parameters, ...connection } = input();
  const file = join(root, "grants.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      projects: [
        { projectId: project.id, databaseConnections: { fixture: connection } },
      ],
    }),
    { mode: 0o600 },
  );
  let resolutions = 0;
  await assert.rejects(
    loadMCPStdioDatabaseGrants(file, {
      projects: [project.id],
      write: true,
      execute: true,
      resolveProject: async () => {
        resolutions++;
        return project;
      },
    }),
    (e) =>
      e.code === "MCP_STDIO_DATABASE_GRANTS_INVALID" &&
      !String(e).includes(secret),
  );
  assert.equal(resolutions, 0);
});
