import { compileOracleRead } from "./oracle-read-contract.mjs";
import { databaseRows } from "./database-values.mjs";
export async function executeOracleRead(
  input,
  { driver, signal, onClosing = () => {}, setTrustedCertificates } = {},
) {
  const cancelled = () => {
    if (signal?.aborted) throw Error("ORACLE_READ_CANCELLED");
  };
  cancelled();
  const plan = compileOracleRead(input);
  if (plan.certificates.length) {
    if (!setTrustedCertificates) throw Error("ORACLE_ISOLATED_TRUST_REQUIRED");
    setTrustedCertificates(plan.certificates);
  }
  driver ??= (await import("oracledb")).default;
  if (driver.thin !== true) throw Error("ORACLE_THIN_REQUIRED");
  let connection,
    resultSet,
    result,
    failed = false,
    interrupted = false;
  const stop = () => {
    interrupted = true;
    try {
      connection?.break().catch(() => {});
    } catch {}
  };
  signal?.addEventListener("abort", stop, { once: true });
  const check = () => {
    cancelled();
    if (interrupted) throw Error("ORACLE_READ_CANCELLED");
  };
  try {
    check();
    connection = await driver.getConnection(plan.config);
    check();
    if (connection.thin !== true) throw Error();
    connection.callTimeout = 2000;
    await connection.execute("SET TRANSACTION READ ONLY", [], {
      autoCommit: false,
    });
    check();
    const value = await connection.execute(plan.sql, plan.binds, {
      autoCommit: false,
      outFormat: driver.OUT_FORMAT_ARRAY,
      resultSet: true,
      prefetchRows: 0,
      fetchArraySize: 1,
      fetchTypeHandler(meta) {
        const allowed = [
          driver.DB_TYPE_NUMBER,
          driver.DB_TYPE_VARCHAR,
          driver.DB_TYPE_NVARCHAR,
          driver.DB_TYPE_CHAR,
          driver.DB_TYPE_NCHAR,
          driver.DB_TYPE_RAW,
        ];
        if (
          !allowed.includes(meta.dbType) ||
          meta.isJson ||
          meta.isOson ||
          (meta.byteSize !== undefined && meta.byteSize > 32767)
        )
          throw Error();
        if (meta.dbType === driver.DB_TYPE_NUMBER)
          return { type: driver.DB_TYPE_VARCHAR };
        return { type: meta.dbType };
      },
    });
    resultSet = value.resultSet;
    check();
    if (
      !resultSet ||
      !Array.isArray(value.metaData) ||
      value.metaData.length < 1 ||
      value.metaData.length > 128
    )
      throw Error();
    const columns = value.metaData.map((c) => c.name),
      rows = [];
    let bytes = Buffer.byteLength(JSON.stringify(columns)) + 100;
    while (true) {
      check();
      const row = await resultSet.getRow();
      check();
      if (row === undefined) break;
      if (
        !Array.isArray(row) ||
        row.length !== columns.length ||
        rows.length >= 1000
      )
        throw Error();
      for (const v of row)
        if (v !== null && typeof v !== "string" && !Buffer.isBuffer(v))
          throw Error();
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > 1024 * 1024) throw Error();
      rows.push(row);
    }
    result = databaseRows(columns, rows);
  } catch {
    failed = true;
  } finally {
    try {
      onClosing();
    } catch {}
    signal?.removeEventListener("abort", stop);
    if (resultSet)
      try {
        await resultSet.close();
      } catch {
        failed = true;
      }
    if (connection) {
      try {
        await connection.rollback();
      } catch {
        failed = true;
      }
      try {
        await connection.close();
      } catch {
        failed = true;
      }
    }
  }
  check();
  if (failed) throw Error("ORACLE_READ_FAILED_NO_RESULT");
  return result;
}
