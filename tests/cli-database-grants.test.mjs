import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareCLIDatabaseGrants } from "../src/cli-database-grants.mjs";
import { verifyCLIDatabaseFlow } from "./cli-database-integration.mjs";
const plan = {
  steps: [
    { request: { before: [{ type: "database", connectionId: "fixture" }] } },
  ],
};
test("CLI database grants require exact explicit bindings and reject write options", () => {
  for (const map of [
    undefined,
    [],
    {},
    { foreign: {} },
    { fixture: {} },
    { fixture: { type: "mysql" } },
    { fixture: { type: "sqlite", filename: "fixture.db", allowWrite: true } },
  ])
    assert.throws(() => prepareCLIDatabaseGrants("p", plan, map), /CLI/);
  const grants = prepareCLIDatabaseGrants(
    "p",
    { steps: [{ enabled: false, ...plan.steps[0] }] },
    {},
  );
  grants.close();
});
test("CLI database grants real SQLite query, closure isolation and subprocess persistence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cli-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db");
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('fixture-value')",
  );
  db.close();
  const config = { type: "sqlite", filename },
    grants = prepareCLIDatabaseGrants("p", plan, { fixture: config });
  t.after(() => grants.close());
  const operation = {
    connectionId: "fixture",
    sql: "SELECT value FROM records",
    parameters: [],
  };
  assert.equal((await grants.query(operation)).rows[0].value, "fixture-value");
  await assert.rejects(
    grants.query({ ...operation, sql: "DELETE FROM records" }),
    /只读/,
  );
  await assert.rejects(grants.query(operation, AbortSignal.abort()), /取消/);
  const pending = grants.query(operation);
  grants.close();
  await assert.rejects(pending, /撤销/);
  await assert.rejects(grants.query(operation), /关闭/);
  await verifyCLIDatabaseFlow(config, operation.sql);
});
test("CLI native-task reference collection requires exact enabled bindings and keeps readonly isolation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cli-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db");
  new DatabaseSync(filename).close();
  const task = (connectionId, enabled = 1) => ({
    type: "database",
    enabled,
    data: { connectionId },
  });
  const nativePlan = {
    steps: [
      {
        request: {
          nativeTasks: {
            version: 1,
            before: [task("native"), task("disabled", -1)],
            after: [task("native")],
          },
        },
      },
      {
        enabled: false,
        request: {
          nativeTasks: { version: 1, before: [task("skipped")], after: [] },
        },
      },
    ],
  };
  const config = { type: "sqlite", filename };
  for (const map of [
    {},
    { native: config, disabled: config },
    { native: { ...config, allowWrite: true } },
  ])
    assert.throws(() => prepareCLIDatabaseGrants("p", nativePlan, map), /CLI/);
  const grants = prepareCLIDatabaseGrants("p", nativePlan, { native: config });
  t.after(() => grants.close());
  assert.equal(
    (
      await grants.query({
        connectionId: "native",
        sql: "SELECT 'ok' AS value",
        parameters: [],
      })
    ).rows[0].value,
    "ok",
  );
  await assert.rejects(
    grants.query({ connectionId: "disabled", sql: "SELECT 1" }),
    /未获/,
  );
  grants.close();
  await assert.rejects(
    grants.query({ connectionId: "native", sql: "SELECT 1" }),
    /关闭/,
  );
  for (const patch of [
    { version: 2 },
    { after: null },
    { before: [task("x", true)] },
    { before: [task("")] },
  ]) {
    const bad = structuredClone(nativePlan);
    Object.assign(bad.steps[0].request.nativeTasks, patch);
    assert.throws(() => prepareCLIDatabaseGrants("p", bad, {}), /CLI/);
  }
});

test("CLI imported bindings and typed native task results require matching engines before any connection", () => {
  const id = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  const plan = {
    steps: [
      {
        request: {
          nativeTasks: {
            version: 1,
            before: [
              {
                type: "database",
                enabled: 1,
                data: { connectionId: id, resultShape: "redis-value" },
              },
            ],
            after: [],
          },
        },
      },
    ],
  };
  const config = {
    type: "redis",
    host: "127.0.0.1",
    port: 6379,
    database: "0",
  };
  assert.throws(
    () => prepareCLIDatabaseGrants("p", plan, { [id]: config }),
    /来源/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        plan,
        { [id]: { ...config, type: "postgres" } },
        [{ id, type: "redis" }],
      ),
    /引擎/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants("p", plan, { [id]: config }, [
        { id, type: "postgres" },
      ]),
    /引擎/,
  );
  const grants = prepareCLIDatabaseGrants("p", plan, { [id]: config }, [
    { id, type: "redis" },
  ]);
  grants.close();
  const manual = structuredClone(plan);
  manual.steps[0].request.nativeTasks.before[0].data.connectionId = "manual";
  assert.throws(
    () =>
      prepareCLIDatabaseGrants("p", manual, {
        manual: { ...config, type: "postgres" },
      }),
    /引擎/,
  );
});

test("CLI source SSH requirements cannot be downgraded or supplied as a grant flag", () => {
  const id = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  const plan = {
    steps: [{ request: { before: [{ type: "database", connectionId: id }] } }],
  };
  const source = [{ id, type: "postgres", requiresSSH: true }],
    config = { type: "postgres", host: "127.0.0.1", database: "fixture" };
  assert.throws(
    () => prepareCLIDatabaseGrants("p", plan, { [id]: config }, source),
    /SSH/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        plan,
        { [id]: { ...config, requiresSSH: true } },
        source,
      ),
    /字段/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        plan,
        {
          [id]: {
            ...config,
            ssh: {
              host: "127.0.0.1",
              username: "fixture",
              password: "fixture",
            },
          },
        },
        source,
      ),
    /指纹/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants("p", plan, { [id]: config }, [
        { ...source[0], requiresSSH: false },
      ]),
    /来源要求/,
  );
});

test("CLI Mongo document tasks require their engine and explicit authentication database", () => {
  const id = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20),
    source = [{ id, type: "mongodb" }];
  const plan = {
    steps: [
      {
        request: {
          nativeTasks: {
            version: 1,
            before: [
              {
                type: "database",
                enabled: 1,
                data: { connectionId: id, resultShape: "mongodb-document" },
              },
            ],
            after: [],
          },
        },
      },
    ],
  };
  const config = {
    type: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    database: "fixture",
  };
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        plan,
        { [id]: { ...config, type: "redis" } },
        source,
      ),
    /引擎/,
  );
  assert.throws(
    () =>
      prepareCLIDatabaseGrants(
        "p",
        plan,
        { [id]: { ...config, user: "fixture" } },
        source,
      ),
    /authSource/,
  );
  const granted = prepareCLIDatabaseGrants(
    "p",
    plan,
    { [id]: { ...config, user: "fixture", authSource: "admin" } },
    source,
  );
  granted.close();
});
