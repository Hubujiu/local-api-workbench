import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  try {
    const config = JSON.parse(
      await readFile(process.env.LOCALAPI_ORACLE_REAL_CONFIG, "utf8"),
    );
    assert.deepEqual(Object.keys(config).sort(), ["connection", "disposable"]);
    assert.equal(config.disposable, true);
    const query = (sql) =>
      queryOracleRead({ connection: config.connection, sql });
    stage = "permissions";
    const privs = await query("SELECT privilege FROM sys.session_privs");
    assert.ok(privs.rows.every((r) => r.PRIVILEGE === "CREATE SESSION"));
    assert.equal(
      (await query("SELECT role FROM sys.session_roles")).rows.length,
      0,
    );
    stage = "fixture";
    const result = await queryOracleRead({
      connection: config.connection,
      sql: "SELECT id, exact_amount FROM workbench_gate.workbench_oracle_gate WHERE id=:p0",
      parameters: [1],
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].ID, "1");
    assert.equal(
      result.rows[0].EXACT_AMOUNT,
      "9007199254740993.123456789012345678",
    );
    assert.equal(result.truncated, false);
  } catch {
    throw Error(`ORACLE_REAL_GATE_NO_ACCEPTANCE:${stage}`);
  }
});
