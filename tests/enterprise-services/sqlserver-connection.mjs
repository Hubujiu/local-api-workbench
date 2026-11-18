import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Connection, Request } from "tedious";
import { sqlServerConnectionContract } from "../../src/sqlserver-driver-contract.mjs";
import {
  GATE_PERMISSIONS,
  requireRestrictedPermissions,
} from "../helpers/sqlserver-real-gate.mjs";

assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const config = JSON.parse(
  await readFile(process.env.LOCALAPI_SQLSERVER_REAL_CONFIG, "utf8"),
);
assert.equal(config.disposable, true);
const connection = new Connection(sqlServerConnectionContract(config.readOnly));
let stage = "connect";
try {
  await new Promise((resolve, reject) =>
    connection.connect((e) => (e ? reject(e) : resolve())),
  );
  stage = "permissions";
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = new Request(GATE_PERMISSIONS, (e) =>
      e ? reject(e) : resolve(),
    );
    request.on("row", (columns) =>
      rows.push(
        Object.fromEntries(columns.map((c) => [c.metadata.colName, c.value])),
      ),
    );
    connection.execSql(request);
  });
  assert.equal(rows.length, 1);
  requireRestrictedPermissions(rows[0]);
  console.log(
    "SQLSERVER_NATIVE_CONTROL_PASS verified-TLS/restricted-permissions",
  );
} catch (error) {
  const code = /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "mismatch";
  throw Error(`SQL Server native control failed at ${stage} (${code})`);
} finally {
  connection.close();
}
