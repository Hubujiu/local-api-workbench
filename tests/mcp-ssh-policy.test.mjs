import test from "node:test";
import assert from "node:assert/strict";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
test("MCP native SSH requirement rejects direct registration and invalidates old UUID aliases at execution", async () => {
  const id = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  const project = {
    id: "p",
    settings: { apipostDatabases: [{ id, type: "postgres" }] },
  };
  let reads = 0;
  const grants = new MCPDatabaseGrants(
    () => ({ enabled: true, write: true, execute: true, projects: ["p"] }),
    async () => {
      reads++;
      return project;
    },
  );
  const input = {
    name: "old direct",
    type: "postgres",
    host: "127.0.0.1",
    port: 1,
    bindingId: id,
  };
  const registration = grants.register(project, input),
    epoch = grants.capture();
  project.settings.apipostDatabases[0].requiresSSH = true;
  assert.throws(() => grants.register(project, input), /SSH/);
  for (const connectionId of [id, registration.id])
    await assert.rejects(
      grants.query(epoch, "p", { connectionId, sql: "SELECT 1" }),
      (e) => e.message === "MCP 数据库只读查询失败",
    );
  assert.equal(reads, 2);
  grants.invalidate();
});
