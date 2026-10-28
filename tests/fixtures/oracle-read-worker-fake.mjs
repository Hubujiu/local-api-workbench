// No real driver, sockets, database, services, credentials or module installs.
import { startOracleReadWorker } from "../../src/oracle-read-worker-runtime.mjs";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { fixtureEnvironmentState } from "./oracle-read-worker-environment.mjs";
const environment = fixtureEnvironmentState(
  process.env,
  process.platform,
  process.versions.node,
  process.execArgv.length,
);
// One bounded, KEY-only test diagnostic. Production stderr remains ignored;
// only the test-injected factory pipes/drains this stream. No extra IPC message.
process.stderr.write(`${JSON.stringify(environment.diagnostic)}\n`);
const driver = Object.fromEntries(
  [
    "DB_TYPE_NUMBER",
    "DB_TYPE_VARCHAR",
    "DB_TYPE_CHAR",
    "DB_TYPE_NCHAR",
    "DB_TYPE_NVARCHAR",
    "DB_TYPE_RAW",
    "BIND_IN",
    "OUT_FORMAT_ARRAY",
  ].map((x) => [x, x]),
);
driver.thin = true;
driver.STMT_TYPE_SELECT = "SELECT";
driver.getConnection = async (options) => {
  if (!environment.valid)
    throw Error("fixture child environment isolation check failed");
  if (Object.hasOwn(options, "caCertificatePem"))
    throw Error("CA must not become a driver option");
  if (options.connectString.endsWith("/CUSTOM_CA")) {
    const expected = new X509Certificate(
      readFileSync(new URL("./localhost.crt", import.meta.url)),
    ).toString();
    const certs = tls.getCACertificates("default");
    if (certs.length !== 1 || certs[0] !== expected)
      throw Error("fixture child trust was not replaced with the sole CA");
  }
  let count = 0;
  const metaData = [{ name: "VALUE", dbType: driver.DB_TYPE_NUMBER }];
  return {
    thin: true,
    async execute(sql, _binds, executeOptions) {
      if (sql === "SET TRANSACTION READ ONLY") return {};
      executeOptions.fetchTypeHandler({ ...metaData[0] }, metaData);
      return {
        metaData,
        resultSet: {
          metaData,
          async getRows() {
            if (options.connectString.endsWith("/HANG")) {
              setInterval(() => {}, 1000);
              return new Promise(() => {});
            }
            return count++ ? [] : [["1"]];
          },
          async close() {},
        },
      };
    },
    async getStatementInfo() {
      return { statementType: driver.STMT_TYPE_SELECT, metaData };
    },
    async rollback() {},
    async close() {
      if (options.connectString.endsWith("/LINGER"))
        setInterval(() => {}, 1000);
    },
  };
};
startOracleReadWorker(async () => driver);
