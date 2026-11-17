import { types } from "node:util";
// Live references are project-local identities. No lookup or network work here.
export function liveRequestId(step) {
  if (!step || typeof step !== "object" || types.isProxy(step))
    throw Error("实时计划步骤无效");
  const field = Object.getOwnPropertyDescriptor(step, "liveRequestId");
  if (!field) return undefined;
  const type = Object.getOwnPropertyDescriptor(step, "type");
  const request = Object.getOwnPropertyDescriptor(step, "request");
  if (
    !field.enumerable ||
    !Object.hasOwn(field, "value") ||
    typeof field.value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(field.value) ||
    (type &&
      (!Object.hasOwn(type, "value") ||
        (type.value !== undefined && type.value !== "http"))) ||
    !request ||
    !Object.hasOwn(request, "value") ||
    !request.value ||
    typeof request.value !== "object" ||
    Object.hasOwn(step, "nativeMCP")
  )
    throw Error("实时计划引用仅支持带冻结任务模板的项目 HTTP 接口 ID");
  return field.value;
}
