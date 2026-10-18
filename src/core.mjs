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
import { runScript } from "./scripts.mjs";
import { randomUUID, createHash } from "node:crypto";
export const id = () => randomUUID();
export function interpolate(value, vars = {}) {
  if (typeof value === "string")
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
      if (!Object.hasOwn(vars, key)) throw Error(`未定义变量: ${key}`);
      return String(vars[key]);
    });
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]),
    );
  return value;
}
export function jsonPath(obj, path) {
  const parts = String(path)
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
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
  validateAuth(r.auth);
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
  return {
    id: r.id || id(),
    name: String(r.name || "未命名接口"),
    sourceOperationId: String(r.sourceOperationId || ""),
    serviceId: String(r.serviceId || ""),
    serviceSnapshot: r.serviceSnapshot === true,
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
    headers: r.headers || [],
    path: r.path || [],
    cookies: r.cookies || [],
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
    beforeScript: r.beforeScript || "",
    afterScript: r.afterScript || "",
    after: r.after || [],
    examples: r.examples || [],
    mockRules: r.mockRules || [],
    schema: r.schema || {},
    responses: r.responses || [],
    openapiOperation: r.openapiOperation || {},
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
  if (
    plan.statusPolicy !== undefined &&
    !["assertions", "strict200"].includes(plan.statusPolicy)
  )
    throw Error("未知执行状态规则");
  if (!Array.isArray(plan.steps) || plan.steps.length > 200)
    throw Error("执行计划必须包含至多 200 步");
  return {
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
    steps: plan.steps.map((s) => ({
      id: s.id || id(),
      name: s.name || s.request?.name || "步骤",
      enabled: s.enabled !== false,
      request: {
        ...normalizeRequest(structuredClone(s.request)),
        serviceSnapshot: true,
      },
      expectedStatus: s.expectedStatus,
    })),
  };
}
export async function runPlan(
  plan,
  variables,
  execute,
  { signal, onStep, prepareRequest, variableScopes, onScopeChanges } = {},
) {
  const snapshot = structuredClone(plan);
  for (const step of snapshot.steps) step.request.serviceSnapshot = true;
  let scopes = createScopes(variables, variableScopes);
  const vars = { ...effectiveScopes(scopes) };
  const results = [];
  if (!snapshot.steps.some((step) => step.enabled !== false)) {
    throw Error("计划没有可执行步骤");
  }
  for (const step of snapshot.steps) {
    if (signal?.aborted) break;
    if (step.enabled === false) continue;
    const record = {
      stepId: step.id,
      name: step.name,
      startedAt: new Date().toISOString(),
      status: "failed",
      logs: [],
      assertions: [],
      subrequests: [],
      extracted: {},
    };
    let scriptPhase;
    let committedScopes = structuredClone(scopes);
    const commitScopes = async () => {
      const changes = scopeChanges(committedScopes, scopes);
      if (changes.length && onScopeChanges) {
        try {
          const accepted = await onScopeChanges(changes);
          if (accepted?.globals && accepted?.environment) {
            scopes.globals = accepted.globals;
            scopes.environment = accepted.environment;
          }
        } catch (error) {
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
      const beforeOperations = { ...vars };
      for (const operation of step.request.before || []) {
        applyOperation(operation, vars);
        record.logs.push({
          phase: "before",
          type: operation.type,
          name: operation.name,
        });
      }
      applyLegacyVariables(scopes, beforeOperations, vars);
      const localVariables = {};
      let configuredRequest = structuredClone(step.request);
      if (configuredRequest.beforeScript) {
        scriptPhase = "before";
        const scripted = await runScript(
          configuredRequest.beforeScript,
          {
            allowNetwork: true,
            variables: vars,
            scopes,
            localVariables,
            functions: snapshot.functions || [],
            request: configuredRequest,
          },
          { signal },
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
        scopes = createScopes(scripted.variables, scripted.scopes);
        replaceVariables(vars, effectiveScopes(scopes));
        replaceVariables(localVariables, scripted.localVariables || {});
        configuredRequest = normalizeRequest(scripted.request);
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
      );
      if (prepareRequest) record.request = prepareRequest(record.request);
      record.response = await execute(record.request, signal);
      record.assertions.push(
        ...evaluateAssertions(record.response, record.request.assertions).map(
          (assertion) => ({ ...assertion, phase: "response" }),
        ),
      );
      for (const extraction of record.request.extract) {
        const value = await extractResponse(record.response, extraction);
        const destination = extraction.scope || "runtime";
        if (destination === "local") localVariables[extraction.name] = value;
        else if (destination === "environment")
          scopes.environment[extraction.name] = value;
        else if (destination === "global")
          scopes.globals[extraction.name] = value;
        else if (destination === "runtime") {
          scopes.runtime[extraction.name] = value;
          scopes.hidden = scopes.hidden.filter(
            (name) => name !== extraction.name,
          );
        } else throw Error("未知提取变量作用域");
        replaceVariables(vars, effectiveScopes(scopes));
        record.extracted[extraction.name] = value;
      }
      const beforeAfterOperations = { ...vars };
      for (const operation of record.request.after || []) {
        applyOperation(operation, vars);
        record.logs.push({
          phase: "after",
          type: operation.type,
          name: operation.name,
        });
      }
      applyLegacyVariables(scopes, beforeAfterOperations, vars);
      if (record.request.afterScript) {
        scriptPhase = "after";
        const scripted = await runScript(
          record.request.afterScript,
          {
            allowNetwork: true,
            variables: vars,
            scopes,
            localVariables,
            functions: snapshot.functions || [],
            request: record.request,
            response: record.response,
          },
          { signal },
        );
        record.subrequests.push(
          ...scripted.networkRequests.map((item) => ({
            ...item,
            phase: "after",
          })),
        );
        scopes = createScopes(scripted.variables, scripted.scopes);
        replaceVariables(vars, effectiveScopes(scopes));
        record.logs.push(
          ...scripted.logs.map((message) => ({ phase: "after", message })),
        );
        record.assertions.push(
          ...scripted.tests.map((test) => ({ ...test, phase: "after" })),
        );
      }
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
    } catch (error) {
      if (error.networkRequests)
        record.subrequests.push(
          ...error.networkRequests.map((item) => ({
            ...item,
            phase: scriptPhase,
          })),
        );
      scopes.environment = committedScopes.environment;
      scopes.globals = committedScopes.globals;
      record.error = error.message;
      if (!record.request) {
        record.request = structuredClone(step.request);
        record.requestUnresolved = true;
      }
    }
    replaceVariables(vars, effectiveScopes(scopes));
    results.push(record);
    await onStep?.(record);
  }
  return {
    id: id(),
    planId: plan.id,
    planName: plan.name,
    planHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    snapshot,
    createdAt: new Date().toISOString(),
    status: signal?.aborted
      ? "cancelled"
      : results.every((r) => r.status === "passed")
        ? "passed"
        : "failed",
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
  if (doc.openapi || doc.swagger) {
    doc = resolveLocalReferences(doc);
    const base =
      doc.servers?.[0]?.url ||
      (doc.host
        ? `${doc.schemes?.[0] || "https"}://${doc.host}${doc.basePath || ""}`
        : "{{baseUrl}}");
    return Object.entries(doc.paths || {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([m]) =>
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(
            m,
          ),
        )
        .map(([method, op]) => {
          const params = [
            ...new Map(
              [...(item.parameters || []), ...(op.parameters || [])].map(
                (parameter) => [parameter.in + ":" + parameter.name, parameter],
              ),
            ).values(),
          ];
          return normalizeRequest({
            name: op.summary || op.operationId || path,
            sourceOperationId: op.operationId || "",
            method,
            url:
              (op.servers?.[0]?.url || item.servers?.[0]?.url || base) + path,
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
                schema: p.schema || { type: p.type || "string" },
                required: p.required === true,
                description: p.description || "",
                value: p.example ?? p.schema?.default ?? "",
                enabled: true,
              })),
            path: params
              .filter((p) => p.in === "path")
              .map((p) => ({
                key: p.name,
                schema: p.schema || { type: p.type || "string" },
                required: p.required === true,
                description: p.description || "",
                value: p.example ?? "",
                enabled: true,
              })),
            headers: params
              .filter((p) => p.in === "header")
              .map((p) => ({
                key: p.name,
                schema: p.schema || { type: p.type || "string" },
                required: p.required === true,
                description: p.description || "",
                value: p.example ?? "",
                enabled: true,
              })),
            bodyType: op.requestBody ? "json" : "none",
            body: op.requestBody
              ? JSON.stringify(
                  op.requestBody.content?.["application/json"]?.example || {},
                  null,
                  2,
                )
              : "",
            schema: op.requestBody?.content?.["application/json"]?.schema || {},
            responses: Object.entries(op.responses || {}).map(
              ([status, response]) => ({
                status,
                description: response.description || "",
                content: response.content || {
                  "application/json": { schema: response.schema || {} },
                },
                headers: response.headers || {},
              }),
            ),
            examples: Object.entries(op.responses || {}).map(([status, r]) => ({
              name: r.description || status,
              status: Number(status) || 200,
              body: JSON.stringify(
                r.content?.["application/json"]?.example || {},
                null,
                2,
              ),
            })),
          });
        }),
    );
  }
  if (doc.info && doc.item) {
    const events = (list, phase) =>
      (list || [])
        .filter((event) => event.listen === phase)
        .flatMap((event) => event.script?.exec || [])
        .join("\n");
    const auth = (config) => {
      if (!config || config.type === "noauth") return { type: "none" };
      const values = Object.fromEntries(
        (config[config.type] || []).map((item) => [item.key, item.value]),
      );
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
            ["accessKey", "secretKey", "sessionToken", "region", "service"]
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
      inheritedEvents = doc.event || [],
    ) =>
      items.flatMap((item) => {
        const currentEvents = [...inheritedEvents, ...(item.event || [])];
        if (item.item)
          return walk(
            item.item,
            folder ? folder + "/" + item.name : item.name,
            item.auth || inheritedAuth,
            currentEvents,
          );
        const req = item.request || {},
          body = req.body || {};
        const rawURL =
          typeof req.url === "string" ? req.url : req.url?.raw || "";
        const queries = typeof req.url === "object" ? req.url.query || [] : [];
        const mode =
          body.mode === "raw"
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
            url: (queries.length ? rawURL.split("?")[0] : rawURL).replace(
              /\/:([A-Za-z0-9_]+)/g,
              "/{$1}",
            ),
            description:
              typeof req.description === "string"
                ? req.description
                : req.description?.content || "",
            auth: auth(req.auth || inheritedAuth),
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
            bodyType: mode,
            body: body.raw || "",
            form: (body.urlencoded || body.formdata || []).map((f) => ({
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
            beforeScript: events(currentEvents, "prerequest"),
            afterScript: events(currentEvents, "test"),
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
  if (apipostDocument(doc))
    return importApipost(doc).requests.map(normalizeRequest);
  if (Array.isArray(doc.requests)) return doc.requests.map(normalizeRequest);
  throw Error("无法识别导入格式");
}
export function importCurl(source) {
  const tokens = shellTokens(source);
  const clean = (value) => value;
  if (tokens[0] !== "curl") throw Error("命令必须以 curl 开始");
  let r = { headers: [], method: "GET" };
  let explicitMethod = false,
    proxyTunnel = false,
    noProxy;
  const setURL = (value) => {
    if (r.url) throw Error("暂不支持一条cURL中的多个URL");
    r.url = value;
  };
  for (let i = 1; i < tokens.length; i++) {
    const t = clean(tokens[i]);
    if (t === "-X" || t === "--request") {
      r.method = clean(tokens[++i]);
      explicitMethod = true;
      if (!r.method) throw Error("缺少 HTTP 方法");
    } else if (t === "-H" || t === "--header") {
      const h = clean(tokens[++i]);
      if (!h || !h.includes(":")) throw Error("无效 Header");
      const n = h.indexOf(":");
      r.headers.push({
        key: h.slice(0, n),
        value: h.slice(n + 1).trim(),
        enabled: true,
      });
    } else if (["-d", "--data", "--data-raw"].includes(t)) {
      r.body = clean(tokens[++i]);
      if (t !== "--data-raw" && r.body?.startsWith("@"))
        throw Error("不自动读取 cURL 文件，请使用文件选择器");
      r.bodyType = "raw";
      if (!explicitMethod) r.method = "POST";
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
  for (const r of project.requests.filter((r) => !r.deletedAt)) {
    let path;
    try {
      path = new URL(r.url.replace(/\{\{[^}]+\}\}/g, "localhost")).pathname
        .replaceAll("%7B", "{")
        .replaceAll("%7D", "}");
    } catch {
      path = r.url.replace(/^\{\{[^}]+\}\}/, "") || "/";
    }
    paths[path] ??= {};
    const responses = Object.create(null);
    for (const response of r.responses || []) {
      if (!/^(default|[1-5][0-9X]{2})$/.test(String(response.status)))
        throw Error("响应状态定义无效");
      responses[String(response.status)] = {
        description: response.description || "",
        content: structuredClone(response.content || {}),
        ...(response.headers
          ? { headers: structuredClone(response.headers) }
          : {}),
      };
    }
    for (const example of r.examples || []) {
      const status = String(example.status || 200);
      responses[status] ??= {
        description: example.name || "Response",
        content: { "application/json": {} },
      };
      responses[status].content ??= {};
      responses[status].content["application/json"] ??= {};
      let value;
      try {
        value = JSON.parse(example.body);
      } catch {
        value = example.body;
      }
      if (responses[status].content["application/json"].example === undefined)
        responses[status].content["application/json"].example = value;
    }
    if (!Object.keys(responses).length)
      responses["200"] = { description: "Successful response" };
    let requestBody;
    if (r.bodyType === "json") {
      let example;
      try {
        example = JSON.parse(r.body || "{}");
      } catch {}
      requestBody = {
        content: {
          "application/json": {
            schema: r.schema || { type: "object" },
            ...(example === undefined ? {} : { example }),
          },
        },
      };
    }
    const original = structuredClone(r.openapiOperation || {});
    delete original.requestBody;
    try {
      if (!r.url.includes("{{"))
        original.servers = [{ url: new URL(r.url).origin }];
    } catch {}
    paths[path][r.method.toLowerCase()] = {
      ...original,
      ...(r.sourceOperationId ? { operationId: r.sourceOperationId } : {}),
      summary: r.name,
      description: r.description,
      tags: r.folder ? [r.folder] : [],
      parameters: [
        ["query", r.query],
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
            schema: parameter.schema || { type: "string" },
            example: parameter.value,
          })),
      ),
      responses,
      ...(requestBody ? { requestBody } : {}),
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: project.name, version: "1.0.0" },
    paths,
    ...(project.openapiComponents
      ? { components: project.openapiComponents }
      : {}),
  };
}
export function toCurl(input) {
  const r = normalizeRequest(input);
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
  for (const parameter of r.query.filter(
    (item) => item.enabled !== false && item.key,
  ))
    url.searchParams.append(parameter.key, parameter.value);
  const headers = Object.fromEntries(
    r.headers
      .filter((item) => item.enabled !== false && item.key)
      .map((item) => [item.key.toLowerCase(), item.value]),
  );
  const args = [
    "curl",
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
    if (r.auth.in === "query") url.searchParams.set(r.auth.key, r.auth.value);
    else headers[String(r.auth.key).toLowerCase()] = r.auth.value;
  }
  if (r.cookies.length)
    headers.cookie = r.cookies
      .filter((item) => item.enabled !== false)
      .map((item) => item.key + "=" + item.value)
      .join("; ");
  if (r.bodyType === "json") headers["content-type"] ??= "application/json";
  if (r.bodyType === "urlencoded")
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  args.push(quote(url.href));
  for (const [key, value] of Object.entries(headers))
    args.push("-H", quote(key + ": " + value));
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
  for (const environment of document.environments) {
    if (
      !environment.id ||
      !environment.variables ||
      Array.isArray(environment.variables) ||
      typeof environment.variables !== "object"
    )
      throw Error("环境数据无效");
  }
  for (const key of ["history", "runs", "dictionary", "documents", "cases"]) {
    if (
      document[key] !== undefined &&
      (!Array.isArray(document[key]) ||
        document[key].some(
          (item) => !item || typeof item !== "object" || Array.isArray(item),
        ))
    )
      throw Error("备份中的 " + key + " 格式无效");
  }
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
  if (
    (document.documents || []).some(
      (item) =>
        typeof item.title !== "string" || typeof item.content !== "string",
    )
  )
    throw Error("文档备份格式无效");
  const copy = structuredClone(document);
  copy.id = id();
  copy.name = (document.name || "项目") + " · 恢复副本";
  delete copy.revision;
  copy.requests = copy.requests.map(normalizeRequest);
  copy.plans = (copy.plans || []).map(snapshotPlan);
  copy.runs = (copy.runs || []).slice(0, 50);
  copy.history = (copy.history || []).slice(0, 50);
  copy.documents = copy.documents || [];
  copy.dictionary = copy.dictionary || [];
  return copy;
}
export function resolveLocalReferences(document) {
  const root = structuredClone(document);
  function visit(value, seen = new Set(), depth = 0) {
    if (depth > 50) throw Error("OpenAPI 引用层级过深");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((v) => visit(v, seen, depth + 1));
    if (value.$ref) {
      const ref = value.$ref;
      if (!ref.startsWith("#/"))
        throw Error("不自动下载外部 OpenAPI 引用，请先打包为单文件");
      if (seen.has(ref)) return { $ref: ref };
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
      return visit(
        {
          ...target,
          ...Object.fromEntries(
            Object.entries(value).filter(([k]) => k !== "$ref"),
          ),
        },
        new Set([...seen, ref]),
        depth + 1,
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, visit(v, seen, depth + 1)]),
    );
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
export function importIntoProject(project, document, { sync = false } = {}) {
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
  const legacy = apipostDocument(original) ? importApipost(original) : null;
  const requests = legacy
    ? legacy.requests.map(normalizeRequest)
    : importDocument(document);
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
      id: index >= 0 ? project.requests[index].id : id(),
    };
    if (index >= 0) project.requests[index] = value;
    else project.requests.push(value);
    output.push(value);
  }
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
      if (next !== "\n") value += next;
      started = true;
      continue;
    }
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
