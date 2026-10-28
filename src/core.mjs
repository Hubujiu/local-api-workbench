import {
  validateRepeatGraph,
  REPEAT_EVIDENCE_BYTES,
  repeatEvidenceExceeded,
  mapPlanLeaves,
  planLeaves,
  planOccurrences,
} from "./plan-repeat.mjs";
import { validateResourceJSON } from "./api-resource-lifecycle.mjs";
import { modelNameMode as resolveModelNameMode } from "./apipost-model-name-mode.mjs";
import { readImportedNativeFlowSource } from "./imported-native-flow-source.mjs";
import {
  normalizeImportedNativeTaskSource,
  validateRequestTaskSource,
  cloneRequestWithTaskSource,
} from "./imported-native-task-source.mjs";
import { prepareDirectoryPlans } from "./apipost-execution-plans.mjs";
import {
  mergeDirectoryArtifacts,
  normalizeDirectoryArtifacts,
} from "./apipost-directory-artifacts.mjs";
import { normalizeNativeTaskRequest } from "./script-database-tasks.mjs";
import {
  runNativeTaskPhase,
  isNativeExtractionPhaseFailure,
} from "./native-task-phase.mjs";

import { normalizeNativeMockRoute } from "./native-mock-route.mjs";
import { normalizeNativeMock } from "./native-mock.mjs";

import { normalizeNativeMCPState } from "./native-mcp-plan.mjs";
import { validateAPIResourceTrash } from "./api-resource-lifecycle.mjs";
import { mergeImportedDocuments } from "./apipost-documents.mjs";
import { resolveProtocolDefinition } from "./protocol-text-templates.mjs";

import { ProjectCommitUncertain } from "./project-commit-outcome.mjs";

import { postmanImportURL } from "./postman-url.mjs";
import {
  normalizeRedirect,
  readHttpRedirectFailure,
  assertRedirectExportable,
} from "./http-redirect.mjs";
import { throwIfInactive } from "./request-control.mjs";
import {
  httpFinalizationFailure,
  readHttpFinalizationFailure,
} from "./http-finalization.mjs";
import { importPostmanGraphQLBody } from "./postman-graphql-body.mjs";
import { postmanEventScripts } from "./postman-event-scripts.mjs";
import { snapshotWireStep, wirePlanCredentials } from "./wire-plan.mjs";
import {
  snapshotSocketIOStep,
  socketioPlanCredentials,
} from "./socketio-plan.mjs";
import {
  snapshotGrpcStep,
  grpcPlanRequest,
  grpcPlanCredentials,
} from "./grpc-plan.mjs";
import { isDeepStrictEqual } from "node:util";
import { sdkOpenAPIDefinition } from "./script-url-openapi.mjs";
import {
  validateApipostTemplateRequest,
  isApipostFunctionSource,
} from "../public/apipost-function-template.js";
import {
  isApipostDirectoryDocument,
  assembleApipostDirectory,
} from "./apipost-directory.mjs";
import { validateCaseFolders } from "../public/case-folders.js";
import { snapshotCase } from "./cases.mjs";
import { importPreservedNativeInheritance } from "./native-inheritance-import.mjs";
import {
  inheritanceMode as resolveInheritanceMode,
  normalizeNativeInheritanceBinding,
  validateNativeInheritanceProject,
} from "./native-inheritance.mjs";
import { openAPIServerURL } from "./openapi-server.mjs";
import {
  openAPIURLQuery,
  openAPIEmptyQueryValue,
} from "./openapi-url-query.mjs";
import { normalizeImportedScriptTasks } from "../public/imported-script-tasks.js";
import { sdkCurlDefinition } from "./script-url-export.mjs";
import { normalizeScriptURLMode } from "../public/script-url-mode.js";
import { validateQueryRuntime } from "./script-url-runtime.mjs";
import { scriptFailureDetails } from "./script-diagnostics.mjs";
import {
  normalizeCookieEncoding,
  requestCookieHeader,
} from "./request-cookies.mjs";
import {
  appendRequestQuery,
  setURLQuery,
  setAPIKeyQuery,
} from "./query-serialization.mjs";
import { requestHeaderMap } from "./request-headers.mjs";
import {
  importResponseExamples,
  appendResponseExamples,
  responseContent,
} from "./openapi-response-examples.mjs";
import {
  referenceChildMode,
  referenceModeIsAllowed,
} from "./openapi-reference-context.mjs";
import { normalizeOpenAPI30Schemas } from "./openapi-schema-export.mjs";
import { schemaReferenceWithSiblings } from "./openapi-schema-reference.mjs";
import { jsonPathSegments } from "./json-path.mjs";
import { importOpenAPIBody, exportOpenAPIBody } from "./openapi-body.mjs";
import { importJwtConfig } from "../public/jwt-auth-model.js";
import { validateModelFolders } from "../public/model-folders.js";
import { normalizeScriptDialect } from "../public/script-dialect.js";
import { scriptStages } from "../public/shared-scripts.js";
import { isModernApipost, importModernApipost } from "./apipost-modern.mjs";
import { builtinVariable } from "./builtin-variables.mjs";
import { apipostDocument, importApipost } from "./apipost-import.mjs";
import { validateAuth } from "../public/auth-model.js";
import { resolveDynamicRequest } from "./dynamic-values.mjs";
import { extractXML } from "./xml-extraction.mjs";
import {
  createScopes,
  effectiveScopes,
  applyLegacyVariables,
  scopeChanges,
} from "./variable-scopes.mjs";
import { parse as parseYAML } from "yaml";
import { runScript, runScriptSequence } from "./scripts.mjs";
import { randomUUID, createHash } from "node:crypto";
export const id = () => randomUUID();
export function interpolate(value, vars = {}) {
  if (typeof value === "string")
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
      if (Object.hasOwn(vars, key)) return String(vars[key]);
      const generated = builtinVariable(key);
      if (generated === undefined) throw Error(`未定义变量: ${key}`);
      return String(generated);
    });
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]),
    );
  return value;
}
export function jsonPath(obj, path) {
  const parts = jsonPathSegments(path);
  for (const p of parts) {
    if (["__proto__", "prototype", "constructor"].includes(p))
      throw Error("禁止的 JSON 路径");
    if (obj === null || obj === undefined || !Object.hasOwn(Object(obj), p))
      return undefined;
    obj = obj[p];
  }
  return obj;
}
export function extractResponseValue(response, extraction) {
  if (
    typeof extraction.name !== "string" ||
    !extraction.name.trim() ||
    ["__proto__", "prototype", "constructor"].includes(extraction.name)
  )
    throw Error("提取变量名称无效");
  const source = extraction.source || "json";
  let value;
  const headers = Object.fromEntries(
    Object.entries(response.headers || {}).map(([key, v]) => [
      key.toLowerCase(),
      v,
    ]),
  );
  if (source === "json")
    value = jsonPath(JSON.parse(response.body), extraction.path);
  else if (source === "header")
    value = headers[String(extraction.path).toLowerCase()];
  else if (source === "duration") value = response.duration;
  else if (source === "text") value = response.body;
  else if (source === "cookie") {
    const setCookie = headers["set-cookie"];
    const lines = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];
    for (const line of lines) {
      const pair = String(line).split(";")[0];
      const separator = pair.indexOf("=");
      if (
        separator > 0 &&
        pair.slice(0, separator).trim() === extraction.path
      ) {
        value = pair.slice(separator + 1).trim();
        break;
      }
    }
  } else throw Error("不支持的提取来源: " + source);
  if (value === undefined)
    throw Error("无法提取 " + (extraction.path || source));
  return value;
}
export async function extractResponse(response, extraction) {
  if (extraction.source === "xml") {
    extractResponseValue(response, { ...extraction, source: "text" });
    return extractXML(response.body, extraction.path, extraction.namespaces);
  }
  if (extraction.source !== "regex")
    return extractResponseValue(response, extraction);
  extractResponseValue(response, { ...extraction, source: "text" });
  const source = String(extraction.path || "");
  const end = source.lastIndexOf("/");
  if (!source.startsWith("/") || end < 1 || source.length > 2000)
    throw Error("正则需要 /表达式/flags 格式，最多 2000 字符");
  const group =
    extraction.group === undefined || extraction.group === ""
      ? 0
      : Number(extraction.group);
  if (!Number.isInteger(group) || group < 0 || group > 99)
    throw Error("正则捕获组必须为 0–99");
  if (Buffer.byteLength(response.body || "") > 256 * 1024)
    throw Error("正则提取响应文本最多 256 KiB");
  const result = await runScript(
    "const match = new RegExp(" +
      JSON.stringify(source.slice(1, end)) +
      "," +
      JSON.stringify(source.slice(end + 1)) +
      ").exec(pm.response.text()); apt.setVar('matched', match && match[" +
      group +
      "] !== undefined); if (match && match[" +
      group +
      "] !== undefined) apt.setVar('value', match[" +
      group +
      "]);",
    { variables: {}, response: { body: response.body } },
  );
  if (!result.variables.matched) throw Error("正则未匹配或捕获组不存在");
  return result.variables.value;
}
export function normalizeRequest(r = {}) {
  const nativeInheritance = normalizeNativeInheritanceBinding(
    r.nativeInheritance,
  );
  if (
    r.nativeMock !== undefined &&
    r.nativeMockRoute !== undefined &&
    r.nativeMock.sourceTargetId !== r.nativeMockRoute.sourceTargetId
  )
    throw Error("Mock路由与响应来源接口不一致");
  if (r.nativeMock !== undefined && r.mockRules?.length)
    throw Error("原版Mock与普通Mock规则不能混用");
  validateRequestTaskSource(r);
  validateApipostTemplateRequest(r);
  const urlMode = normalizeScriptURLMode(r.scriptURLMode);
  if (r.scriptURLRuntime !== undefined && urlMode !== "sdk")
    throw Error("URL状态仅可用于SDK模式");
  if (r.queryAddEqual !== undefined && typeof r.queryAddEqual !== "boolean")
    throw Error("Query等号选项必须为布尔值");
  if (
    r.openapiExampleBindingsVersion !== undefined &&
    r.openapiExampleBindingsVersion !== 1
  )
    throw Error("响应示例绑定版本暂不支持");
  validateAuth(r.auth);
  scriptStages(r, "before");
  scriptStages(r, "after");
  if (!r || typeof r !== "object" || Array.isArray(r))
    throw Error("接口定义必须是对象");
  for (const key of [
    "query",
    "headers",
    "path",
    "cookies",
    "form",
    "assertions",
    "extract",
    "before",
    "after",
    "examples",
    "responses",
  ]) {
    if (
      r[key] !== undefined &&
      (!Array.isArray(r[key]) ||
        r[key].some(
          (item) => !item || typeof item !== "object" || Array.isArray(item),
        ))
    )
      throw Error(key + " 必须是对象数组");
  }
  for (const key of ["auth", "tls", "attributes", "bodyDynamic"])
    if (
      r[key] !== undefined &&
      (!r[key] || typeof r[key] !== "object" || Array.isArray(r[key]))
    )
      throw Error(key + " 必须是对象");
  if (
    r.id !== undefined &&
    (typeof r.id !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(r.id))
  )
    throw Error("接口 ID 无效");
  if (r.httpVersion !== undefined && !["1.1", "2"].includes(r.httpVersion))
    throw Error("不支持的HTTP协议版本");
  const method = String(r.method || "GET").toUpperCase();
  if (
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      method,
    )
  )
    throw Error("不支持的 HTTP 方法");
  if (r.folder !== undefined && typeof r.folder !== "string")
    throw Error("目录名称必须为字符串");
  const url = String(r.url || "");
  if (
    url &&
    !/^https?:\/\//.test(url) &&
    !url.includes("{{") &&
    !(
      (r.serviceId || r.folder) &&
      !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
      !url.startsWith("//")
    )
  )
    throw Error("仅支持 HTTP/HTTPS URL");
  const redirect = normalizeRedirect(r.redirect);
  return {
    ...(nativeInheritance === undefined ? {} : { nativeInheritance }),
    ...(redirect === undefined ? {} : { redirect }),
    id: r.id || id(),
    name: String(r.name || "未命名接口"),
    sourceOperationId: String(r.sourceOperationId || ""),
    serviceId: String(r.serviceId || ""),
    serviceSnapshot: r.serviceSnapshot === true,
    parametersSnapshot: r.parametersSnapshot === true,
    authSnapshot: r.authSnapshot === true,
    sharedScriptsSnapshot: r.sharedScriptsSnapshot === true,
    inheritSharedScripts: r.inheritSharedScripts !== false,
    sharedBeforeScripts: structuredClone(r.sharedBeforeScripts || []),
    sharedAfterScripts: structuredClone(r.sharedAfterScripts || []),
    inheritAuth: r.inheritAuth !== false,
    inheritGlobalParameters: r.inheritGlobalParameters !== false,
    httpVersion: r.httpVersion === "2" ? "2" : "1.1",
    folder: r.folder || "",
    description: r.description || "",
    importNotes: Array.isArray(r.importNotes)
      ? r.importNotes.slice(0, 20).map((note) => String(note).slice(0, 2000))
      : [],
    statusId: String(r.statusId || ""),
    attributes: r.attributes || {},
    method,
    url,
    query: r.query || [],
    queryAddEqual: r.queryAddEqual !== false,
    headers: r.headers || [],
    path: r.path || [],
    cookies: r.cookies || [],
    cookieEncoding: normalizeCookieEncoding(r.cookieEncoding),
    auth: { ...(r.auth || {}), type: r.auth?.type ?? "none" },
    bodyType: r.bodyType || "none",
    body:
      typeof r.body === "string"
        ? r.body
        : r.body == null
          ? ""
          : JSON.stringify(r.body),
    bodyDynamic: r.bodyDynamic || {},
    form: r.form || [],
    assertions: r.assertions || [],
    extract: r.extract || [],
    before: r.before || [],
    scriptDialect: normalizeScriptDialect(r.scriptDialect),
    ...(urlMode === "sdk"
      ? {
          scriptURLMode: "sdk",
          ...(r.scriptURLRuntime !== undefined
            ? { scriptURLRuntime: validateQueryRuntime(r.scriptURLRuntime) }
            : {}),
        }
      : {}),
    ...(r.importedNativeTaskSource === undefined
      ? {}
      : {
          importedNativeTaskSource: normalizeImportedNativeTaskSource(
            r.importedNativeTaskSource,
          ),
        }),
    ...(r.importedScriptTasks === undefined
      ? {}
      : {
          importedScriptTasks: normalizeImportedScriptTasks(
            r.importedScriptTasks,
          ),
        }),
    ...(r.nativeTasks === undefined
      ? {}
      : { nativeTasks: normalizeNativeTaskRequest(r) }),
    beforeScript: r.beforeScript || "",
    afterScript: r.afterScript || "",
    after: r.after || [],
    examples: r.examples || [],
    ...(r.nativeMockRoute === undefined
      ? {}
      : { nativeMockRoute: normalizeNativeMockRoute(r.nativeMockRoute) }),
    ...(r.nativeMock === undefined
      ? {}
      : { nativeMock: normalizeNativeMock(r.nativeMock) }),
    mockRules: r.mockRules || [],
    schema: r.schema ?? {},
    responses: r.responses || [],
    openapiOperation: r.openapiOperation || {},
    ...(r.openapiExampleBindingsVersion === 1
      ? {
          openapiExampleBindingsVersion: 1,
          openapiExampleSources: structuredClone(r.openapiExampleSources || []),
        }
      : {}),
    proxy: r.proxy || "",
    tls: r.tls || {},
    timeout: Math.min(60000, Math.max(100, Number(r.timeout) || 15000)),
    ...("deletedAt" in r ? { deletedAt: r.deletedAt } : {}),
  };
}
export function evaluateAssertions(response, assertions = []) {
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {}
  return assertions.map((a) => {
    let actual =
      a.target === "status"
        ? response.status
        : a.target === "duration"
          ? response.duration
          : a.target === "body"
            ? response.body
            : a.target?.startsWith("header:")
              ? response.headers[a.target.slice(7).toLowerCase()]
              : jsonPath(data, a.target);
    let passed = false;
    switch (a.op) {
      case "eq":
        passed = JSON.stringify(actual) === JSON.stringify(a.value);
        break;
      case "neq":
        passed = JSON.stringify(actual) !== JSON.stringify(a.value);
        break;
      case "contains":
        passed = String(actual ?? "").includes(String(a.value));
        break;
      case "exists":
        passed = actual !== undefined && actual !== null;
        break;
      case "lt":
        passed = Number(actual) < Number(a.value);
        break;
      case "gt":
        passed = Number(actual) > Number(a.value);
        break;
      default:
        throw Error("未知断言操作");
    }
    return { ...a, actual, passed };
  });
}
export function snapshotPlan(plan) {
  const repeated = validateRepeatGraph(plan.steps);
  for (const step of planLeaves(plan.steps || []))
    if (step.request?.nativeInheritance !== undefined)
      throw Error("冻结计划须先解析原生继承图，不能保留live绑定");
  const nativeMCPBudget = { bytes: 0 };
  const importedNativeFlowSource = readImportedNativeFlowSource(plan);
  if (
    plan.statusPolicy !== undefined &&
    !["assertions", "strict200"].includes(plan.statusPolicy)
  )
    throw Error("未知执行状态规则");
  if (!Array.isArray(plan.steps) || plan.steps.length > 200)
    throw Error("执行计划必须包含至多 200 步");
  const snapshot = {
    ...(importedNativeFlowSource === undefined
      ? {}
      : { importedNativeFlowSource }),
    id: plan.id || id(),
    name: plan.name || "新执行计划",
    description: String(plan.description || ""),
    statusPolicy: plan.statusPolicy || "assertions",
    functions: structuredClone(plan.functions || []),
    updatedAt: plan.updatedAt || new Date().toISOString(),
    source: plan.source === "ai" ? "ai" : "manual",
    provenance: plan.provenance || { fields: {}, steps: {} },
    environmentId: plan.environmentId || "",
    createdAt: plan.createdAt || new Date().toISOString(),
    steps: mapPlanLeaves(plan.steps, (s) =>
      s.type === "grpc"
        ? {
            ...snapshotGrpcStep(s),
            id: s.id || id(),
            name: s.name || s.grpc?.definition?.name || "gRPC",
            enabled: s.enabled !== false,
          }
        : s.type === "socketio"
          ? {
              ...snapshotSocketIOStep(s),
              id: s.id || id(),
              name: s.name || s.socketio?.definition?.name || "Socket.IO",
              enabled: s.enabled !== false,
            }
          : s.type === "protocol"
            ? {
                ...snapshotWireStep(s),
                id: s.id || id(),
                name: s.name || s.protocol?.definition?.name || "协议",
                enabled: s.enabled !== false,
              }
            : {
                id: s.id || id(),
                name: s.name || s.request?.name || "步骤",
                enabled: s.enabled !== false,
                request: {
                  ...normalizeRequest(cloneRequestWithTaskSource(s.request)),
                  serviceSnapshot: true,
                  parametersSnapshot: true,
                  authSnapshot: true,
                  sharedScriptsSnapshot: true,
                },
                ...(s.nativeMCP === undefined
                  ? {}
                  : {
                      nativeMCP: normalizeNativeMCPState(
                        s.nativeMCP,
                        s.request,
                        normalizeRequest,
                        nativeMCPBudget,
                      ),
                    }),
                expectedStatus: s.expectedStatus,
              },
    ),
  };
  if (repeated) {
    snapshot.steps = snapshot.steps.map((step) =>
      step.type === "repeat"
        ? {
            type: "repeat",
            id: step.id || id(),
            name: step.name ?? "循环组",
            enabled: step.enabled !== false,
            count: step.count,
            steps: step.steps,
          }
        : step,
    );
    validateRepeatGraph(snapshot.steps, { requireIds: true });
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024)
      throw Error("循环计划冻结定义最多4MiB");
  }
  let sourceBytes =
    importedNativeFlowSource === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(importedNativeFlowSource));
  for (const step of planLeaves(snapshot.steps)) {
    const source = step.request?.importedNativeTaskSource;
    if (source !== undefined)
      sourceBytes += Buffer.byteLength(JSON.stringify(source));
    if (sourceBytes > 4 * 1024 * 1024) throw Error("计划任务来源合计最多4MiB");
  }
  return snapshot;
}
export async function runPlan(
  plan,
  variables,
  execute,
  {
    signal,
    onStep,
    prepareRequest,
    variableScopes,
    onScopeChanges,
    cookieSession,
    databaseQuery,
    executionContext,
    executeGrpc,
    grpcCredentials,
    executeSocketIO,
    socketioCredentials,
    executeProtocol,
    protocolCredentials,
  } = {},
) {
  const runStarted = performance.now();
  readImportedNativeFlowSource(plan);
  const repeated = validateRepeatGraph(plan.steps, { requireIds: true });
  const snapshot = repeated ? snapshotPlan(plan) : structuredClone(plan);
  const wireCredentials = wirePlanCredentials(snapshot, protocolCredentials);
  const credentials = grpcPlanCredentials(snapshot, grpcCredentials);
  const socketCredentials = socketioPlanCredentials(
    snapshot,
    socketioCredentials,
  );
  for (const step of planLeaves(snapshot.steps))
    if (!["grpc", "socketio", "protocol"].includes(step.type))
      step.request.serviceSnapshot = true;
  for (const step of planLeaves(snapshot.steps))
    if (step.request?.nativeTasks !== undefined)
      step.request.nativeTasks = normalizeNativeTaskRequest(step.request);
  let scopes = createScopes(variables, variableScopes);
  const vars = { ...effectiveScopes(scopes) };
  const results = [];
  let progressFailure;
  const occurrences = planOccurrences(snapshot.steps);
  if (!occurrences.length) {
    throw Error("计划没有可执行步骤");
  }
  let evidenceBytes = 0,
    evidenceStopped = false;
  for (const { step, repeat } of occurrences) {
    if (signal?.aborted) break;
    if (repeated && repeatEvidenceExceeded(evidenceBytes)) {
      evidenceStopped = true;
      break;
    }
    if (step.enabled === false) continue;
    const record = {
      stepId: step.id,
      ...(repeat ? { repeat: { ...repeat } } : {}),
      name: step.name,
      startedAt: new Date().toISOString(),
      status: "failed",
      logs: [],
      assertions: [],
      subrequests: [],
      extracted: {},
    };
    let scriptPhase,
      stopAfterExtractionFailure = false,
      extractionPostStarted = false;
    // Policy is derived from the host-normalized frozen tasks, never VM output.
    // Any failure of a step which promises new extracted values stops later
    // steps. After a response arrives its whole processing stage must succeed
    // before scopes may commit. Completed network effects cannot be rolled back.
    const extractionPostPolicy = step.request?.nativeTasks?.after.some(
      (task) => task.type === "pickVars" && task.enabled === 1,
    );
    const extractionRequestPolicy = step.request?.nativeTasks?.before.some(
      (task) => task.type === "pickVars" && task.enabled === 1,
    );
    let committedScopes = structuredClone(scopes);
    const commitScopes = async () => {
      if (signal?.aborted) throw Error("执行已取消，未开始新的变量提交");
      const changes = scopeChanges(committedScopes, scopes);
      if (changes.length && onScopeChanges) {
        try {
          const accepted = await onScopeChanges(changes, signal);
          if (accepted?.globals && accepted?.environment) {
            scopes.globals = accepted.globals;
            scopes.environment = accepted.environment;
          }
        } catch (error) {
          if (error?.code === "PROJECT_COMMIT_UNCERTAIN") {
            record.scopeCommit = { outcome: "unknown", retrySafe: false };
            throw Error(
              "变量持久化提交未确认；请重新读取项目，勿自动重试已完成请求",
            );
          }
          throw Error("变量持久化失败：" + error.message);
        }
      }
      for (const change of changes)
        record.logs.push({
          phase: "variables",
          scope: change.scope,
          name: change.name,
          operation: change.after.exists ? "set" : "unset",
        });
      committedScopes = structuredClone(scopes);
      replaceVariables(vars, effectiveScopes(scopes));
    };
    try {
      if (["grpc", "socketio", "protocol"].includes(step.type)) {
        const isGrpc = step.type === "grpc";
        const validated = isGrpc
          ? snapshotGrpcStep(step)
          : step.type === "protocol"
            ? snapshotWireStep(step)
            : snapshotSocketIOStep(step);
        const executor = isGrpc
          ? executeGrpc
          : step.type === "protocol"
            ? executeProtocol
            : executeSocketIO;
        if (!executor) throw Error("此执行入口未授权" + step.type + "调用");
        record.type = step.type;
        record[step.type] = structuredClone(validated[step.type]);
        let request;
        if (isGrpc) {
          const messages = interpolate(validated.grpc.messages, vars);
          record.grpc.messages = messages;
          request = {
            ...grpcPlanRequest(validated, messages),
            ...credentials.get(step.id),
          };
        } else if (step.type === "protocol") {
          const mode = validated.protocol.definition.templateMode;
          const definition = resolveProtocolDefinition(
            validated.protocol.definition,
            vars,
            validated.protocol.message,
          );
          const message =
            validated.protocol.message === undefined
              ? undefined
              : mode === "variables"
                ? definition.message
                : mode === "literal"
                  ? validated.protocol.message
                  : interpolate(validated.protocol.message, vars);
          // SSE body and WS/TCP message in the result are the actual resolved payload.
          if (definition.type !== "sse") delete definition.message;
          record.protocol.definition = definition;
          if (message !== undefined) record.protocol.message = message;
          request = {
            ...validated.protocol,
            definition,
            ...(message !== undefined ? { message } : {}),
            ...wireCredentials.get(step.id),
          };
        } else {
          const commands = interpolate(validated.socketio.commands, vars);
          record.socketio.commands = commands;
          request = {
            ...validated.socketio,
            commands,
            ...socketCredentials.get(step.id),
          };
        }
        const result = await executor(request, signal);
        if (isGrpc)
          record.grpcResult = { ...result, metadata: [], trailers: [] };
        else if (step.type === "protocol") record.protocolResult = result;
        else record.socketioResult = result;
        const protocolStatus = isGrpc ? result.status.code : result.status;
        const evidence = {
          status: protocolStatus,
          duration: result.durationMs,
          headers: {},
          body: JSON.stringify(
            isGrpc
              ? result.messages
              : step.type === "protocol"
                ? result.result
                : result.results,
          ),
        };
        record.assertions = evaluateAssertions(evidence, validated.assertions);
        record.status =
          protocolStatus === validated.expectedStatus &&
          record.assertions.every((a) => a.passed)
            ? "passed"
            : "failed";
        if (signal?.aborted) throw Error("执行已取消，未开始新的协议变量提交");
        if (record.status === "passed") {
          // Resolve the entire ordinary protocol extraction batch without
          // publishing any scope or receipt. A later missing path must not
          // expose earlier values to the next (still permitted) HTTP step.
          const nextScopes = structuredClone(scopes),
            extracted = {};
          for (const extraction of validated.extract) {
            const value = extractResponseValue(evidence, extraction);
            const destination = extraction.scope || "runtime";
            if (destination === "runtime") {
              nextScopes.runtime[extraction.name] = value;
              nextScopes.hidden = nextScopes.hidden.filter(
                (name) => name !== extraction.name,
              );
            } else if (destination === "environment")
              nextScopes.environment[extraction.name] = value;
            else if (destination === "global")
              nextScopes.globals[extraction.name] = value;
            else
              throw Error("协议计划提取仅支持runtime/environment/global作用域");
            extracted[extraction.name] = value;
          }
          const changes = scopeChanges(scopes, nextScopes);
          if (changes.length && onScopeChanges) {
            try {
              const accepted = await onScopeChanges(changes, signal);
              if (accepted?.globals && accepted?.environment) {
                nextScopes.globals = accepted.globals;
                nextScopes.environment = accepted.environment;
              }
            } catch (error) {
              if (error instanceof ProjectCommitUncertain) {
                record.scopeCommit = { outcome: "unknown", retrySafe: false };
                throw Error(
                  "协议变量持久化提交未确认；请重新读取项目，勿自动重试已完成请求",
                );
              }
              throw Error(
                "协议变量持久化失败；当前执行未采纳本批提取，勿重放已完成请求",
              );
            }
          }
          // A confirmed storage write is not undone if cancellation arrives
          // during its acknowledgement. Publish the same complete local batch.
          scopes = nextScopes;
          committedScopes = structuredClone(scopes);
          record.extracted = extracted;
          for (const change of changes)
            record.logs.push({
              phase: "variables",
              scope: change.scope,
              name: change.name,
              operation: change.after.exists ? "set" : "unset",
            });
          replaceVariables(vars, effectiveScopes(scopes));
        }
      } else {
        validateApipostTemplateRequest(step.request);
        const executeOperation = async (operation, budget) => {
          if (operation.type !== "database")
            return applyOperation(operation, vars);
          if (
            operation.enabled !== undefined &&
            typeof operation.enabled !== "boolean"
          )
            throw Error("数据库操作启用标识必须为布尔值");
          if (operation.enabled === false) return;
          if (
            operation.path !== undefined &&
            (typeof operation.path !== "string" || operation.path.length > 1000)
          )
            throw Error("数据库提取路径无效");
          if ((operation.parameters || []).length > 1000)
            throw Error("数据库绑定参数最多1000项");
          if (++budget.count > 5 || performance.now() > budget.deadline)
            throw Error("每阶段数据库操作最多5项、累计10秒");
          if (!databaseQuery) throw Error("此执行入口未授权数据库前后置操作");
          if (
            !operation.name ||
            typeof operation.name !== "string" ||
            operation.name.length > 100 ||
            ["__proto__", "constructor", "prototype"].includes(operation.name)
          )
            throw Error("数据库结果变量名无效");
          if (
            typeof operation.connectionId !== "string" ||
            typeof operation.sql !== "string" ||
            operation.sql.length > 50000 ||
            !Array.isArray(operation.parameters ?? [])
          )
            throw Error("数据库操作配置无效");
          const result = await databaseQuery(
            {
              connectionId: operation.connectionId,
              sql: operation.sql,
              parameters: interpolate(operation.parameters || [], vars),
            },
            signal,
          );
          if (signal?.aborted) throw Error("数据库操作已取消");
          if (performance.now() > budget.deadline)
            throw Error("数据库阶段超过10秒，结果未应用");
          const value = jsonPath(result, operation.path || "$");
          if (value === undefined) throw Error("数据库结果提取路径不存在");
          vars[operation.name] = structuredClone(value);
        };
        const beforeOperations = { ...vars };
        const beforeDatabaseBudget = {
          count: 0,
          deadline: performance.now() + 10000,
        };
        for (const operation of step.request.before || []) {
          await executeOperation(operation, beforeDatabaseBudget);
          record.logs.push({
            phase: "before",
            type: operation.type,
            name: operation.name,
          });
        }
        applyLegacyVariables(scopes, beforeOperations, vars);
        const localVariables = {};
        let configuredRequest = structuredClone(step.request),
          finalizedBody;
        const beforeStages = scriptStages(configuredRequest, "before");
        if (
          beforeStages.length ||
          configuredRequest.nativeTasks?.before.length
        ) {
          const templateRequest =
            ["query", "headers", "path", "cookies", "form"].some((group) =>
              (configuredRequest[group] || []).some((row) =>
                isApipostFunctionSource(row.dynamic?.source),
              ),
            ) ||
            Object.values(configuredRequest.bodyDynamic || {}).some((spec) =>
              isApipostFunctionSource(spec?.source),
            );
          const templateSnapshot = templateRequest
            ? structuredClone(configuredRequest)
            : null;
          scriptPhase = "before";
          const scripted = await (
            configuredRequest.nativeTasks
              ? runNativeTaskPhase
              : configuredRequest.sharedBeforeScripts?.length
                ? runScriptSequence
                : runScript
          )(
            configuredRequest.nativeTasks
              ? configuredRequest.nativeTasks.before
              : configuredRequest.sharedBeforeScripts?.length
                ? beforeStages
                : configuredRequest.beforeScript,
            {
              allowNetwork: true,
              executionContext,
              variables: vars,
              scopes,
              localVariables,
              functions: snapshot.functions || [],
              request: configuredRequest,
            },
            { signal, cookieSession, databaseQuery },
          );
          if (scripted.databaseQueries?.length)
            (record.databaseQueries ||= []).push(
              ...scripted.databaseQueries.map((item) => ({
                ...item,
                phase: "before",
              })),
            );
          record.subrequests.push(
            ...scripted.networkRequests.map((item) => ({
              ...item,
              phase: "before",
            })),
          );
          record.logs.push(
            ...scripted.logs.map((message) => ({ phase: "before", message })),
          );
          record.assertions.push(
            ...scripted.tests.map((test) => ({ ...test, phase: "before" })),
          );
          if (scripted.tests.some((test) => !test.passed))
            throw Error("前置脚本断言失败");
          if (
            configuredRequest.nativeTasks &&
            !isDeepStrictEqual(
              configuredRequest.nativeTasks,
              scripted.request.nativeTasks,
            )
          )
            throw Error("脚本不能改写本次冻结的原版任务列表");
          scopes = createScopes(scripted.variables, scripted.scopes);
          replaceVariables(vars, effectiveScopes(scopes));
          replaceVariables(localVariables, scripted.localVariables || {});
          if (
            templateSnapshot &&
            (!isDeepStrictEqual(templateSnapshot, scripted.request) ||
              scripted.finalBody !== undefined)
          )
            throw Error(
              "原版模板前置脚本暂仅允许变量修改，不支持请求修改或最终正文覆盖",
            );
          if (
            !isDeepStrictEqual(
              normalizeRedirect(step.request.redirect),
              normalizeRedirect(scripted.request?.redirect),
            )
          )
            throw Error("前置脚本不能更改 HTTP 重定向策略");
          configuredRequest = normalizeRequest(scripted.request);
          finalizedBody = scripted.finalBody;
        }
        await commitScopes();
        record.request = await resolveDynamicRequest(
          configuredRequest,
          {
            ...vars,
            ...localVariables,
          },
          snapshot.functions || [],
          interpolate,
          finalizedBody,
        );
        if (prepareRequest) record.request = prepareRequest(record.request);
        record.response = await execute(record.request, signal, {
          cookieSession,
        });
        // Preserve a completed response, but never run post-response work after
        // cancellation (including a session whose capture had no Set-Cookie).
        try {
          throwIfInactive({ signal });
        } catch (error) {
          throw httpFinalizationFailure(
            record.response,
            error,
            "response-finalization",
          );
        }
        extractionPostStarted =
          extractionPostPolicy === true || extractionRequestPolicy === true;
        if (record.response.cookieError)
          record.logs.push({
            phase: "cookies",
            message: record.response.cookieError,
          });
        record.assertions.push(
          ...evaluateAssertions(record.response, record.request.assertions).map(
            (assertion) => ({ ...assertion, phase: "response" }),
          ),
        );
        // Resolve and validate the entire list before publishing any values.
        // HTTP status/assertion failures still permit extraction, and successful
        // lists remain visible to the existing post operations and script phase.
        const resolvedExtractions = [];
        for (const extraction of record.request.extract) {
          const value = await extractResponse(record.response, extraction);
          const destination = extraction.scope || "runtime";
          if (
            !["local", "environment", "global", "runtime"].includes(destination)
          )
            throw Error("未知提取变量作用域");
          resolvedExtractions.push({
            name: extraction.name,
            destination,
            value,
          });
        }
        for (const { name, destination, value } of resolvedExtractions) {
          if (destination === "local") localVariables[name] = value;
          else if (destination === "environment")
            scopes.environment[name] = value;
          else if (destination === "global") scopes.globals[name] = value;
          else {
            scopes.runtime[name] = value;
            scopes.hidden = scopes.hidden.filter((hidden) => hidden !== name);
          }
          record.extracted[name] = value;
        }
        replaceVariables(vars, effectiveScopes(scopes));
        const beforeAfterOperations = { ...vars };
        const afterDatabaseBudget = {
          count: 0,
          deadline: performance.now() + 10000,
        };
        for (const operation of record.request.after || []) {
          await executeOperation(operation, afterDatabaseBudget);
          record.logs.push({
            phase: "after",
            type: operation.type,
            name: operation.name,
          });
        }
        applyLegacyVariables(scopes, beforeAfterOperations, vars);
        const afterStages = scriptStages(record.request, "after");
        if (afterStages.length || record.request.nativeTasks?.after.length) {
          scriptPhase = "after";
          const scripted = await (
            record.request.nativeTasks
              ? runNativeTaskPhase
              : record.request.sharedAfterScripts?.length
                ? runScriptSequence
                : runScript
          )(
            record.request.nativeTasks
              ? record.request.nativeTasks.after
              : record.request.sharedAfterScripts?.length
                ? afterStages
                : record.request.afterScript,
            {
              allowNetwork: true,
              executionContext,
              variables: vars,
              scopes,
              localVariables,
              functions: snapshot.functions || [],
              request: record.request,
              response: record.response,
            },
            { signal, cookieSession, databaseQuery },
          );
          if (scripted.databaseQueries?.length)
            (record.databaseQueries ||= []).push(
              ...scripted.databaseQueries.map((item) => ({
                ...item,
                phase: "after",
              })),
            );
          record.subrequests.push(
            ...scripted.networkRequests.map((item) => ({
              ...item,
              phase: "after",
            })),
          );
          record.visualization = scripted.visualization;
          if (scripted.responseOverride)
            record.scriptResponse = scripted.responseOverride;
          scopes = createScopes(scripted.variables, scripted.scopes);
          replaceVariables(vars, effectiveScopes(scopes));
          record.logs.push(
            ...scripted.logs.map((message) => ({ phase: "after", message })),
          );
          record.assertions.push(
            ...scripted.tests.map((test) => ({ ...test, phase: "after" })),
          );
        }
        if (!extractionPostPolicy && !extractionRequestPolicy)
          await commitScopes();
        const hasStatusAssertion = record.assertions.some(
          (a) => a.target === "status",
        );
        const statusOK =
          snapshot.statusPolicy === "strict200"
            ? record.response.status === 200
            : step.expectedStatus !== undefined
              ? record.response.status === step.expectedStatus
              : hasStatusAssertion ||
                (record.response.status >= 200 && record.response.status < 300);
        record.status =
          statusOK && record.assertions.every((a) => a.passed)
            ? "passed"
            : "failed";
        if (extractionPostStarted && record.status !== "passed")
          throw Error(
            extractionRequestPolicy
              ? "原生提取请求响应阶段失败；仅后置变量变更未提交，成功前置变量已提交"
              : "原生响应提取阶段断言或原始响应状态失败，变量未提交",
          );
        if (extractionPostPolicy || extractionRequestPolicy)
          await commitScopes();
      }
    } catch (error) {
      stopAfterExtractionFailure =
        extractionPostPolicy ||
        extractionRequestPolicy ||
        isNativeExtractionPhaseFailure(error);
      const redirected = readHttpRedirectFailure(error);
      if (redirected) {
        if (redirected.response) record.response = redirected.response;
        record.redirectFailure = redirected.failure;
      }
      const completed = readHttpFinalizationFailure(error);
      if (completed) {
        record.response = completed.response;
        record.failure = completed.failure;
      }
      record.status = "failed";
      if (error.databaseQueries?.length)
        (record.databaseQueries ||= []).push(
          ...error.databaseQueries.map((item) => ({
            ...item,
            phase: scriptPhase,
          })),
        );
      if (error.networkRequests)
        record.subrequests.push(
          ...error.networkRequests.map((item) => ({
            ...item,
            phase: scriptPhase,
          })),
        );
      if (extractionPostStarted) scopes = structuredClone(committedScopes);
      else {
        scopes.environment = committedScopes.environment;
        scopes.globals = committedScopes.globals;
      }
      record.error = error.message;
      Object.assign(record, scriptFailureDetails(error));
      if (["grpc", "socketio", "protocol"].includes(step.type)) {
        record.type = step.type;
        record[step.type] ||= structuredClone(step[step.type]);
      } else if (!record.request) {
        record.request = structuredClone(step.request);
        record.requestUnresolved = true;
      }
    }
    replaceVariables(vars, effectiveScopes(scopes));
    results.push(record);
    if (repeated) evidenceBytes += Buffer.byteLength(JSON.stringify(record));
    try {
      await onStep?.(record);
    } catch {
      // The completed response is evidence, even when its progress observer fails.
      // Stop before another request; do not recast this as a transport failure.
      progressFailure = {
        code: "EXECUTION_PROGRESS_FAILED",
        message:
          "Execution stopped because progress reporting failed; inspect saved results, do not replay.",
        retry_safe: false,
      };
      record.progressFailure = progressFailure;
      break;
    }
    if (stopAfterExtractionFailure) break;
    if (record.failure || record.redirectFailure) break;
  }
  return {
    id: id(),
    planId: plan.id,
    planName: plan.name,
    durationMs: Math.max(0, performance.now() - runStarted),
    planHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    snapshot,
    createdAt: new Date().toISOString(),
    status: signal?.aborted
      ? "cancelled"
      : !progressFailure &&
          !evidenceStopped &&
          results.every((r) => r.status === "passed")
        ? "passed"
        : "failed",
    ...(evidenceStopped
      ? {
          stopReason: "evidence-limit",
          evidenceBudget: {
            limitBytes: REPEAT_EVIDENCE_BYTES,
            recordedBytes: evidenceBytes,
            executed: results.length,
            remaining: occurrences.length - results.length,
            last: {
              stepId: results.at(-1).stepId,
              ...(results.at(-1).repeat
                ? { repeat: results.at(-1).repeat }
                : {}),
            },
            next: {
              stepId: occurrences[results.length].step.id,
              ...(occurrences[results.length].repeat
                ? { repeat: occurrences[results.length].repeat }
                : {}),
            },
          },
        }
      : {}),
    ...(progressFailure
      ? { stopReason: "progress-failure", progressFailure }
      : {}),
    results,
    initialVariables: structuredClone(variables),
    variables: vars,
  };
}
export function applyOperation(op, vars) {
  if (!op.name || ["__proto__", "constructor", "prototype"].includes(op.name))
    throw Error("变量名无效");
  switch (op.type) {
    case "set":
      vars[op.name] = interpolate(op.value, vars);
      break;
    case "uuid":
      vars[op.name] = id();
      break;
    case "timestamp":
      vars[op.name] = Date.now();
      break;
    case "delete":
      delete vars[op.name];
      break;
    default:
      throw Error("仅支持声明式 set/uuid/timestamp/delete 前后置操作");
  }
}
export function importDocument(doc) {
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      if (doc.trim().startsWith("curl ")) return [importCurl(doc)];
      doc = parseYAML(doc, { maxAliasCount: 100, uniqueKeys: true });
    }
  }
  if (!doc || typeof doc !== "object") throw Error("无法识别导入格式");
  if (isApipostDirectoryDocument(doc))
    throw Error("原版目录须使用完整项目导入以保留环境及资源");
  if (doc.openapi || doc.swagger) {
    doc = resolveLocalReferences(doc);
    const base = doc.host
      ? `${doc.schemes?.[0] || "https"}://${doc.host}${doc.basePath || ""}`
      : "{{baseUrl}}";
    return Object.entries(doc.paths || {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([m]) =>
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(
            m,
          ),
        )
        .map(([method, op]) => {
          const importedBody = importOpenAPIBody(op.requestBody);
          const normalizedResponses = Object.fromEntries(
            Object.entries(op.responses || {}).map(([status, response]) => [
              status,
              {
                ...response,
                content: responseContent(
                  response,
                  op.produces || doc.produces || ["application/json"],
                ),
              },
            ]),
          );
          const responseExamples = importResponseExamples(normalizedResponses);
          const params = [
            ...new Map(
              [...(item.parameters || []), ...(op.parameters || [])].map(
                (parameter) => [parameter.in + ":" + parameter.name, parameter],
              ),
            ).values(),
          ];
          const selectedSecurity = Object.hasOwn(op, "security")
            ? op.security
            : doc.security;
          return normalizeRequest({
            ...(Array.isArray(selectedSecurity) && selectedSecurity.length === 0
              ? { inheritAuth: false }
              : {}),
            name: op.summary || op.operationId || path,
            sourceOperationId: op.operationId || "",
            method,
            url:
              (openAPIServerURL(op.servers, item.servers, doc.servers) ??
                base) + path,
            openapiOperation: structuredClone({
              ...op,
              ...((op.security ?? doc.security)
                ? { security: op.security ?? doc.security }
                : {}),
            }),
            description: op.description || "",
            folder: op.tags?.[0] || "",
            query: params
              .filter((p) => p.in === "query")
              .map((p) => ({
                key: p.name,
                ...openAPIEmptyQueryValue(p.allowEmptyValue),
                schema: p.schema ?? { type: p.type || "string" },
                required: p.required === true,
                description: p.description || "",
                value: p.example ?? p.schema?.default ?? "",
                enabled: true,
              })),
            path: params
              .filter((p) => p.in === "path")
              .map((p) => ({
                key: p.name,
                schema: p.schema ?? { type: p.type || "string" },
                required: p.required === true,
                description: p.description || "",
                value: p.example ?? "",
                enabled: true,
              })),
            headers: [
              ...params
                .filter((p) => p.in === "header")
                .map((p) => ({
                  key: p.name,
                  schema: p.schema ?? { type: p.type || "string" },
                  required: p.required === true,
                  description: p.description || "",
                  value: p.example ?? "",
                  enabled: true,
                })),
              ...(importedBody.contentType
                ? [
                    {
                      key: "Content-Type",
                      value: importedBody.contentType,
                      enabled: true,
                    },
                  ]
                : []),
            ],
            cookies: params
              .filter((p) => p.in === "cookie")
              .map((p) => ({
                key: p.name,
                schema: p.schema ?? { type: p.type || "string" },
                required: p.required === true,
                description: p.description || "",
                value: p.example ?? p.schema?.default ?? "",
                enabled: true,
              })),
            bodyType: importedBody.bodyType,
            body: importedBody.body,
            form: importedBody.form,
            schema: importedBody.schema,
            responses: Object.entries(normalizedResponses).map(
              ([status, response]) => ({
                ...Object.fromEntries(
                  Object.entries(response).filter(
                    ([key]) => key === "links" || key.startsWith("x-"),
                  ),
                ),
                status,
                description: response.description || "",
                content: response.content || {
                  "application/json": { schema: response.schema ?? {} },
                },
                headers: response.headers || {},
              }),
            ),
            examples: responseExamples.examples,
            importNotes: responseExamples.importNotes,
            openapiExampleBindingsVersion: 1,
            openapiExampleSources: responseExamples.openapiExampleSources,
          });
        }),
    );
  }
  if (doc.info && doc.item) {
    const auth = (config) => {
      if (!config || config.type === "noauth") return { type: "none" };
      if (
        config.type === "awsv4" &&
        (config.awsv4 || []).filter((item) => item.key === "addAuthDataToQuery")
          .length > 1
      )
        throw Error("Postman AWS Query认证开关重复");
      const values = Object.fromEntries(
        (config[config.type] || []).map((item) => [item.key, item.value]),
      );
      if (config.type === "jwt") return importJwtConfig(values);
      if (config.type === "bearer")
        return { type: "bearer", token: values.token || "" };
      if (config.type === "digest")
        return {
          type: "digest",
          username: values.username || "",
          password: values.password || "",
        };
      if (config.type === "edgegrid")
        return {
          type: "edgegrid",
          ...Object.fromEntries(
            [
              "clientToken",
              "clientSecret",
              "accessToken",
              "baseURL",
              "headersToSign",
              "maxBodySize",
              "nonce",
              "timestamp",
            ]
              .filter((key) => values[key] !== undefined)
              .map((key) => [key, values[key]]),
          ),
        };
      if (config.type === "hawk") {
        if (values.user) throw Error("尚不支持Postman Hawk user扩展");
        return {
          type: "hawk",
          id: values.authId,
          key: values.authKey,
          algorithm: values.algorithm || "sha256",
          nonce: values.nonce,
          timestamp: values.timestamp,
          ext: values.extraData,
          app: values.app,
          dlg: values.delegation,
          payloadHash:
            values.includePayloadHash === true ||
            values.includePayloadHash === "true"
              ? "enabled"
              : "disabled",
        };
      }
      if (config.type === "awsv4")
        return {
          type: "aws",
          ...Object.fromEntries(
            [
              "accessKey",
              "secretKey",
              "sessionToken",
              "region",
              "service",
              "addAuthDataToQuery",
            ]
              .filter((key) => values[key] !== undefined)
              .map((key) => [key, values[key]]),
          ),
        };
      if (config.type === "oauth1")
        return {
          type: "oauth1",
          ...Object.fromEntries(
            [
              "consumerKey",
              "consumerSecret",
              "accessToken",
              "tokenSecret",
              "signatureMethod",
              "privateKey",
              "privateKeyPassphrase",
              "nonce",
              "timestamp",
              "realm",
              "version",
              "callback",
              "verifier",
            ]
              .filter((key) => values[key] !== undefined)
              .map((key) => [key, values[key]]),
          ),
        };
      if (config.type === "oauth2")
        return { type: "oauth2", token: values.accessToken || "" };
      if (config.type === "basic")
        return {
          type: "basic",
          username: values.username || "",
          password: values.password || "",
        };
      if (config.type === "apikey")
        return {
          type: "apiKey",
          key: values.key,
          value: values.value,
          in: values.in || "header",
        };
      throw Error("尚不支持导入 Postman 认证类型: " + config.type);
    };
    const walk = (
      items,
      folder = "",
      inheritedAuth = doc.auth,
      inheritedEvents = postmanEventScripts(doc.event),
    ) =>
      items.flatMap((item) => {
        const currentEvents = postmanEventScripts(item.event, inheritedEvents);
        if (item.item)
          return walk(
            item.item,
            folder ? folder + "/" + item.name : item.name,
            item.auth || inheritedAuth,
            currentEvents,
          );
        const req =
            typeof item.request === "string"
              ? { url: item.request }
              : item.request || {},
          body = req.body || {};
        if (
          Object.hasOwn(body, "disabled") &&
          typeof body.disabled !== "boolean"
        )
          throw Error("Postman正文disabled必须为布尔值");
        if (
          body.mode !== undefined &&
          !["raw", "urlencoded", "formdata", "file", "graphql"].includes(
            body.mode,
          )
        )
          throw Error("不支持的Postman正文模式");
        const disabled = body.disabled === true;
        if (!disabled && body.mode === "file")
          throw Error("不自动导入Postman二进制文件正文，请显式选择文件");
        const graphql =
          !disabled && body.mode === "graphql"
            ? importPostmanGraphQLBody(body)
            : undefined;
        const queries =
          req.url && typeof req.url === "object" ? req.url.query || [] : [];
        const rawURL = postmanImportURL(req.url, queries.length > 0);
        const mode = disabled
          ? "none"
          : body.mode === "raw"
            ? body.options?.raw?.language === "json"
              ? "json"
              : "raw"
            : body.mode === "urlencoded"
              ? "urlencoded"
              : body.mode === "formdata"
                ? "form-data"
                : "none";
        return [
          normalizeRequest({
            name: item.name,
            folder,
            method: req.method,
            url: rawURL,
            description:
              typeof req.description === "string"
                ? req.description
                : req.description?.content || "",
            auth: auth(req.auth || inheritedAuth),
            ...((req.auth || inheritedAuth)?.type === "noauth"
              ? { inheritAuth: false }
              : {}),
            headers: (req.header || []).map((h) => ({
              key: h.key,
              value: h.value,
              enabled: !h.disabled,
            })),
            query: queries.map((q) => ({
              key: q.key,
              value: q.value,
              enabled: !q.disabled,
            })),
            path: (req.url?.variable || []).map((v) => ({
              key: v.key,
              value: v.value,
              enabled: true,
            })),
            bodyType: graphql?.bodyType ?? mode,
            body: disabled ? "" : graphql ? graphql.body : body.raw || "",
            form: (disabled
              ? []
              : body.mode === "urlencoded"
                ? body.urlencoded || []
                : body.mode === "formdata"
                  ? body.formdata || []
                  : []
            ).map((f) => ({
              key: f.key,
              value: f.type === "file" ? "" : f.value,
              enabled: !f.disabled,
              type: f.type === "file" ? "file" : "text",
              requiresFile: f.type === "file",
              filename:
                f.type === "file"
                  ? String(f.src || "")
                      .split(/[\\/]/)
                      .at(-1)
                  : undefined,
            })),
            beforeScript: currentEvents.prerequest.join("\n"),
            afterScript: currentEvents.test.join("\n"),
            examples: (item.response || []).map((example) => ({
              name: example.name,
              status: example.code || 200,
              body: example.body || "",
            })),
          }),
        ];
      });
    return walk(doc.item);
  }
  if (isModernApipost(apipostDocument(doc)))
    throw Error("Apipost现代JSON需要完整项目导入，不能丢弃环境依赖");
  if (apipostDocument(doc)) {
    const imported = importApipost(doc);
    if (imported.documents.length)
      throw Error("原生文档须使用完整项目导入，不会丢弃文档正文");
    return imported.requests.map(normalizeRequest);
  }
  if (Array.isArray(doc.requests)) return doc.requests.map(normalizeRequest);
  throw Error("无法识别导入格式");
}
function curlEncodedLiteral(value) {
  const equal = value.indexOf("=");
  if (value.includes("\0")) throw Error("cURL参数不能包含NUL");
  if (equal < 0 && value.includes("@"))
    throw Error("不自动读取 cURL 文件，请使用文件选择器");
  const encoded = encodeURIComponent(equal < 0 ? value : value.slice(equal + 1))
    .replace(
      /[!'()*]/g,
      (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replaceAll("%20", "+");
  return (equal > 0 ? value.slice(0, equal) + "=" : "") + encoded;
}
function appendCurlQuery(url, parts) {
  const query = parts
    .map((value) => {
      if (
        !value ||
        value.length > 65536 ||
        /[^A-Za-z0-9._~!$&()*+,;=:@\/?%\[\]{}-]/.test(value) ||
        /%(?![0-9a-fA-F]{2})/.test(value)
      )
        throw Error(
          "cURL查询片段须为非空、已编码的URL文本且不超过64KiB；请使用--data-urlencode或--url-query",
        );
      return value.replace(/%[0-9a-fA-F]{2}/g, (escape) =>
        escape.toLowerCase(),
      );
    })
    .join("&");
  if (query.length > 65536) throw Error("cURL查询数据超过64KiB");
  const hash = url.indexOf("#");
  const head = hash < 0 ? url : url.slice(0, hash),
    fragment = hash < 0 ? "" : url.slice(hash);
  return (
    head +
    (head.includes("?")
      ? head.indexOf("?") === head.length - 1 || head.endsWith("&")
        ? ""
        : "&"
      : "?") +
    query +
    fragment
  );
}
export function importCurl(source) {
  const tokens = shellTokens(source);
  const clean = (value) => value;
  if (tokens[0] !== "curl") throw Error("命令必须以 curl 开始");
  let r = { headers: [], method: "GET" };
  let explicitMethod = false,
    proxyTunnel = false,
    noProxy,
    dataKind,
    getQuery = false;
  const queryParts = [];
  const setURL = (value) => {
    if (r.url) throw Error("暂不支持一条cURL中的多个URL");
    r.url = value;
  };
  for (let i = 1; i < tokens.length; i++) {
    const t = clean(tokens[i]);
    if (t === "--disable" || t === "-q") {
      if (i !== 1) throw Error("禁用cURL默认配置的参数必须位于首位");
    } else if (t === "-X" || t === "--request") {
      r.method = clean(tokens[++i]);
      explicitMethod = true;
      if (!r.method) throw Error("缺少 HTTP 方法");
    } else if (t === "-H" || t === "--header") {
      const h = clean(tokens[++i]);
      if (!h || (!h.includes(":") && !h.endsWith(";")))
        throw Error("无效 Header");
      const n = h.indexOf(":");
      const key = n < 0 ? h.slice(0, -1) : h.slice(0, n);
      const value = n < 0 ? "" : h.slice(n + 1).trim();
      if (!key.trim()) throw Error("无效 Header");
      r.headers.push({
        key,
        value,
        enabled: n < 0 || value !== "",
      });
    } else if (
      [
        "-d",
        "--data",
        "--data-ascii",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
        "--json",
      ].includes(t)
    ) {
      let value = clean(tokens[++i]);
      if (value === undefined) throw Error("缺少 cURL 请求体参数");
      const kind = t === "--json" ? "json" : "data";
      if (r.bodyType === "form-data" || (dataKind && dataKind !== kind))
        throw Error("暂不支持混用不同 cURL 请求体类型");
      if (dataKind === "data" && r.body === "")
        throw Error(
          "重复空片段的 cURL 行为随版本不同，请合并为单个 --data-raw 参数",
        );
      if (t === "--data-urlencode") value = curlEncodedLiteral(value);
      else if (t !== "--data-raw" && value.startsWith("@"))
        throw Error("不自动读取 cURL 文件，请使用文件选择器");
      r.body = (r.body ? r.body + (kind === "json" ? "" : "&") : "") + value;
      dataKind = kind;
      r.bodyType = "raw";
      if (!explicitMethod) r.method = "POST";
    } else if (t === "--get" || t === "-G") getQuery = true;
    else if (t === "--url-query") {
      const value = tokens[++i];
      if (
        value === undefined ||
        value.length > 65536 ||
        queryParts.length >= 1000
      )
        throw Error("cURL查询参数缺失或超过上限");
      queryParts.push(
        value.startsWith("+") ? value.slice(1) : curlEncodedLiteral(value),
      );
    } else if (t === "--url") setURL(clean(tokens[++i]));
    else if (t === "--http2-prior-knowledge") r.httpVersion = "2";
    else if (t === "--http1.1") r.httpVersion = "1.1";
    else if (t === "--proxytunnel" || t === "-p") proxyTunnel = true;
    else if (t === "--globoff" || t === "-g" || t === "--tlsv1.2") {
    } else if (t === "--noproxy") {
      noProxy = tokens[++i];
      if (!["", "*"].includes(noProxy))
        throw Error("暂不支持选择性的cURL代理排除列表");
    } else if (t === "--digest") r.auth = { ...(r.auth || {}), type: "digest" };
    else if (t === "-u" || t === "--user") {
      const value = tokens[++i] || "",
        colon = value.indexOf(":");
      r.auth = {
        type: r.auth?.type === "digest" ? "digest" : "basic",
        username: colon < 0 ? value : value.slice(0, colon),
        password: colon < 0 ? "" : value.slice(colon + 1),
      };
    } else if (t === "--proxy" || t === "-x") r.proxy = tokens[++i];
    else if (t === "--max-time" || t === "-m")
      r.timeout = Number(tokens[++i]) * 1000;
    else if (t === "--form-string" || t === "--form" || t === "-F") {
      if (dataKind) throw Error("暂不支持混用不同 cURL 请求体类型");
      const value = tokens[++i] || "",
        equal = value.indexOf("=");
      if (equal < 0) throw Error("无效表单参数");
      if (t !== "--form-string" && /^[<@]/.test(value.slice(equal + 1)))
        throw Error("不自动读取 cURL 文件，请使用文件选择器");
      r.bodyType = "form-data";
      r.form ??= [];
      r.form.push({
        key: value.slice(0, equal),
        value: value.slice(equal + 1),
        enabled: true,
      });
      if (!explicitMethod) r.method = "POST";
    } else if (/^https?:/.test(t)) setURL(t);
    else if (!["--compressed", "-s", "--silent"].includes(t))
      throw Error(`不支持的 cURL 参数: ${t}`);
  }
  if (!r.url) throw Error("cURL 缺少 URL");
  if (getQuery && (queryParts.length || r.bodyType === "form-data"))
    throw Error("暂不混用--get与--url-query或multipart；避免静默丢弃查询数据");
  if (getQuery) {
    if (!explicitMethod) r.method = "GET";
    if (dataKind) {
      queryParts.push(r.body);
      r.body = "";
      r.bodyType = "none";
    }
  }
  if (queryParts.length) r.url = appendCurlQuery(r.url, queryParts);
  const defaultHeader = (key, value) => {
    if (
      !r.headers.some(
        (header) => header.key.toLowerCase() === key.toLowerCase(),
      )
    )
      r.headers.push({ key, value, enabled: true });
  };
  if (dataKind && (!getQuery || dataKind === "json"))
    defaultHeader(
      "Content-Type",
      dataKind === "json"
        ? "application/json"
        : "application/x-www-form-urlencoded",
    );
  defaultHeader("Accept", dataKind === "json" ? "application/json" : "*/*");
  if (noProxy === "*") r.proxy = "";
  if (
    proxyTunnel &&
    (!r.proxy ||
      (r.httpVersion !== "2" && new URL(r.url).protocol !== "https:"))
  )
    throw Error("此cURL代理隧道组合暂不支持");
  return normalizeRequest(r);
}
export function exportOpenAPI(project) {
  const paths = Object.create(null);
  const components = structuredClone(project.openapiComponents ?? {});
  for (const source of project.requests.filter((r) => !r.deletedAt)) {
    assertRedirectExportable(source);
    const r = sdkOpenAPIDefinition(project, source);
    if (
      Object.values(r.bodyDynamic || {}).some((spec) =>
        isApipostFunctionSource(spec?.source),
      ) ||
      [...(r.query || []), ...(r.headers || []), ...(r.form || [])].some(
        (row) =>
          row.enabled !== false && isApipostFunctionSource(row.dynamic?.source),
      )
    )
      throw Error("OpenAPI不能表达原版函数模板，请使用项目备份");
    if (
      normalizeCookieEncoding(r.cookieEncoding) !== "raw" &&
      (r.cookies || []).some((row) => row.enabled !== false && row.key)
    )
      throw Error(
        "OpenAPI不能无损表达Cookie编码策略，请使用项目备份或cURL导出",
      );
    if (r.queryAddEqual === false)
      throw Error(
        "OpenAPI不能无损表达空Query省略等号配置，请使用项目备份或cURL导出",
      );
    if (
      r.openapiExampleBindingsVersion !== undefined &&
      r.openapiExampleBindingsVersion !== 1
    )
      throw Error("响应示例绑定版本暂不支持");
    const queryDefinition = openAPIURLQuery(r);
    let path;
    try {
      path = new URL(
        queryDefinition.pathURL.replace(/\{\{[^}]+\}\}/g, "localhost"),
      ).pathname
        .replaceAll("%7B", "{")
        .replaceAll("%7D", "}");
    } catch {
      path = queryDefinition.pathURL.replace(/^\{\{[^}]+\}\}/, "") || "/";
    }
    paths[path] ??= {};
    const method = r.method.toLowerCase();
    if (Object.hasOwn(paths[path], method))
      throw Error(
        `OpenAPI存在重复操作 ${r.method.toUpperCase()} ${path}，无法同时表达，请使用项目备份`,
      );
    const responses = Object.create(null);
    for (const response of r.responses || []) {
      if (!/^(default|[1-5](?:[0-9]{2}|XX))$/.test(String(response.status)))
        throw Error("响应状态定义无效");
      responses[String(response.status)] = {
        ...structuredClone(
          Object.fromEntries(
            Object.entries(response).filter(
              ([key]) => key === "links" || key.startsWith("x-"),
            ),
          ),
        ),
        description: response.description || "",
        content: structuredClone(response.content || {}),
        ...(response.headers
          ? { headers: structuredClone(response.headers) }
          : {}),
      };
    }
    appendResponseExamples(responses, r.examples || [], {
      managed: r.openapiExampleBindingsVersion === 1,
      registry: r.openapiExampleSources,
    });
    if (!Object.keys(responses).length)
      responses["200"] = { description: "Successful response" };
    const requestBody = exportOpenAPIBody(r);
    const original = structuredClone(r.openapiOperation || {});
    delete original.requestBody;
    if (["jwt", "asap"].includes(r.auth?.type)) {
      const scheme =
        r.auth.type === "jwt" && r.auth.addTokenTo === "queryParam"
          ? {
              type: "apiKey",
              in: "query",
              name: r.auth.queryParamKey ?? "token",
              description: "JWT; signing credentials are not exported",
            }
          : r.auth.type === "asap" ||
              (r.auth.headerPrefix ?? "Bearer") === "Bearer"
            ? { type: "http", scheme: "bearer", bearerFormat: "JWT" }
            : {
                type: "apiKey",
                in: "header",
                name: "Authorization",
                description:
                  "JWT with an explicit custom prefix; signing credentials are not exported",
              };
      components.securitySchemes ??= {};
      if (
        typeof components.securitySchemes !== "object" ||
        Array.isArray(components.securitySchemes)
      )
        throw Error("OpenAPI securitySchemes 无效");
      const name =
        "localapi_jwt_" +
        createHash("sha256")
          .update(JSON.stringify(scheme))
          .digest("hex")
          .slice(0, 12);
      if (
        Object.hasOwn(components.securitySchemes, name) &&
        JSON.stringify(components.securitySchemes[name]) !==
          JSON.stringify(scheme)
      )
        throw Error("OpenAPI JWT认证方案冲突");
      components.securitySchemes[name] = scheme;
      original.security = [{ [name]: [] }];
    }

    const baseVariable = /^\{\{[^{}]+\}\}/.exec(queryDefinition.pathURL)?.[0];
    if (
      queryDefinition.pathURL.includes("{{") &&
      (!baseVariable ||
        queryDefinition.pathURL.slice(baseVariable.length).includes("{{"))
    )
      throw Error("OpenAPI导出工作台URL模板仅支持单个base前缀，请使用项目备份");
    try {
      if (baseVariable) original.servers = [{ url: baseVariable }];
      else if (!queryDefinition.pathURL.includes("{{"))
        original.servers = [{ url: new URL(queryDefinition.pathURL).origin }];
    } catch {}
    paths[path][method] = {
      ...original,
      ...(r.sourceOperationId ? { operationId: r.sourceOperationId } : {}),
      summary: r.name,
      description: r.description,
      tags: r.folder ? [r.folder] : [],
      parameters: [
        ["query", queryDefinition.query],
        ["path", r.path],
        ["header", r.headers],
        ["cookie", r.cookies],
      ].flatMap(([location, parameters]) =>
        parameters
          .filter((parameter) => parameter.enabled !== false && parameter.key)
          .map((parameter) => ({
            name: parameter.key,
            in: location,
            required: location === "path" || parameter.required === true,
            description: parameter.description || "",
            schema: parameter.schema ?? { type: "string" },
            example: parameter.value,
            ...(location === "query"
              ? openAPIEmptyQueryValue(parameter.allowEmptyValue)
              : {}),
          })),
      ),
      responses,
      ...(requestBody ? { requestBody } : {}),
    };
  }
  return normalizeOpenAPI30Schemas({
    openapi: "3.0.3",
    info: { title: project.name, version: "1.0.0" },
    paths,
    ...(Object.keys(components).length ? { components } : {}),
  });
}
export function toCurl(input) {
  assertRedirectExportable(input);
  if (
    Object.values(input.bodyDynamic || {}).some((spec) =>
      isApipostFunctionSource(spec?.source),
    ) ||
    [
      ...(input.query || []),
      ...(input.headers || []),
      ...(input.form || []),
    ].some(
      (row) =>
        row.enabled !== false && isApipostFunctionSource(row.dynamic?.source),
    )
  )
    throw Error("cURL不能表达原版函数模板，请使用项目备份或已执行请求证据");
  const r = normalizeRequest(sdkCurlDefinition(input));
  if (r.auth.type === "asap")
    throw Error(
      "ASAP需要逐次签名，请使用原始请求/项目导出，不生成缺失认证的cURL。",
    );
  if (r.auth.type === "jwt")
    throw Error(
      "JWT需要本地生成签名；请使用原始请求/项目导出，不生成缺失认证的cURL。",
    );
  if (r.auth.type === "ntlm")
    throw Error("NTLM导出不能保证相同v2限制，请使用原始请求/项目导出");
  if (r.auth.type === "edgegrid")
    throw Error(
      "EdgeGrid需要每次计算签名；请使用原始请求/项目导出，不生成缺失签名的cURL。",
    );
  if (r.auth.type === "hawk")
    throw Error(
      "Hawk需要每次计算MAC；请使用原始请求/项目导出，不生成缺失签名的cURL。",
    );
  if (r.auth.type === "aws")
    throw Error(
      "AWS签名需要每次计算；请使用原始请求/项目导出，不生成缺失签名的cURL。",
    );
  if (r.auth.type === "oauth1")
    throw Error(
      "OAuth1需要每次生成签名，请使用原始请求/项目导出；不生成缺失签名的cURL。",
    );
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  if (
    ["binary", "msgpack"].includes(r.bodyType) ||
    r.form.some((field) => field.type === "file") ||
    Object.values(r.tls).some(Boolean)
  )
    throw Error(
      "二进制、文件或内联证书请求需手工配置；不会生成不等价的 cURL。请使用原始请求/项目导出。",
    );
  let raw = r.url;
  for (const parameter of r.path.filter((item) => item.enabled !== false))
    raw = raw.replaceAll(
      "{" + parameter.key + "}",
      encodeURIComponent(parameter.value),
    );
  const url = new URL(raw);
  appendRequestQuery(url, r.query, r.queryAddEqual);
  const headers = requestHeaderMap(r.headers, r.auth.type);
  const args = [
    "curl",
    "--disable",
    "--globoff",
    "--noproxy",
    quote(r.proxy ? "" : "*"),
    r.httpVersion === "2" ? "--http2-prior-knowledge" : "--http1.1",
    "-X",
    r.method,
  ];
  if (url.protocol === "https:") args.push("--tlsv1.2");
  if (r.httpVersion === "2" && r.proxy) args.push("--proxytunnel");
  if (r.auth.type === "basic" || r.auth.type === "digest") {
    if (r.auth.type === "digest") args.push("--digest");
    args.push(
      "--user",
      quote((r.auth.username || "") + ":" + (r.auth.password || "")),
    );
  }
  if (["bearer", "oauth2"].includes(r.auth.type))
    headers.authorization = "Bearer " + (r.auth.token || "");
  if (r.auth.type === "apiKey") {
    if (r.auth.in === "query") setAPIKeyQuery(url, r.auth);
    else headers[String(r.auth.key).toLowerCase()] = r.auth.value;
  }
  const cookieHeader = requestCookieHeader(r.cookies, r.cookieEncoding);
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  if (r.bodyType === "json") headers["content-type"] ??= "application/json";
  if (r.bodyType === "urlencoded")
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  args.push(quote(url.href));
  if (!Object.hasOwn(headers, "accept")) args.push("-H", quote("accept:"));
  if (r.bodyType === "raw" && !Object.hasOwn(headers, "content-type"))
    args.push("-H", quote("content-type:"));
  for (const [key, values] of Object.entries(headers))
    for (const value of Array.isArray(values) ? values : [values])
      args.push("-H", quote(value === "" ? key + ";" : key + ": " + value));
  if (r.proxy) args.push("--proxy", quote(r.proxy));
  args.push("--max-time", String(r.timeout / 1000));
  if (r.bodyType === "form-data")
    for (const field of r.form.filter((item) => item.enabled !== false))
      args.push("--form-string", quote(field.key + "=" + field.value));
  else if (r.bodyType === "urlencoded")
    args.push(
      "--data-raw",
      quote(
        new URLSearchParams(
          r.form
            .filter((item) => item.enabled !== false)
            .map((item) => [item.key, item.value]),
        ).toString(),
      ),
    );
  else if (r.bodyType !== "none") args.push("--data-raw", quote(r.body));
  return args.join(" ");
}

export function restoreProject(document) {
  if (typeof document === "string") document = JSON.parse(document);
  if (
    !document ||
    document.version !== 1 ||
    !Array.isArray(document.requests) ||
    !Array.isArray(document.environments)
  )
    throw Error("不是有效的本地项目备份");
  if (document.requests.length > 5000) throw Error("项目接口超过 5000 个");
  validateNativeInheritanceProject(document);
  validateAPIResourceTrash(document);
  for (const environment of document.environments) {
    if (
      !environment.id ||
      !environment.variables ||
      Array.isArray(environment.variables) ||
      typeof environment.variables !== "object"
    )
      throw Error("环境数据无效");
  }
  for (const key of [
    "history",
    "runs",
    "protocolRuns",
    "dictionary",
    "documents",
    "cases",
  ]) {
    if (
      document[key] !== undefined &&
      (!Array.isArray(document[key]) ||
        document[key].some(
          (item) => !item || typeof item !== "object" || Array.isArray(item),
        ))
    )
      throw Error("备份中的 " + key + " 格式无效");
  }
  if (document.settings?.apipostDirectoryArtifacts !== undefined)
    normalizeDirectoryArtifacts(document.settings.apipostDirectoryArtifacts);
  validateModelFolders(document);
  validateCaseFolders(document);
  if (
    (document.runs || []).some(
      (run) =>
        typeof run.id !== "string" ||
        !Array.isArray(run.results) ||
        run.results.some((step) => !step || typeof step !== "object"),
    )
  )
    throw Error("执行记录备份格式无效");
  if ((document.history || []).some((item) => typeof item.id !== "string"))
    throw Error("请求历史备份格式无效");
  // Both collections share the execution-result lookup namespace. Validate
  // the entire input before retention truncation, without rewriting evidence
  // identities or imposing a new migration rule on already persisted projects.
  const executionIds = new Set();
  for (const field of ["history", "runs"])
    for (const record of document[field] || []) {
      if (!record.id || executionIds.has(record.id))
        throw Error("备份执行记录ID不能为空或重复");
      executionIds.add(record.id);
    }
  if (
    (document.documents || []).some(
      (item) =>
        typeof item.title !== "string" || typeof item.content !== "string",
    )
  )
    throw Error("文档备份格式无效");
  // Validate task provenance before cloning can invoke source accessors.
  for (const request of document.requests) validateRequestTaskSource(request);
  for (const item of document.cases || [])
    validateRequestTaskSource(item.request);
  for (const plan of document.plans || []) {
    validateRepeatGraph(plan.steps);
    readImportedNativeFlowSource(plan);
    for (const step of planLeaves(plan.steps || []))
      validateRequestTaskSource(step.request);
  }
  for (const run of document.runs || [])
    if (run.snapshot) {
      if (validateRepeatGraph(run.snapshot.steps)) snapshotPlan(run.snapshot);
      readImportedNativeFlowSource(run.snapshot);
      for (const step of planLeaves(run.snapshot.steps || []))
        validateRequestTaskSource(step.request);
    }
  const copy = structuredClone(document);
  copy.id = id();
  copy.name = (document.name || "项目") + " · 恢复副本";
  delete copy.revision;
  copy.requests = copy.requests.map(normalizeRequest);
  copy.plans = (copy.plans || []).map(snapshotPlan);
  copy.runs = (copy.runs || []).slice(0, 50);
  copy.history = (copy.history || []).slice(0, 50);
  copy.protocolRuns = (copy.protocolRuns || []).slice(0, 50);
  copy.documents = copy.documents || [];
  copy.dictionary = copy.dictionary || [];
  validateNativeInheritanceProject(copy);
  return copy;
}
export function resolveLocalReferences(document) {
  const root = structuredClone(document);
  const contextual = Boolean(root?.openapi || root?.swagger);
  const swagger = Boolean(root?.swagger);
  let nodes = 0;
  function visitChildren(value, seen, depth, mode) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        visit(
          child,
          seen,
          depth + 1,
          referenceChildMode(mode, key, child, swagger),
        ),
      ]),
    );
  }
  function visit(
    value,
    seen = new Set(),
    depth = 0,
    mode = contextual ? "document" : "generic",
  ) {
    if (mode === "literal") return value;
    if (++nodes > 50000) throw Error("OpenAPI 引用展开超过节点上限");
    if (depth > 50) throw Error("OpenAPI 引用层级过深");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((child, index) =>
        visit(
          child,
          seen,
          depth + 1,
          referenceChildMode(mode, String(index), child, swagger),
        ),
      );
    if (referenceModeIsAllowed(mode) && Object.hasOwn(value, "$ref")) {
      const ref = value.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#/"))
        throw Error("不自动下载外部 OpenAPI 引用，请先打包为单文件");
      if (seen.has(ref))
        return mode === "schema" && String(root.openapi).startsWith("3.1.")
          ? visitChildren(value, seen, depth, mode)
          : { $ref: ref };
      let target = root;
      for (const part of ref
        .slice(2)
        .split("/")
        .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (
          ["__proto__", "prototype", "constructor"].includes(part) ||
          !Object.hasOwn(target || {}, part)
        )
          throw Error("无效 OpenAPI 引用 " + ref);
        target = target[part];
      }
      const siblings = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "$ref"),
      );
      const nextSeen = new Set([...seen, ref]);
      if (
        typeof target === "boolean" &&
        mode !== "schema" &&
        mode !== "generic"
      )
        throw Error("无效 OpenAPI 引用目标 " + ref);
      if (target === false)
        return Object.keys(siblings).length
          ? visit({ allOf: [false, siblings] }, nextSeen, depth + 1, mode)
          : false;
      if (target === true)
        return Object.keys(siblings).length
          ? visit(siblings, nextSeen, depth + 1, mode)
          : true;
      if (!target || typeof target !== "object" || Array.isArray(target))
        throw Error("无效 OpenAPI 引用目标 " + ref);
      if (mode === "schema" && String(root.openapi).startsWith("3.1."))
        return visit(
          schemaReferenceWithSiblings(target, siblings),
          nextSeen,
          depth + 1,
          mode,
        );
      return visit({ ...target, ...siblings }, nextSeen, depth + 1, mode);
    }
    return visitChildren(value, seen, depth, mode);
  }
  return visit(root);
}

export { sampleFromSchema } from "./schema-sample.mjs";

function replaceVariables(target, source) {
  for (const key of Object.keys(source)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw Error("脚本变量名无效");
  }
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(source)) target[key] = value;
}

/** Import metadata atomically; sync mode is idempotent and preserves existing interface IDs. */
export function importIntoProject(
  project,
  document,
  { sync = false, modelNameMode, inheritanceMode } = {},
) {
  const preserveInheritance =
    resolveInheritanceMode(inheritanceMode) === "preserve";
  if (project.settings?.nativeInheritance !== undefined)
    throw Error("原生继承图项目暂不支持追加导入；请导入空项目");
  resolveModelNameMode(modelNameMode);
  let original = document;
  if (typeof original === "string") {
    if (original.trim().startsWith("curl ")) original = {};
    else {
      try {
        original = JSON.parse(original);
      } catch {
        original = parseYAML(original, {
          maxAliasCount: 100,
          uniqueKeys: true,
        });
      }
    }
  }
  if (preserveInheritance) validateResourceJSON(original);
  const fromDirectory = isApipostDirectoryDocument(original);
  const directoryDocument = fromDirectory ? original : null;
  if (fromDirectory) original = assembleApipostDirectory(original);
  if (preserveInheritance) {
    if (sync || !isModernApipost(apipostDocument(original)))
      throw Error("inheritanceMode preserve仅支持完整原生HTTP项目，不支持同步");
    if (
      fromDirectory &&
      directoryDocument.files.some(
        (file) =>
          (file.path.startsWith("executions/") &&
            !/^executions\/flows\/[A-Za-z0-9_-]+\.json$/.test(file.path)) ||
          file.path === "settings/mock.json" ||
          (/^settings\/mock_/.test(file.path) &&
            file.path !== "settings/mock_custom_rules.json"),
      )
    )
      throw Error("原生继承图首片不导入执行档案或独立Mock配置");
    return importPreservedNativeInheritance(
      project,
      apipostDocument(original),
      {
        modelNameMode,
        directoryFlows: fromDirectory
          ? original.nativeExecutionFlows || []
          : undefined,
      },
    );
  }
  if (
    modelNameMode !== undefined &&
    !isModernApipost(apipostDocument(original))
  )
    throw Error("modelNameMode仅支持现代Apipost原生格式");
  const directoryFlows = fromDirectory
    ? original.nativeExecutionFlows || []
    : [];
  if (fromDirectory) delete original.nativeExecutionFlows;
  const directoryPlans = fromDirectory
    ? prepareDirectoryPlans(original, directoryFlows, project, {
        normalizeRequest,
        snapshotPlan,
        modelNameMode,
      })
    : [];
  const directoryArtifacts = fromDirectory
    ? mergeDirectoryArtifacts(
        project.settings?.apipostDirectoryArtifacts,
        directoryDocument,
        original.project_id,
      )
    : null;
  const source = apipostDocument(original);
  const modern = isModernApipost(source)
    ? importModernApipost(source, project, { sync, modelNameMode })
    : null;
  if (modern?.nativeProtocolPlans?.length) {
    const plans = structuredClone(project.plans || []);
    for (const raw of modern.nativeProtocolPlans) {
      const previous = plans.find((p) => p.id === raw.id);
      const plan = snapshotPlan({
        ...raw,
        createdAt: previous?.createdAt,
        updatedAt: previous?.updatedAt,
      });
      if (previous && JSON.stringify(previous) !== JSON.stringify(plan))
        throw Error("原生协议消息计划冲突，请导入新项目");
      if (!previous) plans.push(plan);
    }
    if (plans.length > 1000) throw Error("计划最多1000个");
    modern.metadata.plans = plans;
  }
  const legacy = modern || (source ? importApipost(original) : null);
  const importedDocuments = mergeImportedDocuments(project, legacy?.documents, {
    sync,
  });
  const requests = legacy
    ? legacy.requests.map(normalizeRequest)
    : importDocument(document);
  if (fromDirectory)
    for (const request of requests)
      request.importNotes = [
        ...(request.importNotes || []),
        "原版目录JSON子集（实验性）：按已核对文件结构组装；不代表完整原生迁移。未知文件/资源拒绝，不读取关联文件，不迁移安装设置或回收站。内置规则及原执行报告仅保留为来源备份数据，不启用、不执行，不作为本工具新运行。",
      ];
  const components = original.components || original.openapiComponents;
  const mergedComponents = structuredClone(project.openapiComponents || {});
  if (components) {
    for (const [category, items] of Object.entries(components)) {
      if (["__proto__", "prototype", "constructor"].includes(category))
        throw Error("不安全的组件名称");
      mergedComponents[category] ??= {};
      for (const [name, value] of Object.entries(items)) {
        if (["__proto__", "prototype", "constructor"].includes(name))
          throw Error("不安全的组件名称");
        const old = mergedComponents[category][name];
        if (
          !sync &&
          old !== undefined &&
          JSON.stringify(old) !== JSON.stringify(value)
        )
          throw Error("OpenAPI 组件同名冲突，请导入新项目: " + name);
        mergedComponents[category][name] = structuredClone(value);
      }
    }
  }
  const importedRequestIds =
    modern?.samples?.length || modern?.caseFolders?.length
      ? new Map(requests.map((request) => [request.sourceOperationId, id()]))
      : null;
  const sampleFunctions = modern?.metadata?.settings?.functions || [];
  if (
    (modern?.samples?.length || 0) *
      Buffer.byteLength(JSON.stringify(sampleFunctions)) >
    4 * 1024 * 1024
  )
    throw Error("导入用例函数快照合计最多4MiB，请分批导入或简化函数库");
  const importedCases = (modern?.samples || []).map((sample) =>
    snapshotCase({
      id: sample.id,
      name: sample.name,
      sourceRequestId: importedRequestIds.get(sample.sourceOperationId),
      ...(sample.folderId ? { folderId: sample.folderId } : {}),
      request: sample.request,
      functions: sampleFunctions,
    }),
  );
  if (importedCases.length) {
    if (
      !Array.isArray(project.cases || []) ||
      (project.cases || []).length + importedCases.length > 1000
    )
      throw Error("用例最多1000个");
    const caseIds = new Set((project.cases || []).map((item) => item.id));
    for (const item of importedCases) {
      if (caseIds.has(item.id))
        throw Error("Apipost样例用例标识冲突，请导入新项目");
      caseIds.add(item.id);
    }
  }
  const importedCaseFolders = (modern?.caseFolders || []).map(
    ({ sourceOperationId, ...folder }) => ({
      ...folder,
      sourceRequestId: importedRequestIds.get(sourceOperationId),
    }),
  );
  if (importedCaseFolders.length || importedCases.length)
    validateCaseFolders({
      ...project,
      requests: [
        ...project.requests,
        ...requests.map((request) => ({
          ...request,
          id: importedRequestIds.get(request.sourceOperationId),
        })),
      ],
      cases: [...(project.cases || []), ...importedCases],
      caseFolders: [...(project.caseFolders || []), ...importedCaseFolders],
    });
  const output = [];
  for (const request of requests) {
    const index = sync
      ? project.requests.findIndex(
          (old) =>
            !old.deletedAt &&
            (request.sourceOperationId
              ? old.sourceOperationId === request.sourceOperationId
              : old.method === request.method && old.url === request.url),
        )
      : -1;
    const value = {
      ...request,
      id:
        index >= 0
          ? project.requests[index].id
          : importedRequestIds?.get(request.sourceOperationId) || id(),
    };
    if (index >= 0) project.requests[index] = value;
    else project.requests.push(value);
    output.push(value);
  }
  if (modern) Object.assign(project, modern.metadata);
  if (directoryPlans.length)
    project.plans = [...(project.plans || []), ...directoryPlans];
  if (directoryArtifacts?.length) {
    project.settings ??= {};
    project.settings.apipostDirectoryArtifacts = directoryArtifacts;
  }
  if (importedDocuments) project.documents = importedDocuments;
  if (importedCases.length)
    project.cases = [...(project.cases || []), ...importedCases];
  if (importedCaseFolders.length)
    project.caseFolders = [
      ...(project.caseFolders || []),
      ...importedCaseFolders,
    ];
  if (components) project.openapiComponents = mergedComponents;
  if (legacy)
    project.folders = [
      ...new Set([...(project.folders || []), ...legacy.folders]),
    ];
  if (Array.isArray(original.variable) && original.variable.length && !sync) {
    const variables = Object.fromEntries(
      original.variable
        .filter((item) => item && !item.disabled && item.key)
        .map((item) => [item.key, item.value]),
    );
    project.environments.push({
      id: id(),
      name: (original.info?.name || "导入") + " 变量",
      variables,
    });
  }
  return output;
}

function shellTokens(source) {
  const tokens = [];
  let value = "",
    quote = null,
    started = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const next = source[++index];
      if (next === undefined) throw Error("不完整的 cURL 转义");
      if (next === "\n") continue;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) value += "\\";
      value += next;
      started = true;
      continue;
    }
    const following = source[index + 1];
    if (
      character === "`" ||
      (character === "$" &&
        following &&
        (/[A-Za-z0-9_]/.test(following) ||
          "{([?@*#$!-".includes(following) ||
          (!quote && "\"'".includes(following))))
    )
      throw Error("不执行 Shell 展开；请先提供实际值，或用单引号表示字面值");
    if (
      !quote &&
      ("|&;<>()".includes(character) || (character === "#" && !started))
    )
      throw Error("不支持 Shell 运算符或注释；字面值请加引号");
    if (quote === '"') {
      if (character === '"') quote = null;
      else value += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(value);
        value = "";
        started = false;
      }
      continue;
    }
    value += character;
    started = true;
  }
  if (quote) throw Error("cURL 引号未闭合");
  if (started) tokens.push(value);
  return tokens;
}
