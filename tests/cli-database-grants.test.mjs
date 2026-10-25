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
