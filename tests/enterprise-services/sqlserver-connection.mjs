import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Connection, Request, TYPES } from "tedious";
import { compileSQLServerRead } from "../../src/sqlserver-read-contract.mjs";
import {
  exactCatalogPlan,
  exactProjectionPlan,
  validateExactResult,
} from "../../src/sqlserver-exact-output.mjs";
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
async function select(sql, parameters = []) {
  let names;
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = new Request(sql, (e) => (e ? reject(e) : resolve()));
    request.on("columnMetadata", (columns) => {
      names = columns.map((c) => c.colName);
    });
    request.on("row", (columns) =>
      rows.push(
        Object.fromEntries(columns.map((c) => [c.metadata.colName, c.value])),
      ),
    );
    for (const p of parameters)
      request.addParameter(p.name, TYPES[p.type], p.value);
    connection.execSql(request);
  });
  return { columns: names, rows };
}
let stage = "connect";
try {
  await new Promise((resolve, reject) =>
    connection.connect((e) => (e ? reject(e) : resolve())),
  );
  stage = "permissions";
  const { rows } = await select(GATE_PERMISSIONS);
  assert.equal(rows.length, 1);
  requireRestrictedPermissions(rows[0]);
  stage = "catalog";
  const plan = await compileSQLServerRead(
    "SELECT exact_amount, exact_stamp, exact_offset, exact_clock, exact_day FROM dbo.workbench_sqlserver_gate WHERE id=@p0",
    [1],
  );
  const catalog = exactCatalogPlan(plan);
  const metadata = await select(catalog.sql, catalog.parameters);
  stage = "projection";
  const projection = exactProjectionPlan(plan, metadata);
  stage = "retrieve";
  const output = await select(projection.sql, plan.parameters);
  assert.equal(output.rows.length, 1);
  // Only this isolated fixture's five fixed decimal/time fields are diagnostic output.
  for (const column of projection.columns) {
    const value = output.rows[0][column.name];
    console.log(
      "SQLSERVER_FIXTURE_FORMAT",
      column.name,
      typeof value === "string" && /^[0-9T Z+:.-]{1,41}$/.test(value)
        ? value
        : typeof value,
    );
  }
  stage = "validate-values";
  validateExactResult(output, projection.columns);
  console.log(
    "SQLSERVER_NATIVE_CONTROL_PASS verified-TLS/restricted-permissions",
  );
} catch (error) {
  const code = /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "mismatch";
  throw Error(`SQL Server native control failed at ${stage} (${code})`);
} finally {
  connection.close();
}
