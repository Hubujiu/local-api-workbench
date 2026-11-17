// Opt-in only. Never provisions a database, downloads a server or accepts terms.
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createTediousSQLServerPort } from "../src/sqlserver-tedious-prep.mjs";
import {
  runSQLServerReadPreparation,
  SQLSERVER_READONLY_PROBE,
} from "../src/sqlserver-read-prep.mjs";
import { runSQLServerPreparationProcess } from "../src/sqlserver-prep-process.mjs";
import { sqlServerConnectionContract } from "../src/sqlserver-driver-contract.mjs";
import {
  GATE_SQL,
  GATE_PERMISSIONS,
  gateEnabled,
  validateGateConfig,
  requireRestrictedPermissions,
} from "./helpers/sqlserver-real-gate.mjs";
const requireGate = (condition) => {
  if (!condition) throw Error("SQLSERVER_REAL_GATE_ASSERTION_FAILED");
};
async function permissions(connection) {
  const port = createTediousSQLServerPort(
    sqlServerConnectionContract(connection),
  );
  let columns,
    rows = [];
  try {
    await port.connect();
    await port.query(
      { sql: GATE_PERMISSIONS, parameters: [] },
      {
        metadata(value) {
          columns = value.map((c) => c.name);
        },
        row(values) {
          rows.push(
            Object.fromEntries(columns.map((key, i) => [key, values[i]])),
          );
        },
      },
    );
    requireGate(rows.length === 1);
    requireRestrictedPermissions(rows[0]);
  } finally {
    port.destroy();
    await port.closed;
  }
}
async function dispatch(connection) {
  const sent = [],
    states = [];
  let connections = 0;
  const factory = (config) => {
    connections++;
    const port = createTediousSQLServerPort(config);
    return {
      connect: () => port.connect(),
      destroy: () => port.destroy(),
      closed: port.closed,
      query(plan, sink) {
        sent.push(
          plan.sql === SQLSERVER_READONLY_PROBE ? "probe" : "submitted",
        );
        return port.query(plan, {
          metadata: (value) => sink.metadata(value),
          row(values) {
            if (plan.sql === SQLSERVER_READONLY_PROBE) states.push(values[0]);
            sink.row(values);
          },
        });
      },
    };
  };
  let result,
    rejected = false;
  try {
    result = await runSQLServerReadPreparation(
      { connection, sql: GATE_SQL, parameters: [1] },
      { factory },
    );
  } catch {
    rejected = true;
  }
  return { sent, states, connections, result, rejected };
}
function exactResult(result) {
  requireGate(result?.truncated === false && result?.limit === 1000);
  requireGate(JSON.stringify(result?.columns) === '["id","payload"]');
  requireGate(
    JSON.stringify(result?.rows) ===
      '[{"id":1,"payload":"workbench-sqlserver-real-gate"}]',
  );
}
test("opt-in real SQL Server READ_ONLY prepared read and READ_WRITE dispatch rejection", async (t) => {
  let enabled;
  try {
    enabled = gateEnabled(process.env);
  } catch {
    throw Error("SQLSERVER_REAL_GATE_CONFIG_REQUIRED");
  }
  if (!enabled) {
    t.skip("real service not opted in; no SQL Server acceptance evidence");
    return;
  }
  let stage = "config";
  // All errors and assertions are deliberately redacted: no driver config,
  // hostname, credentials, raw error causes, query parameters or rows in TAP.
  try {
    const config = validateGateConfig(
      JSON.parse(
        await readFile(process.env.LOCALAPI_SQLSERVER_REAL_CONFIG, "utf8"),
      ),
    );
    stage = "permissions-read-only";
    await permissions(config.readOnly);
    stage = "permissions-read-write";
    await permissions(config.readWrite);
    stage = "read-only-direct";
    const positive = await dispatch(config.readOnly);
    requireGate(!positive.rejected && positive.connections === 1);
    requireGate(JSON.stringify(positive.states) === '["READ_ONLY"]');
    requireGate(JSON.stringify(positive.sent) === '["probe","submitted"]');
    exactResult(positive.result);
    stage = "read-only-process";
    exactResult(
      await runSQLServerPreparationProcess({
        connection: config.readOnly,
        sql: GATE_SQL,
        parameters: [1],
      }),
    );
    stage = "read-write";
    const negative = await dispatch(config.readWrite);
    requireGate(
      negative.rejected &&
        negative.result === undefined &&
        negative.connections === 1,
    );
    requireGate(JSON.stringify(negative.states) === '["READ_WRITE"]');
    requireGate(JSON.stringify(negative.sent) === '["probe"]');
    console.log(
      "SQLSERVER_REAL_READ_GATE_PASS real-service/prepared-positive/read-write-no-query-dispatch",
    );
  } catch {
    throw Error(`SQLSERVER_REAL_GATE_FAILED_NO_ACCEPTANCE:${stage}`);
  }
});
