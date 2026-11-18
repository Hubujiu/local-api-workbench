// Independent native-driver control for this run's fixed, disposable fixture.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setDefaultCACertificates } from "node:tls";
import driver from "oracledb";
import { compileOracleRead } from "../../src/oracle-read-contract.mjs";

assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.LOCALAPI_ORACLE_REAL, "1");
const { connection, disposable } = JSON.parse(
  await readFile(process.env.LOCALAPI_ORACLE_REAL_CONFIG, "utf8"),
);
assert.equal(disposable, true);
const plan = compileOracleRead({
  connection,
  sql: "SELECT id, exact_amount FROM workbench_gate.workbench_oracle_gate WHERE id=:p0",
  parameters: [1],
});
setDefaultCACertificates(plan.certificates);
let client,
  stage = "connect";
try {
  client = await driver.getConnection(plan.config);
  stage = "native-protocol";
  const transport = await client.execute(
    "SELECT SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') FROM dual",
  );
  assert.equal(transport.rows[0][0].toLowerCase(), "tcps");
  stage = "prepared-select";
  const result = await client.execute(plan.sql, plan.binds, {
    fetchTypeHandler(meta) {
      if (meta.dbType === driver.DB_TYPE_NUMBER)
        return { type: driver.DB_TYPE_VARCHAR };
    },
  });
  stage = "row-count";
  assert.equal(result.rows.length, 1);
  stage = "integer";
  assert.equal(result.rows[0][0], "1");
  stage = "decimal";
  assert.equal(result.rows[0][1], "9007199254740993.123456789012345678");
  console.log("ORACLE_NATIVE_CONTROL_PASS native-TCPS/exact-NUMBER");
} catch (error) {
  const code = /^(ORA|NJS)-[0-9]+$/.test(error.code) ? error.code : "mismatch";
  throw Error(`Oracle native control failed at ${stage} (${code})`);
} finally {
  if (client) await client.close();
}
