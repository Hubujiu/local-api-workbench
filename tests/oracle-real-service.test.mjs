import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OracleReadSessions } from "../src/oracle-read-sessions.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { queryOracleRead } from "../src/oracle-read-process.mjs";
test("opt-in actual Oracle Thin TCPS read-only exact NUMBER gate", async (t) => {
  if (
    process.env.LOCALAPI_ORACLE_REAL === undefined ||
    process.env.LOCALAPI_ORACLE_REAL === "0"
  ) {
    t.skip(
      "real Oracle service not configured; no service acceptance evidence",
    );
    return;
  }
  if (
    process.env.LOCALAPI_ORACLE_REAL !== "1" ||
    !process.env.LOCALAPI_ORACLE_REAL_CONFIG
  )
    throw Error("ORACLE_REAL_GATE_CONFIG_REQUIRED");
  let stage = "config";
  const sessions = new OracleReadSessions({
    enabled: true,
    query: async (input, options) => {
      try {
        return await queryOracleRead(input, options);
      } catch (error) {
        stage +=
          "-" +
          [error.code, error.stage, error.driverCode].filter(Boolean).join("-");
        throw error;
      }
    },
  });
  const projectSessions = new DatabaseSessions();
  const previousPreview = process.env.LOCALAPI_ORACLE_PREVIEW;
  process.env.LOCALAPI_ORACLE_PREVIEW = "read-only";
  try {
    const config = JSON.parse(
      await readFile(process.env.LOCALAPI_ORACLE_REAL_CONFIG, "utf8"),
    );
    assert.deepEqual(Object.keys(config).sort(), ["connection", "disposable"]);
    assert.equal(config.disposable, true);
    const { id } = sessions.register("gate-owner", "gate-project", {
      connection: config.connection,
      relations: [
        "sys.session_privs",
        "sys.session_roles",
        "workbench_gate.workbench_oracle_gate",
      ],
    });
    const query = (sql, parameters = []) =>
      sessions.query("gate-owner", "gate-project", id, { sql, parameters });
    stage = "ownership";
    await assert.rejects(
      sessions.query("other-owner", "gate-project", id, {
        sql: "SELECT privilege FROM sys.session_privs",
      }),
      /ORACLE_SESSION_UNAVAILABLE/,
    );
    await assert.rejects(
      query("SELECT table_name FROM sys.all_tables"),
      /ORACLE_SESSION_RELATION_DENIED/,
    );
    stage = "permissions";
    const privs = await query("SELECT privilege FROM sys.session_privs");
    assert.ok(privs.rows.every((r) => r.PRIVILEGE === "CREATE SESSION"));
    assert.equal(
      (await query("SELECT role FROM sys.session_roles")).rows.length,
      0,
    );
    stage = "fixture";
    const result = await query(
      "SELECT id, exact_amount FROM workbench_gate.workbench_oracle_gate WHERE id=:p0",
      [1],
    );
    stage = "fixture-row-count";
    assert.equal(result.rows.length, 1);
    stage = "fixture-id";
    assert.equal(result.rows[0].ID, "1");
    stage = "fixture-decimal";
    assert.equal(
      result.rows[0].EXACT_AMOUNT,
      "9007199254740993.123456789012345678",
    );
    assert.equal(result.truncated, false);
    stage = "revocation";
    sessions.revoke("gate-owner", "gate-project", id);
    await assert.rejects(
      query("SELECT privilege FROM sys.session_privs"),
      /ORACLE_SESSION_UNAVAILABLE/,
    );
    stage = "workbench-session";
    const relation = "workbench_gate.workbench_oracle_gate";
    const grant = {
      ...config.connection,
      type: "oracle",
      name: "TLS fixture",
      relations: [relation],
    };
    const project = "real-disposable";
    const actualQuery = (connectionId) =>
      projectSessions.query(project, {
        connectionId,
        sql: "SELECT exact_amount FROM workbench_gate.workbench_oracle_gate WHERE id=:p0",
        parameters: [1],
      });
    const registered = projectSessions.register(project, grant);
    assert.deepEqual((await actualQuery(registered.id)).rows, [
      { EXACT_AMOUNT: "9007199254740993.123456789012345678" },
    ]);
    projectSessions.revoke(project, registered.id);
    await assert.rejects(actualQuery(registered.id));
    stage = "wrong-dn";
    const mismatched = projectSessions.register(project, {
      ...grant,
      serverDN: "CN=wrong-name.invalid",
    });
    await assert.rejects(actualQuery(mismatched.id));
    console.log(
      "ORACLE_REAL_READ_GATE_PASS verified-TCPS/exact-NUMBER/project-grant/revocation/DN-rejection",
    );
  } catch {
    throw Error(`ORACLE_REAL_GATE_NO_ACCEPTANCE:${stage}`);
  } finally {
    sessions.close();
    projectSessions.close();
    if (previousPreview === undefined)
      delete process.env.LOCALAPI_ORACLE_PREVIEW;
    else process.env.LOCALAPI_ORACLE_PREVIEW = previousPreview;
  }
});
