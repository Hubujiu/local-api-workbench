import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { verifyMCPDatabaseFlow } from "./mcp-database-integration.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
test("MCP-only database grants use real SQLite and official SDK across revoke, rotate, project change and restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-db-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db");
  new DatabaseSync(filename).close();
  await verifyMCPDatabaseFlow({ type: "sqlite", filename });
});
test("MCP grant epochs reject stale registration and discard in-flight results", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-db-epoch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db");
  new DatabaseSync(filename).close();
  let policy = { enabled: true, write: true, execute: true, projects: ["p"] };
  const grants = new MCPDatabaseGrants(() => policy);
  t.after(() => grants.invalidate());
  const epoch = grants.capture(),
    connection = grants.register(
      { id: "p" },
      { name: "fixture", filename },
      epoch,
    );
  const pending = grants.query(epoch, "p", {
    connectionId: connection.id,
    sql: "SELECT 1",
    parameters: [],
  });
  grants.invalidate();
  await assert.rejects(pending, /撤销/);
  assert.throws(
    () => grants.register({ id: "p" }, { name: "fixture", filename }, epoch),
    /撤销/,
  );
  await assert.rejects(
    grants.query(epoch, "p", { connectionId: connection.id, sql: "SELECT 1" }),
    /撤销/,
  );
  assert.deepEqual(grants.list("p"), []);
  const fresh = grants.register({ id: "p" }, { name: "fixture", filename });
  await assert.rejects(
    grants.query(grants.capture(), "p", {
      connectionId: fresh.id,
      sql: "SELECT * FROM private_table_name",
      parameters: [],
    }),
    (error) => {
      assert.match(error.message, /只读查询失败/);
      assert.equal(error.message.includes("private_table_name"), false);
      assert.equal(error.message.includes(root), false);
      return true;
    },
  );
  policy = { ...policy, execute: false };
  assert.throws(() => grants.list("p"), /未授权/);
});
