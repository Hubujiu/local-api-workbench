// Disabled WIP. This module has no default driver and is not a provider entrypoint.
import { oracleReadInput } from "./oracle-read-config.mjs";
import {
  oracleBindParameters,
  oracleReadColumns,
  oracleReadFetchType,
  oracleReadRow,
} from "./oracle-read-values.mjs";

const messages = Object.freeze({
  ORACLE_WIP_CANCELLED: "Oracle WIP read cancelled; no replay",
  ORACLE_WIP_DRIVER_UNAVAILABLE: "Oracle WIP requires an explicit Thin driver",
  ORACLE_WIP_QUERY_FAILED: "Oracle WIP read failed; no replay",
  ORACLE_WIP_CLEANUP_FAILED: "Oracle WIP cleanup failed; result withheld",
  ORACLE_WIP_TIMEOUT: "Oracle WIP deadline exceeded; owned worker terminated",
  ORACLE_WIP_WORKER_FAILED: "Oracle WIP worker failed; result withheld",
});
export function oracleReadFailure(code = "ORACLE_WIP_QUERY_FAILED") {
  if (!Object.hasOwn(messages, code)) code = "ORACLE_WIP_QUERY_FAILED";
  return Object.assign(new Error(messages[code]), {
    code,
    ...(code === "ORACLE_WIP_CANCELLED" ? { name: "AbortError" } : {}),
  });
}
function check(signal) {
  if (signal?.aborted) throw oracleReadFailure("ORACLE_WIP_CANCELLED");
}

// Internal, driver-injected execution only. Its caller MUST own an interruptible
// worker and deadlines: awaiting driver cleanup alone is not a wall-clock bound.
// READ ONLY is not a sandbox for SYS or autonomous/side-effecting functions.
export async function runOracleReadWithDriver(
  input,
  { driver, signal, onPhase = () => {} } = {},
) {
  check(signal);
  const config = oracleReadInput(input);
  if (driver?.thin !== true || typeof driver.getConnection !== "function")
    throw oracleReadFailure("ORACLE_WIP_DRIVER_UNAVAILABLE");
  let connection, resultSet, failure, result;
  const phase = (value) => {
    check(signal);
    onPhase(value);
    check(signal);
  };
  try {
    phase("connect");
    connection = await driver.getConnection(config.connectionOptions);
    check(signal);
    if (connection?.thin !== true) throw oracleReadFailure();
    connection.callTimeout = 2000;
    phase("setup");
    await connection.execute("SET TRANSACTION READ ONLY", [], {
      autoCommit: false,
    });
    check(signal);
    phase("classify");
    const info = await connection.getStatementInfo(config.sql);
    check(signal);
    if (
      info?.statementType !== driver.STMT_TYPE_SELECT ||
      driver.STMT_TYPE_SELECT === undefined
    )
      throw oracleReadFailure();
    const expectedColumns = oracleReadColumns(info.metaData, driver);
    phase("query");
    const value = await connection.execute(
      config.sql,
      oracleBindParameters(config.binds, driver),
      {
        autoCommit: false,
        resultSet: true,
        outFormat: driver.OUT_FORMAT_ARRAY,
        prefetchRows: 0,
        fetchArraySize: 1,
        keepInStmtCache: false,
        fetchTypeHandler: (metadata) => oracleReadFetchType(metadata, driver),
      },
    );
    // Capture the ResultSet before checking cancellation so cleanup owns it.
    resultSet = value?.resultSet;
    check(signal);
    if (
      !resultSet ||
      typeof resultSet.getRows !== "function" ||
      typeof resultSet.close !== "function"
    )
      throw oracleReadFailure();
    const metadata = value.metaData ?? resultSet.metaData;
    const columns = oracleReadColumns(metadata, driver);
    if (
      columns.length !== expectedColumns.length ||
      columns.some(
        (name, i) =>
          name !== expectedColumns[i] ||
          metadata[i].dbType !== info.metaData[i].dbType,
      )
    )
      throw oracleReadFailure();
    const rows = [];
    let bytes = Buffer.byteLength(JSON.stringify(columns)) + 100;
    let truncated = false;
    for (;;) {
      check(signal);
      const batch = await resultSet.getRows(1);
      check(signal);
      if (!Array.isArray(batch) || batch.length > 1) throw oracleReadFailure();
      if (!batch.length) break;
      if (rows.length === 1000) {
        truncated = true;
        break;
      }
      const row = oracleReadRow(batch[0], metadata, driver);
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > 1024 * 1024) throw oracleReadFailure();
      rows.push(row);
    }
    result = { columns, rows, truncated, limit: 1000 };
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw oracleReadFailure();
  } catch (error) {
    // Never relay raw driver errors, SQL, host details, or credentials.
    failure = oracleReadFailure(
      signal?.aborted ? "ORACLE_WIP_CANCELLED" : "ORACLE_WIP_QUERY_FAILED",
    );
  } finally {
    try {
      onPhase("cleanup");
    } catch {
      failure ??= oracleReadFailure("ORACLE_WIP_CLEANUP_FAILED");
    }
    for (const close of [
      () => resultSet?.close(),
      () => connection?.rollback(),
      () => connection?.close(),
    ]) {
      try {
        await close();
      } catch {
        failure ??= oracleReadFailure("ORACLE_WIP_CLEANUP_FAILED");
      }
    }
  }
  check(signal);
  if (failure) throw failure;
  return result;
}
