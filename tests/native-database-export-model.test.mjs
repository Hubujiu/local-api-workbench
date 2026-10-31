import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject, snapshotPlan } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";

// Independently authored format fixtures. These model checks do not execute
// scripts, SQL, HTTP, the original app or grant a connection. Real providers are
// covered by the separate integration flow, not replaced with a mock here.
const formats = [
  ["JSON", exportApipost],
  ["directory", exportApipostDirectory],
];
const rebind = { databaseMode: "rebind" };
const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  data,
  enabled,
});
const empty = (id = "model-project") => ({
  id,
  name: "Model definition",
  requests: [],
  environments: [],
  servers: [],
  folders: [],
  settings: {},
  plans: [],
  cases: [],
  documents: [],
  dictionary: [],
  globalVariables: {},
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
});
function fixture() {
  const source = nativeDatabaseFixture("http://127.0.0.1:1/model", "pg");
  source.global.db_link[0].name = "PG definition";
  source.global.db_link[0].sort = -7;
  const mysql = nativeDatabaseFixture("http://127.0.0.1:1/model", "mysql")
    .global.db_link[0];
  mysql.db_id = "mysql-database";
  mysql.name = "MySQL definition";
  mysql.sort = 12;
  source.global.db_link.push(mysql);
  const api = source.apis[1];
  const pgTask = api.request.pre_tasks[1];
  pgTask.data.variables = [
    {
      name: "env_value",
      param_id: "old-environment",
      pattern: "$[0].value",
      type: "environment",
    },
    {
      name: "global_value",
      param_id: "old-global",
      pattern: "$[0].value",
      type: "globals",
    },
    {
      name: "temporary_value",
      param_id: "old-temporary",
      pattern: "$[0].value",
      type: "variables",
    },
  ];
  const mysqlTask = structuredClone(pgTask);
  mysqlTask.id = "mysql-query";
  mysqlTask.name = "MySQL read";
  mysqlTask.data.connectionId = mysql.db_id;
  mysqlTask.enabled = -1;
  mysqlTask.data.variables = mysqlTask.data.variables.map((row) => ({
    ...row,
    pattern: "$[0][0].value",
  }));
  api.request.pre_tasks.splice(
    2,
    0,
    task("bounded-wait", "wait", 1),
    mysqlTask,
  );
  api.request.post_tasks.unshift(
    task("extract", "pickVars", {
      source: "responseJson",
      variables: [{ name: "proof", expression: "$.ok", type: "tempVars" }],
    }),
    task("assert-status", "assert", {
      type: "responseCode",
      expression: { path: "", compareType: "eq", compareValue: "200" },
    }),
  );
  const beforeSource = structuredClone(source),
    p = empty();
  importIntoProject(p, source);
  assert.deepEqual(source, beforeSource, "import must not mutate source data");
  return { p, source, beforeSource };
}
const databaseTasks = (p) =>
  [
    ...p.requests[0].nativeTasks.before,
    ...p.requests[0].nativeTasks.after,
  ].filter((t) => t.type === "database");
function semantics(p) {
  const lookup = new Map(
    p.settings.apipostDatabases.map((entry) => [
      entry.id,
      entry.name + ":" + entry.type,
    ]),
  );
  return Object.fromEntries(
    ["before", "after"].map((phase) => [
      phase,
      p.requests[0].nativeTasks[phase].map(({ id, ...entry }) => {
        const result = structuredClone(entry);
        if (result.type === "database")
          result.data.connectionId = lookup.get(result.data.connectionId);
        return result;
      }),
    ]),
  );
}
function outputParts(document) {
  if (document.format === "apipost-offline-directory-v1") {
    const files = new Map(
      document.files.map((file) => [file.path, JSON.parse(file.text)]),
    );
    return {
      projectId: files.get("project.json").project_id,
      links: files.get("settings/db_links.json"),
      apis: document.files
        .filter((file) => /^apis\/(?!index\.json$).+\.json$/.test(file.path))
        .map((file) => JSON.parse(file.text).data)
        .filter((node) => node.target_type === "api"),
    };
  }
  return {
    projectId: document.project_id,
    links: document.global.db_link,
    apis: document.apis.filter((node) => node.target_type === "api"),
  };
}
function checkSafeResources(p) {
  for (const entry of p.settings.apipostDatabases) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["id", "name", "sort", "sourceId", "sourceProjectId", "type"].sort(),
    );
    assert.equal(entry.requiresSSH, undefined);
  }
  assert.deepEqual(
    p.settings.apipostDatabases.map(({ name, type, sort }) => ({
      name,
      type,
      sort,
    })),
    [
      { name: "PG definition", type: "postgres", sort: -7 },
      { name: "MySQL definition", type: "mysql", sort: 12 },
    ],
  );
}
function checkRedactedDocument(document) {
  const { projectId, links, apis } = outputParts(document);
  assert.equal(links.length, 2);
  const ids = new Set(links.map((entry) => entry.db_id));
  assert.equal(ids.size, 2);
  for (const entry of links) {
    assert.equal(entry.project_id, projectId);
    assert.equal(typeof entry.intro, "string");
    assert.equal(Number.isSafeInteger(entry.sort), true);
    assert.deepEqual(Object.keys(entry.config), ["default"]);
    assert.deepEqual(entry.config.default.db_config, {
      auth_source: "",
      database: "",
      host: "",
      password: "",
      user: "",
      port: entry.type === "pg" ? 5432 : 3306,
    });
    assert.deepEqual(entry.config.default.ssh, {
      auth_type: 1,
      enable: -1,
      host: "",
      passphrase: "",
      password: "",
      port: 22,
      private_key: "",
      username: "",
    });
  }
  const tasks = apis
    .flatMap((api) => [...api.request.pre_tasks, ...api.request.post_tasks])
    .filter((entry) => entry.type === "database");
  assert.equal(tasks.length, 2);
  for (const entry of tasks) {
    assert(ids.has(entry.data.connectionId));
    assert.equal(Object.hasOwn(entry.data, "resultShape"), false);
    assert.equal(Object.hasOwn(entry.data, "writeIntent"), false);
    assert.deepEqual(
      entry.data.variables.map((row) => row.type),
      ["environment", "globals", "variables"],
    );
    const rowIds = entry.data.variables.map((row) => row.param_id);
    assert.equal(new Set(rowIds).size, rowIds.length);
    for (const id of rowIds) assert.match(id, /^[A-Za-z0-9_.-]{1,200}$/);
  }
  for (const secret of [
    "discard-this-fictional-password",
    "private-host.invalid",
    "synthetic-user",
    "synthetic-db",
  ])
    assert.equal(
      JSON.stringify(document).includes(secret),
      false,
      "redacted profile must not restore " + secret,
    );
}
function rejectsUnchanged(p, action, label) {
  const before = structuredClone(p);
  assert.throws(() => action(p), undefined, label);
  assert.deepEqual(p, before, label + ": input unchanged");
}

for (const [name, encode] of formats)
  test(`${name} explicit database rebind profile retains two-generation task semantics without credentials or aliases`, () => {
    const { p, source, beforeSource } = fixture();
    const before = structuredClone(p),
      expected = semantics(p);
    checkSafeResources(p);
    assert.equal(databaseTasks(p)[0].data.resultShape, undefined);
    assert.equal(databaseTasks(p)[1].data.resultShape, "mysql-resultsets");
    rejectsUnchanged(
      p,
      (value) => encode(value),
      "default export stays fail-closed",
    );
    let current = p;
    for (let generation = 0; generation < 2; generation++) {
      const snapshot = structuredClone(current);
      const document = encode(current, rebind),
        documentBefore = structuredClone(document);
      checkRedactedDocument(document);
      assert.deepEqual(
        encode(current, rebind),
        document,
        "same definition has deterministic output including regenerated row IDs",
      );
      const next = empty("generation-" + generation);
      importIntoProject(next, document);
      assert.deepEqual(
        document,
        documentBefore,
        "reimport cannot mutate exported input",
      );
      assert.deepEqual(
        current,
        snapshot,
        "export/reimport cannot mutate prior project",
      );
      checkSafeResources(next);
      assert.deepEqual(semantics(next), expected);
      assert.deepEqual(next.requests[0].responses, p.requests[0].responses);
      assert.equal(next.requests[0].inheritSharedScripts, false);
      assert.equal(next.requests[0].beforeScript, "");
      assert.equal(next.requests[0].afterScript, "");
      assert.notEqual(
        next.settings.apipostDatabases[0].id,
        current.settings.apipostDatabases[0].id,
      );
      current = next;
    }
    databaseTasks(current)[0].data.variables[0].name = "edited-copy";
    current.settings.apipostDatabases[0].name = "edited-copy";
    assert.deepEqual(p, before);
    assert.deepEqual(source, beforeSource);
  });

test("database sort is optional for old definitions and bounded metadata for new imports", () => {
  const legacy = nativeDatabaseFixture(),
    p = empty();
  importIntoProject(p, legacy);
  assert.equal(Object.hasOwn(p.settings.apipostDatabases[0], "sort"), false);
  for (const sort of [null, "0", 1.25, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    const source = nativeDatabaseFixture();
    source.global.db_link[0].sort = sort;
    const target = empty();
    rejectsUnchanged(
      target,
      (value) => importIntoProject(value, source),
      "invalid sort must reject atomically",
    );
  }
});

const invalidProjects = [
  [
    "unknown connection",
    (p) => {
      databaseTasks(p)[0].data.connectionId = "missing";
    },
  ],
  [
    "duplicate safe connection ID",
    (p) => {
      p.settings.apipostDatabases.push(
        structuredClone(p.settings.apipostDatabases[0]),
      );
    },
  ],
  [
    "connection credentials injected",
    (p) => {
      p.settings.apipostDatabases[0].config = { password: "not-a-grant" };
    },
  ],
  [
    "SSH required",
    (p) => {
      p.settings.apipostDatabases[0].requiresSSH = true;
    },
  ],
  [
    "Redis not in profile",
    (p) => {
      p.settings.apipostDatabases[0].type = "redis";
    },
  ],
  [
    "MongoDB not in profile",
    (p) => {
      p.settings.apipostDatabases[0].type = "mongodb";
    },
  ],
  [
    "PG shape mismatch",
    (p) => {
      databaseTasks(p)[0].data.resultShape = "mysql-resultsets";
    },
  ],
  [
    "MySQL missing shape",
    (p) => {
      delete databaseTasks(p)[1].data.resultShape;
    },
  ],
  [
    "MySQL foreign shape",
    (p) => {
      databaseTasks(p)[1].data.resultShape = "redis-value";
    },
  ],
  [
    "DELETE SQL",
    (p) => {
      databaseTasks(p)[0].data.query = "DELETE FROM fixture";
    },
  ],
  [
    "INSERT SQL",
    (p) => {
      databaseTasks(p)[0].data.query = "INSERT INTO fixture VALUES (1)";
    },
  ],
  [
    "dynamic SQL",
    (p) => {
      databaseTasks(p)[0].data.query = "SELECT {{untrusted}}";
    },
  ],
  [
    "write intent",
    (p) => {
      databaseTasks(p)[0].data.writeIntent = "redis-set";
    },
  ],
  [
    "request origin",
    (p) => {
      databaseTasks(p)[0].origin = { scope: "request", id: "source-api" };
    },
  ],
  [
    "folder origin",
    (p) => {
      databaseTasks(p)[0].origin = { scope: "folder", id: "source-folder" };
    },
  ],
  [
    "inert source present",
    (p) => {
      p.requests[0].importedNativeTaskSource = {
        version: 1,
        before: [],
        after: [],
      };
    },
  ],
  [
    "legacy source present",
    (p) => {
      p.requests[0].importedScriptTasks = { version: 1, before: [], after: [] };
    },
  ],
  [
    "shared inheritance",
    (p) => {
      p.requests[0].inheritSharedScripts = true;
    },
  ],
  [
    "unknown source field",
    (p) => {
      p.settings.apipostDatabases[0].unknown = "must-not-drop";
    },
  ],
  [
    "invalid stored sort",
    (p) => {
      p.settings.apipostDatabases[0].sort = "12";
    },
  ],
];
for (const [label, mutate] of invalidProjects)
  test(`database rebind export rejects ${label} before returning either format`, () => {
    for (const [, encode] of formats) {
      const { p } = fixture();
      mutate(p);
      rejectsUnchanged(p, (value) => encode(value, rebind), label);
    }
  });

test("database profile rejects unsupported option values and keeps frozen pipelines outside the interchange", () => {
  const { p } = fixture();
  for (const [, encode] of formats) {
    for (const databaseMode of [
      null,
      false,
      1,
      "",
      "credentials",
      "Rebind",
      {},
      [],
    ])
      rejectsUnchanged(
        p,
        (value) => encode(value, { databaseMode }),
        "invalid database profile",
      );
    const frozen = structuredClone(p);
    frozen.environments = [{ id: "env", name: "Environment", variables: {} }];
    frozen.plans = [
      snapshotPlan({
        name: "Frozen",
        environmentId: "env",
        steps: [{ request: frozen.requests[0] }],
      }),
    ];
    rejectsUnchanged(
      frozen,
      (value) => encode(value, rebind),
      "frozen database steps are not API-local tasks",
    );
  }
});
