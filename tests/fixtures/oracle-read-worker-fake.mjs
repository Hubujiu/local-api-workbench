// No real driver, sockets, database, services, credentials or module installs.
import { startOracleReadWorker } from "../../src/oracle-read-worker-runtime.mjs";
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
  if (Object.keys(process.env).length || process.execArgv.length)
    throw Error("fixture child did not receive empty environment/execArgv");
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
