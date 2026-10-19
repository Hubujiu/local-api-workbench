import { parentPort, workerData } from "node:worker_threads";
import { executeMongoQuery } from "./mongodb.mjs";
try {
  parentPort.postMessage({ result: await executeMongoQuery(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
