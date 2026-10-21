import { parentPort, workerData } from "node:worker_threads";
import { querySQLite, mutateSQLite } from "./database.mjs";
try {
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
