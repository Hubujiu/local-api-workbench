import { parentPort, workerData } from "node:worker_threads";
import { querySQLite, mutateSQLite } from "./database.mjs";
try {
  if (!workerData || !["read", "write"].includes(workerData.mode))
    throw Error("数据库操作模式无效");
  parentPort.postMessage({
    result: (workerData.mode === "write" ? mutateSQLite : querySQLite)(
      workerData.filename,
      workerData.sql,
      workerData.parameters,
    ),
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
