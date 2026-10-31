import { postmanOAuth2Definition } from "../public/postman-oauth2-model.js";
import { randomUUID } from "node:crypto";
import { normalizeRequest } from "./core.mjs";
export function snapshotCase(input) {
  if (!input || typeof input.name !== "string" || !input.name.trim())
    throw Error("用例名称不能为空");
  if (typeof input.sourceRequestId !== "string" || !input.sourceRequestId)
    throw Error("用例必须关联接口");
  postmanOAuth2Definition(input.request?.auth);
  return {
    id: input.id || randomUUID(),
    name: input.name.trim().slice(0, 200),
    sourceRequestId: input.sourceRequestId,
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    request: {
      ...normalizeRequest(structuredClone(input.request)),
      serviceSnapshot: true,
      parametersSnapshot: true,
      authSnapshot: true,
      sharedScriptsSnapshot: true,
    },
    functions: structuredClone(input.functions || []),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
