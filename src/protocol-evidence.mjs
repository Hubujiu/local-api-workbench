import { validateProtocolRuns as validateGrpcRuns } from "./grpc.mjs";
import { validateSocketIORecord } from "./socketio.mjs";
export function validateProtocolRuns(values = []) {
  if (!Array.isArray(values) || values.length > 50)
    throw Error("协议执行记录最多50条");
  const ids = new Set();
  for (const record of values) {
    if (
      !record ||
      typeof record.id !== "string" ||
      !record.id ||
      record.id.length > 200 ||
      ids.has(record.id)
    )
      throw Error("协议执行记录ID无效或重复");
    ids.add(record.id);
    if (record.type === "grpc") {
      validateGrpcRuns([record]);
      continue;
    }
    if (
      record.type !== "socketio" ||
      !record.result ||
      !["closed", "error"].includes(record.result.state) ||
      !Array.isArray(record.result.events) ||
      record.result.events.length > 200 ||
      !["passed", "failed", "cancelled"].includes(record.status)
    )
      throw Error("协议执行记录格式无效");
    validateSocketIORecord(record);
    if (Buffer.byteLength(JSON.stringify(record)) > 3 * 1024 * 1024)
      throw Error("协议执行记录超过3MiB");
  }
}
