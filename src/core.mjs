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
export function normalizeRequest(r = {}) {
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
  for (const key of ["auth", "tls"])
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
  const method = String(r.method || "GET").toUpperCase();
  if (
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      method,
    )
  )
    throw Error("不支持的 HTTP 方法");
  const url = String(r.url || "");
  if (url && !/^https?:\/\//.test(url) && !url.includes("{{"))
    throw Error("仅支持 HTTP/HTTPS URL");
  return {
    id: r.id || id(),
    name: r.name || "未命名接口",
    folder: r.folder || "",
    description: r.description || "",
    method,
    url,
    query: r.query || [],
    headers: r.headers || [],
    path: r.path || [],
    cookies: r.cookies || [],
    auth: r.auth || { type: "none" },
    bodyType: r.bodyType || "none",
    body:
      typeof r.body === "string"
        ? r.body
        : r.body == null
          ? ""
          : JSON.stringify(r.body),
    form: r.form || [],
    assertions: r.assertions || [],
    extract: r.extract || [],
    before: r.before || [],
    beforeScript: r.beforeScript || "",
    afterScript: r.afterScript || "",
    after: r.after || [],
    examples: r.examples || [],
    schema: r.schema || {},
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
  if (!Array.isArray(plan.steps) || plan.steps.length > 200)
    throw Error("执行计划必须包含至多 200 步");
  return {
    id: plan.id || id(),
    name: plan.name || "新执行计划",
    environmentId: plan.environmentId || "",
    createdAt: plan.createdAt || new Date().toISOString(),
    steps: plan.steps.map((s) => ({
      id: s.id || id(),
      name: s.name || s.request?.name || "步骤",
      enabled: s.enabled !== false,
      request: normalizeRequest(structuredClone(s.request)),
      expectedStatus: s.expectedStatus,
    })),
  };
}
export async function runPlan(
  plan,
  variables,
  execute,
  { signal, onStep } = {},
) {
  const snapshot = structuredClone(plan);
  const vars = { ...variables };
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
      extracted: {},
    };
    try {
      for (const operation of step.request.before || []) {
        applyOperation(operation, vars);
        record.logs.push({
          phase: "before",
          type: operation.type,
          name: operation.name,
        });
      }
      let configuredRequest = structuredClone(step.request);
      if (configuredRequest.beforeScript) {
        const scripted = await runScript(configuredRequest.beforeScript, {
          variables: vars,
          request: configuredRequest,
        });
        replaceVariables(vars, scripted.variables);
        configuredRequest = normalizeRequest(scripted.request);
        record.logs.push(
          ...scripted.logs.map((message) => ({ phase: "before", message })),
        );
        if (scripted.tests.some((test) => !test.passed))
          throw Error("前置脚本断言失败");
      }
      record.request = interpolate(configuredRequest, vars);
      record.response = await execute(record.request, signal);
      record.assertions = evaluateAssertions(
        record.response,
        record.request.assertions,
      );
      for (const extraction of record.request.extract) {
        const value = jsonPath(
          JSON.parse(record.response.body),
          extraction.path,
        );
        if (value === undefined) throw Error(`无法提取 ${extraction.path}`);
        vars[extraction.name] = value;
        record.extracted[extraction.name] = value;
      }
      for (const operation of record.request.after || []) {
        applyOperation(operation, vars);
        record.logs.push({
          phase: "after",
          type: operation.type,
          name: operation.name,
        });
      }
      if (record.request.afterScript) {
        const scripted = await runScript(record.request.afterScript, {
          variables: vars,
          request: record.request,
          response: record.response,
        });
        replaceVariables(vars, scripted.variables);
        record.logs.push(
          ...scripted.logs.map((message) => ({ phase: "after", message })),
        );
        record.assertions.push(...scripted.tests);
      }
      const hasStatusAssertion = record.assertions.some(
        (a) => a.target === "status",
      );
      const statusOK =
        step.expectedStatus !== undefined
          ? record.response.status === step.expectedStatus
          : hasStatusAssertion ||
            (record.response.status >= 200 && record.response.status < 300);
      record.status =
        statusOK && record.assertions.every((a) => a.passed)
          ? "passed"
          : "failed";
    } catch (error) {
      record.error = error.message;
    }
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
          const params = [...(item.parameters || []), ...(op.parameters || [])];
          return normalizeRequest({
            name: op.summary || op.operationId || path,
            method,
            url: base + path,
            description: op.description || "",
            folder: op.tags?.[0] || "",
            query: params
              .filter((p) => p.in === "query")
              .map((p) => ({
                key: p.name,
                value: p.example ?? p.schema?.default ?? "",
                enabled: true,
              })),
            path: params
              .filter((p) => p.in === "path")
              .map((p) => ({
                key: p.name,
                value: p.example ?? "",
                enabled: true,
              })),
            headers: params
              .filter((p) => p.in === "header")
              .map((p) => ({
                key: p.name,
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
  if (Array.isArray(doc.requests)) return doc.requests.map(normalizeRequest);
  throw Error("无法识别导入格式");
}
export function importCurl(source) {
  const tokens = source.match(/'(?:[^']*)'|"(?:\\.|[^"\\])*"|[^\s]+/g) || [];
  const clean = (s) => s?.replace(/^['"]|['"]$/g, "");
  let r = { headers: [], method: "GET" };
  for (let i = 1; i < tokens.length; i++) {
    const t = clean(tokens[i]);
    if (t === "-X" || t === "--request") r.method = clean(tokens[++i]);
    else if (t === "-H" || t === "--header") {
      const h = clean(tokens[++i]);
      const n = h.indexOf(":");
      r.headers.push({
        key: h.slice(0, n),
        value: h.slice(n + 1).trim(),
        enabled: true,
      });
    } else if (["-d", "--data", "--data-raw"].includes(t)) {
      r.body = clean(tokens[++i]);
      r.bodyType = "raw";
      if (r.method === "GET") r.method = "POST";
    } else if (t === "--url") r.url = clean(tokens[++i]);
    else if (/^https?:/.test(t)) r.url = t;
    else if (
      !["-L", "--location", "--compressed", "-s", "--silent"].includes(t)
    )
      throw Error(`不支持的 cURL 参数: ${t}`);
  }
  if (!r.url) throw Error("cURL 缺少 URL");
  return normalizeRequest(r);
}
export function exportOpenAPI(project) {
  const paths = {};
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
    paths[path][r.method.toLowerCase()] = {
      summary: r.name,
      description: r.description,
      tags: r.folder ? [r.folder] : [],
      parameters: [
        ...r.query.map((p) => ({
          name: p.key,
          in: "query",
          schema: { type: "string" },
          example: p.value,
        })),
        ...r.path.map((p) => ({
          name: p.key,
          in: "path",
          required: true,
          schema: { type: "string" },
          example: p.value,
        })),
      ],
      responses: { 200: { description: "Successful response" } },
      ...(r.bodyType === "json"
        ? {
            requestBody: {
              content: {
                "application/json": { schema: r.schema || { type: "object" } },
              },
            },
          }
        : {}),
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: project.name, version: "1.0.0" },
    paths,
  };
}
export function toCurl(r) {
  const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
  return [
    "curl",
    "-X",
    r.method,
    quote(r.url),
    ...r.headers
      .filter((h) => h.enabled !== false && h.key)
      .flatMap((h) => ["-H", quote(`${h.key}: ${h.value}`)]),
    ...(r.bodyType !== "none" ? ["--data-raw", quote(r.body)] : []),
  ].join(" ");
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
      if (seen.has(ref)) throw Error("循环 OpenAPI 引用需要手动展开后导入");
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
export function sampleFromSchema(schema, depth = 0) {
  if (depth > 12) throw Error("Schema 嵌套过深");
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf?.length) return sampleFromSchema(schema.oneOf[0], depth + 1);
  if (schema.type === "object" || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [
        key,
        sampleFromSchema(value, depth + 1),
      ]),
    );
  if (schema.type === "array")
    return [sampleFromSchema(schema.items || {}, depth + 1)];
  if (schema.type === "integer" || schema.type === "number")
    return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  return schema.format === "email"
    ? "user@example.test"
    : schema.format === "date"
      ? "2026-01-01"
      : schema.format === "date-time"
        ? "2026-01-01T00:00:00Z"
        : "";
}

function replaceVariables(target, source) {
  for (const key of Object.keys(source)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw Error("脚本变量名无效");
  }
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(source)) target[key] = value;
}
