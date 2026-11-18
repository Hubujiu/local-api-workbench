import { verifySQLServerExactFixture } from "./helpers/sqlserver-exact-fixture.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
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
async function permissions(connection, progress) {
  const port = createTediousSQLServerPort(
    sqlServerConnectionContract(connection),
  );
  let columns,
    rows = [];
  try {
    progress("connect");
    await port.connect();
    progress("submitted");
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
    progress("returned");
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
  const previousPreview = process.env.LOCALAPI_SQLSERVER_PREVIEW;
  process.env.LOCALAPI_SQLSERVER_PREVIEW = "read-only";
  t.after(() => {
    if (previousPreview === undefined)
      delete process.env.LOCALAPI_SQLSERVER_PREVIEW;
    else process.env.LOCALAPI_SQLSERVER_PREVIEW = previousPreview;
  });
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
    await permissions(config.readOnly, (step) => {
      stage = "permissions-read-only-" + step;
    });
    stage = "permissions-read-write";
    await permissions(config.readWrite, (step) => {
      stage = "permissions-read-write-" + step;
    });
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
    stage = "exact-decimal-process";
    const decimalQuery =
      "SELECT id, payload FROM dbo.workbench_sqlserver_gate WHERE exact_amount=@p0";
    for (const [value, match] of [
      ["9007199254740993.123456789012345678", true],
      ["9007199254740993.123456789012345679", false],
    ]) {
      const result = await runSQLServerPreparationProcess({
        connection: config.readOnly,
        sql: decimalQuery,
        parameters: [{ type: "decimal", value, precision: 38, scale: 18 }],
      });
      if (match) exactResult(result);
      else requireGate(result.rows.length === 0 && result.truncated === false);
    }
    // Diagnose individual fixed types without printing database values. Keep
    // the original combined projection below as an independent final check.
    await verifySQLServerExactFixture(config.readOnly, {
      onStage: (value) => {
        stage = "public-provider-exact/" + value;
      },
    });
    stage = "public-provider-exact-decimal-temporal-output";
    for (const id of [1, 2]) {
      stage =
        id === 1
          ? "public-provider-exact-combined/value/provider-query"
          : "public-provider-exact-combined/null/provider-query";
      const output = await queryRemoteDatabase({
        type: "sqlserver",
        ...config.readOnly,
        sql: "SELECT exact_amount, exact_stamp, exact_offset, exact_clock, exact_day FROM dbo.workbench_sqlserver_gate WHERE id=@p0",
        parameters: [id],
      });
      stage =
        id === 1
          ? "public-provider-exact-combined/value/result-shape"
          : "public-provider-exact-combined/null/result-shape";
      requireGate(output.rows.length === 1 && output.truncated === false);
      stage =
        id === 1
          ? "public-provider-exact-combined/value/exact-values"
          : "public-provider-exact-combined/null/exact-values";
      requireGate(
        JSON.stringify(Object.values(output.rows[0])) ===
          JSON.stringify(
            id === 1
              ? [
                  "9007199254740993.123456789012345678",
                  "2026-11-18T02:03:04.1234567",
                  "2026-11-18T02:03:04.1234567+05:30",
                  "02:03:04.1234567",
                  "0001-01-01",
                ]
              : [null, null, null, null, null],
          ),
      );
    }
    stage = "public-session-owned-provider";
    const sessions = new DatabaseSessions();
    try {
      const grant = sessions.register("real-gate", {
        type: "sqlserver",
        name: "disposable-fixture",
        ...config.readOnly,
      });
      exactResult(
        await sessions.query("real-gate", {
          connectionId: grant.id,
          sql: GATE_SQL,
          parameters: [1],
        }),
      );
      sessions.revoke("real-gate", grant.id);
      let revoked = false;
      try {
        await sessions.query("real-gate", {
          connectionId: grant.id,
          sql: GATE_SQL,
          parameters: [1],
        });
      } catch {
        revoked = true;
      }
      requireGate(revoked);
    } finally {
      sessions.close();
    }
    stage = "public-provider-read-write-denied";
    let publicDenied = false;
    try {
      await queryRemoteDatabase({
        type: "sqlserver",
        ...config.readWrite,
        sql: GATE_SQL,
        parameters: [1],
      });
    } catch {
      publicDenied = true;
    }
    requireGate(publicDenied);
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
