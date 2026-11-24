import { isApipostFunctionSource } from "./apipost-function-template.js";

export const maxHTTPPreWaitMilliseconds = 10000;
export const defaultHTTPPreWaitMilliseconds = 1000;

export const hasHTTPPreWaitVersion = (operation) =>
  operation != null && Object.hasOwn(operation, "waitVersion");

export const isHTTPPreWaitMarker = (operation) =>
  operation?.type === "wait" || hasHTTPPreWaitVersion(operation);

export const containsHTTPPreWaitMarker = (operations) =>
  Array.isArray(operations) && operations.some(isHTTPPreWaitMarker);

export function httpPreWaitUnsupported(destination) {
  return Error(
    destination +
      "不支持手动调试前置等待；请在普通 HTTP 调试中执行，或使用项目备份保留定义",
  );
}

export function rejectHTTPPreWait(request, destination) {
  if (
    containsHTTPPreWaitMarker(request?.before) ||
    containsHTTPPreWaitMarker(request?.after)
  )
    throw httpPreWaitUnsupported(destination);
}

// Native function template pipelines contain multiple synchronous transforms in
// one VM unit. This first ordinary Wait slice does not mix with that path.
export function canUseHTTPPreWait(request) {
  if (
    !request ||
    [
      "graphqlEditorVersion",
      "graphqlVariableTemplate",
      "nativeTasks",
      "nativeInheritance",
      "importedNativeTaskSource",
      "importedScriptTasks",
    ].some((key) => request[key] !== undefined) ||
    request.scriptURLMode === "sdk"
  )
    return false;
  const isNativeTemplate = (spec) => isApipostFunctionSource(spec?.source);
  return (
    !Object.values(request.bodyDynamic || {}).some(isNativeTemplate) &&
    !["query", "headers", "path", "cookies", "form"].some(
      (key) =>
        Array.isArray(request[key]) &&
        request[key].some((row) => isNativeTemplate(row?.dynamic)),
    )
  );
}

export function assertHTTPPreWaitEligible(request) {
  if (!canUseHTTPPreWait(request))
    throw Error(
      "前置等待不能与 GraphQL、SDK URL、原版任务或原版动态函数模板混用",
    );
}
