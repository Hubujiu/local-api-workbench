import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
import { loadMCPStdioDatabaseGrants } from "../src/mcp-stdio-database-grants.mjs";

const binding = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20),
  secret = "FICTIONAL_STDIO_CREDENTIAL_DO_NOT_PRINT",
  pg = {
    type: "postgres",
    host: "fictional.example.invalid",
    database: "fixture",
    user: "fictional",
    password: secret,
    ssl: false,
  },
  ssh = {
    host: "fictional-ssh.example.invalid",
    username: "fictional",
    password: secret,
    hostKeySHA256:
      "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
  };
const envelope = (databaseConnections, projectId = "p") => ({
  version: 1,
  projects: [{ projectId, databaseConnections }],
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "mcp-stdio-grants-")),
    filename = path.join(root, "owner-private.json"),
    database = path.join(root, "fixture.db");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE values_fixture(value INTEGER); INSERT INTO values_fixture VALUES(7)",
  );
  db.close();
  const config = { type: "sqlite", filename: database },
    projects = new Map([
      [
        "p",
        {
          id: "p",
          settings: { apipostDatabases: [{ id: binding, type: "postgres" }] },
        },
      ],
      ["q", { id: "q", settings: { apipostDatabases: [] } }],
    ]),
    options = {
      projects: ["p", "q"],
      write: true,
      execute: true,
      resolveProject: async (id) => projects.get(id),
    };
  async function write(value) {
    await fs.writeFile(
      filename,
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
      { mode: 0o600 },
    );
    return filename;
  }
  return { root, filename, database, config, projects, options, write };
}
function redacted(error, extra = []) {
  assert.equal(error.code, "MCP_STDIO_DATABASE_GRANTS_INVALID");
  for (const value of [secret, ...extra])
    assert.equal(String(error).includes(value), false);
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}
const query = {
  connectionId: "fixture",
  sql: "SELECT value FROM values_fixture",
  parameters: [],
};

test("startup grants reuse CLI connection maps with real SQLite, project isolation, copied allowlist and deterministic close", async (t) => {
  const f = await fixture(t);
  await f.write(envelope({ fixture: f.config }));
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  t.after(() => grants.close());
  assert.deepEqual(Object.keys(grants), ["query", "close"]);
  assert.equal(JSON.stringify(grants), "{}");
  assert.deepEqual((await grants.query("p", query)).rows, [{ value: 7 }]);
  await assert.rejects(grants.query("q", query), /未获本次授权/);
  await assert.rejects(
    grants.query("p", { ...query, connectionId: "unknown" }),
    /未获本次授权/,
  );
  f.options.projects.length = 0;
  f.options.projects.push("model-created-project");
  assert.deepEqual((await grants.query("p", query)).rows, [{ value: 7 }]);
  await assert.rejects(
    grants.query("model-created-project", query),
    /未获本次授权/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(grants.query("p", query, aborted.signal), /取消/);
  grants.close();
  grants.close();
  await assert.rejects(grants.query("p", query), /已关闭/);
});

test("equal aliases in different explicitly granted projects remain project scoped", async (t) => {
  const f = await fixture(t),
    second = path.join(f.root, "second.db");
  const db = new DatabaseSync(second);
  db.exec(
    "CREATE TABLE values_fixture(value INTEGER); INSERT INTO values_fixture VALUES(9)",
  );
  db.close();
  await f.write({
    version: 1,
    projects: [
      { projectId: "p", databaseConnections: { fixture: f.config } },
      {
        projectId: "q",
        databaseConnections: { fixture: { type: "sqlite", filename: second } },
      },
    ],
  });
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  t.after(() => grants.close());
  assert.deepEqual((await grants.query("p", query)).rows, [{ value: 7 }]);
  assert.deepEqual((await grants.query("q", query)).rows, [{ value: 9 }]);
});

test("owner file is read once, never watched; deletion keeps current grants, new load needs an explicit file", async (t) => {
  const f = await fixture(t);
  await f.write(envelope({ fixture: f.config }));
  const originalOpen = fs.open;
  let opens = 0;
  const mock = t.mock.method(fs, "open", async (...args) => {
    opens++;
    return originalOpen(...args);
  });
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  assert.equal(opens, 1);
  mock.mock.restore();
  t.after(() => grants.close());
  await f.write(envelope({ replacement: f.config }));
  assert.deepEqual((await grants.query("p", query)).rows, [{ value: 7 }]);
  await assert.rejects(
    grants.query("p", { ...query, connectionId: "replacement" }),
    /未获本次授权/,
  );
  const fresh = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  t.after(() => fresh.close());
  await assert.rejects(fresh.query("p", query), /未获本次授权/);
  assert.deepEqual(
    (await fresh.query("p", { ...query, connectionId: "replacement" })).rows,
    [{ value: 7 }],
  );
  await fs.unlink(f.filename);
  assert.deepEqual((await grants.query("p", query)).rows, [{ value: 7 }]);
  await assert.rejects(loadMCPStdioDatabaseGrants(f.filename, f.options), (e) =>
    redacted(e, [f.root]),
  );
  await assert.rejects(
    loadMCPStdioDatabaseGrants(undefined, f.options),
    redacted,
  );
});

test("permission and allowlist validation precedes any credential file read", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  t.mock.method(fs, "lstat", async () => {
    reads++;
    throw Error(secret);
  });
  for (const change of [
    { write: false },
    { execute: false },
    { projects: [] },
    { projects: ["p", "p"] },
    { projects: ["constructor"] },
    { resolveProject: undefined },
    { projects: "p" },
  ])
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, { ...f.options, ...change }),
      redacted,
    );
  for (const filename of [
    "\\\\fictional\\credential.json",
    "//fictional/credential.json",
    "\\\\?\\C:\\credential.json",
    "\\\\.\\pipe\\fixture",
  ])
    await assert.rejects(
      loadMCPStdioDatabaseGrants(filename, f.options),
      redacted,
    );
  if (process.platform === "win32")
    for (const filename of [
      "NUL",
      "CON.json",
      "C:\\AUX",
      "C:\\file:credential",
      "C:relative",
    ])
      await assert.rejects(
        loadMCPStdioDatabaseGrants(filename, f.options),
        redacted,
      );
  assert.equal(reads, 0);
});

test("strict UTF-8 JSON rejects duplicate escaped keys, dangerous map keys, invalid grammar and depth", async (t) => {
  const f = await fixture(t),
    valid = JSON.stringify(envelope({ fixture: f.config }));
  const cases = [
    "",
    " ",
    "null",
    "[]",
    valid + " trailing",
    "// comment\n" + valid,
    valid.replace('"version":1', '"version":1,"version":1'),
    valid.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    valid.replace('"fixture":', '"fixture":null,"fixture":'),
    valid.replace('"fixture":', '"__proto__":'),
    valid.replace('"fixture":', '"constructor":'),
    valid.replace('"fixture":', '"prototype":'),
    valid.replace('"fixture":', '"\\ud800":'),
    valid.replace('"fixture":', '"apipost-malformed":'),
    valid.replace('"version":1', '"version":1,'),
    "[".repeat(9) + "0" + "]".repeat(9),
    Buffer.concat([Buffer.from(valid), Buffer.from([0xff])]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)]),
  ];
  for (const content of cases) {
    await f.write(content);
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, f.options),
      redacted,
    );
  }
});

test("strict envelope and explicit config preflight rejects mixed batches before any registration or resolution", async (t) => {
  const f = await fixture(t);
  let registrations = 0,
    resolutions = 0;
  t.mock.method(MCPDatabaseGrants.prototype, "register", () => {
    registrations++;
    throw Error("must not register");
  });
  const options = {
    ...f.options,
    resolveProject: async () => {
      resolutions++;
      throw Error("must not resolve");
    },
  };
  const invalidConfigs = [
    {},
    { type: "mssql", host: "fictional" },
    { ...pg, user: " " },
    { ...pg, host: "" },
    { ...pg, database: "" },
    { ...pg, port: 0 },
    { ...pg, port: "5432" },
    { ...pg, ssl: "false" },
    { ...pg, filename: "/not-read" },
    { ...pg, allowWrite: true },
    { ...pg, name: secret },
    { ...pg, bindingId: binding },
    { ...pg, authSource: "admin" },
    { ...pg, password: null },
    { ...pg, password: "a".repeat(65537) },
    { ...pg, password: "a".repeat(65536), ca: "b".repeat(65536) },
    { ...f.config, password: secret },
    { ...f.config, filename: "" },
    { ...pg, ssh: { ...ssh, hostKeySHA256: "SHA256:invalid" } },
    { ...pg, ssh: { ...ssh, privateKey: "FICTIONAL PRIVATE KEY" } },
    { ...pg, ssh: { ...ssh, privateKeyFile: "/not-read" } },
    { ...pg, type: "redis", ssh },
    { ...pg, password: "bad\0value" },
  ];
  for (const config of invalidConfigs) {
    await f.write(envelope({ good: f.config, bad: config }));
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, options),
      redacted,
    );
  }
  for (const document of [
    { ...envelope({ fixture: f.config }), extra: secret },
    { ...envelope({ fixture: f.config }), version: 2 },
    { version: 1, projects: [] },
    {
      version: 1,
      projects: [
        envelope({ fixture: f.config }).projects[0],
        envelope({ other: f.config }).projects[0],
      ],
    },
    envelope({ fixture: f.config }, "not-allowed"),
    envelope({}),
    envelope(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => ["alias" + i, f.config]),
      ),
    ),
  ]) {
    await f.write(document);
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, options),
      redacted,
    );
  }
  assert.equal(registrations, 0);
  assert.equal(resolutions, 0);
});

test("native bindings require unique current source and matching type, Mongo authSource, SSH pin and complete batch preflight", async (t) => {
  const f = await fixture(t);
  const originalRegister = MCPDatabaseGrants.prototype.register;
  let registrations = 0;
  t.mock.method(MCPDatabaseGrants.prototype, "register", function (...args) {
    registrations++;
    return originalRegister.apply(this, args);
  });
  const scenarios = [
    { catalog: [], config: pg },
    { catalog: [{ id: binding, type: "mysql" }], config: pg },
    {
      catalog: [
        { id: binding, type: "postgres" },
        { id: binding, type: "postgres" },
      ],
      config: pg,
    },
    {
      catalog: [{ id: binding, type: "postgres", requiresSSH: false }],
      config: pg,
    },
    {
      catalog: [{ id: binding, type: "postgres", requiresSSH: true }],
      config: pg,
    },
    {
      catalog: [{ id: binding, type: "mongodb" }],
      config: { ...pg, type: "mongodb" },
    },
    {
      catalog: [{ id: binding, type: "mongodb" }],
      config: { ...pg, type: "mongodb", authSource: "" },
    },
  ];
  for (const { catalog, config } of scenarios) {
    f.projects.get("p").settings.apipostDatabases = catalog;
    await f.write(envelope({ good: f.config, [binding]: config }));
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, f.options),
      redacted,
    );
  }
  await f.write({
    version: 1,
    projects: [
      { projectId: "p", databaseConnections: { good: f.config } },
      { projectId: "q", databaseConnections: { [binding]: pg } },
    ],
  });
  await assert.rejects(
    loadMCPStdioDatabaseGrants(f.filename, f.options),
    redacted,
  );
  assert.equal(registrations, 0);

  // Registration only: these fictional hosts are never contacted.
  for (const { type, config, requiresSSH } of [
    { type: "postgres", config: { ...pg, ssh }, requiresSSH: true },
    {
      type: "mongodb",
      config: { ...pg, type: "mongodb", authSource: "fixture_auth" },
    },
    {
      type: "redis",
      config: {
        type: "redis",
        host: "fictional.example.invalid",
        database: "0",
      },
    },
  ]) {
    f.projects.get("p").settings.apipostDatabases = [
      { id: binding, type, ...(requiresSSH ? { requiresSSH } : {}) },
    ];
    await f.write(envelope({ [binding]: config }));
    const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
    grants.close();
  }
  assert.equal(registrations, 3);
});

test("native UUID remapping retains dynamic current catalog checks before any network use", async (t) => {
  const f = await fixture(t);
  await f.write(envelope({ [binding]: pg }));
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  t.after(() => grants.close());
  const operation = { connectionId: binding, sql: "SELECT 1" };
  for (const catalog of [
    [],
    [{ id: binding, type: "mysql" }],
    [{ id: binding, type: "postgres", requiresSSH: true }],
  ]) {
    f.projects.get("p").settings.apipostDatabases = catalog;
    await assert.rejects(grants.query("p", operation), /只读查询失败/);
  }
  await assert.rejects(grants.query("q", operation), /未获本次授权/);
});

test("resolution and registration failures are redacted and rollback the entire unpublished batch", async (t) => {
  const f = await fixture(t);
  await f.write(envelope({ first: f.config, second: f.config }));
  for (const resolveProject of [
    async () => {
      throw Error(secret + f.root);
    },
    async () => ({ id: "wrong" }),
    async () => ({ id: "p", archived: true }),
  ])
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, { ...f.options, resolveProject }),
      (e) => redacted(e, [f.root]),
    );
  const originalRegister = MCPDatabaseGrants.prototype.register;
  let registry,
    registrations = 0;
  t.mock.method(MCPDatabaseGrants.prototype, "register", function (...args) {
    registry = this;
    if (++registrations === 2) throw Error(secret);
    return originalRegister.apply(this, args);
  });
  await assert.rejects(
    loadMCPStdioDatabaseGrants(f.filename, f.options),
    redacted,
  );
  assert.equal(registrations, 2);
  assert.deepEqual(registry.list("p"), []);
});

test("20-grant total cap spans projects, accepts its boundary and rejects over-limit batches before registration", async (t) => {
  const f = await fixture(t),
    connections = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => ["alias" + i, f.config]),
    );
  await f.write(envelope(connections));
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  grants.close();
  let registrations = 0;
  t.mock.method(MCPDatabaseGrants.prototype, "register", () => {
    registrations++;
    throw Error(secret);
  });
  await f.write({
    version: 1,
    projects: [
      { projectId: "p", databaseConnections: connections },
      { projectId: "q", databaseConnections: { another: f.config } },
    ],
  });
  await assert.rejects(
    loadMCPStdioDatabaseGrants(f.filename, f.options),
    redacted,
  );
  assert.equal(registrations, 0);
});

test("exact 1MiB file is accepted without unbounded reads and read errors still close the file", async (t) => {
  const f = await fixture(t),
    body = JSON.stringify(envelope({ fixture: f.config }));
  await f.write(body + " ".repeat(1024 * 1024 - Buffer.byteLength(body)));
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  grants.close();
  const originalOpen = fs.open;
  let closed = 0;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args),
      originalClose = handle.close.bind(handle);
    t.mock.method(handle, "read", async () => {
      throw Error(secret + f.root);
    });
    t.mock.method(handle, "close", async () => {
      closed++;
      return originalClose();
    });
    return handle;
  });
  await assert.rejects(loadMCPStdioDatabaseGrants(f.filename, f.options), (e) =>
    redacted(e, [f.root]),
  );
  assert.equal(closed, 1);
});

test("explicit configs never merge project credentials or expand environment-like strings", async (t) => {
  const f = await fixture(t),
    observed = [];
  f.projects.get("p").settings.credentials = {
    password: "UNREAD_PROJECT_SECRET",
    host: "project.example.invalid",
  };
  const originalRegister = MCPDatabaseGrants.prototype.register;
  t.mock.method(
    MCPDatabaseGrants.prototype,
    "register",
    function (project, config, epoch) {
      observed.push(structuredClone(config));
      assert.equal(
        JSON.stringify(project).includes("UNREAD_PROJECT_SECRET"),
        false,
      );
      return originalRegister.call(this, project, config, epoch);
    },
  );
  await f.write(envelope({ explicit: { ...pg, password: "$PGPASSWORD" } }));
  const grants = await loadMCPStdioDatabaseGrants(f.filename, f.options);
  grants.close();
  assert.equal(observed[0].password, "$PGPASSWORD");
  assert.equal(observed[0].host, pg.host);
  await f.write(
    envelope({
      explicit: { type: "postgres", database: "fixture", user: "fictional" },
    }),
  );
  await assert.rejects(
    loadMCPStdioDatabaseGrants(f.filename, f.options),
    redacted,
  );
});

test("real filesystem rejects directories, oversized files, symlinks, FIFOs and permissive POSIX modes without opening them", async (t) => {
  const f = await fixture(t);
  await f.write(envelope({ fixture: f.config }));
  await assert.rejects(loadMCPStdioDatabaseGrants(f.root, f.options), redacted);
  await fs.writeFile(f.filename, Buffer.alloc(1024 * 1024 + 1, 0x20));
  await assert.rejects(
    loadMCPStdioDatabaseGrants(f.filename, f.options),
    redacted,
  );
  await f.write(envelope({ fixture: f.config }));
  if (process.platform !== "win32") {
    const link = path.join(f.root, "link.json"),
      fifo = path.join(f.root, "pipe");
    await fs.symlink(f.filename, link);
    await assert.rejects(loadMCPStdioDatabaseGrants(link, f.options), redacted);
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    await assert.rejects(loadMCPStdioDatabaseGrants(fifo, f.options), redacted);
    await fs.chmod(f.filename, 0o640);
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, f.options),
      redacted,
    );
  }
});

test("real file replacement between lstat and open is rejected and its FD is closed", async (t) => {
  const f = await fixture(t);
  await f.write(envelope({ fixture: f.config }));
  const originalOpen = fs.open;
  let closed = 0;
  t.mock.method(fs, "open", async (...args) => {
    await fs.rename(f.filename, f.filename + ".old");
    await f.write(envelope({ replacement: f.config }));
    const handle = await originalOpen(...args),
      originalClose = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      closed++;
      return originalClose();
    });
    return handle;
  });
  await assert.rejects(
    loadMCPStdioDatabaseGrants(f.filename, f.options),
    redacted,
  );
  assert.equal(closed, 1);
});

test("real mid-read same-size mutation, growth and pathname replacement are rejected with bounded reads and FD cleanup", async (t) => {
  const f = await fixture(t),
    originalOpen = fs.open;
  for (const change of ["same-size", "grow", "replace"]) {
    await f.write(envelope({ fixture: f.config }));
    let changed = false,
      closed = 0,
      bytes = 0;
    const mock = t.mock.method(fs, "open", async (...args) => {
      const handle = await originalOpen(...args),
        originalRead = handle.read.bind(handle),
        originalClose = handle.close.bind(handle);
      t.mock.method(handle, "read", async (...readArgs) => {
        const result = await originalRead(...readArgs);
        bytes += result.bytesRead;
        if (!changed) {
          changed = true;
          if (change === "same-size") {
            const replacement = JSON.stringify(
              envelope({ fixture: f.config }),
            ).replace('"fixture":', '"changed":');
            await fs.writeFile(f.filename, replacement);
            // Force distinct metadata even on filesystems with coarse clocks.
            await fs.utimes(f.filename, new Date(1000), new Date(1000));
          } else if (change === "grow")
            await fs.appendFile(
              f.filename,
              Buffer.alloc(1024 * 1024 + 1, 0x20),
            );
          else {
            await fs.rename(f.filename, f.filename + ".old");
            await f.write(envelope({ changed: f.config }));
          }
        }
        return result;
      });
      t.mock.method(handle, "close", async () => {
        closed++;
        return originalClose();
      });
      return handle;
    });
    await assert.rejects(
      loadMCPStdioDatabaseGrants(f.filename, f.options),
      redacted,
    );
    assert.equal(closed, 1);
    assert(bytes <= 1024 * 1024 + 1);
    mock.mock.restore();
  }
});
