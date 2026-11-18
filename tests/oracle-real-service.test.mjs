import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OracleReadSessions } from "../src/oracle-read-sessions.mjs";
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
  const sessions = new OracleReadSessions({ enabled: true });
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
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].ID, "1");
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
  } catch {
    throw Error(`ORACLE_REAL_GATE_NO_ACCEPTANCE:${stage}`);
  } finally {
    sessions.close();
  }
});
