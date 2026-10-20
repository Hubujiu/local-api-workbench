import { randomUUID } from "node:crypto";
import { normalizeRequest } from "./core.mjs";
export function snapshotCase(input) {
  if (!input || typeof input.name !== "string" || !input.name.trim())
    throw Error("用例名称不能为空");
  if (typeof input.sourceRequestId !== "string" || !input.sourceRequestId)
    throw Error("用例必须关联接口");
  return {
    id: input.id || randomUUID(),
    name: input.name.trim().slice(0, 200),
    sourceRequestId: input.sourceRequestId,
    request: {
      ...normalizeRequest(structuredClone(input.request)),
      serviceSnapshot: true,
      parametersSnapshot: true,
      authSnapshot: true,
    },
    functions: structuredClone(input.functions || []),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
