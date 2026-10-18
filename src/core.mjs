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
  if (url && !/^https?:\/\//.test(url) && !url.includes("{{") && !r.serviceId)
    throw Error("仅支持 HTTP/HTTPS URL");
  return {
    id: r.id || id(),
    name: String(r.name || "未命名接口"),
    sourceOperationId: String(r.sourceOperationId || ""),
    serviceId: String(r.serviceId || ""),
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
    description: String(plan.description || ""),
    updatedAt: plan.updatedAt || new Date().toISOString(),
    source: plan.source === "ai" ? "ai" : "manual",
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
  { signal, onStep, prepareRequest } = {},
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
      if (prepareRequest) record.request = prepareRequest(record.request);
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
      if (!record.request) {
        record.request = structuredClone(step.request);
        record.requestUnresolved = true;
      }
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
          const params = [...(item.parameters || []), ...(op.parameters || [])];
          return normalizeRequest({
            name: op.summary || op.operationId || path,
            sourceOperationId: op.operationId || "",
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
  const tokens = shellTokens(source);
  const clean = (value) => value;
  if (tokens[0] !== "curl") throw Error("命令必须以 curl 开始");
  let r = { headers: [], method: "GET" };
  let explicitMethod = false;
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
    } else if (t === "--url") r.url = clean(tokens[++i]);
    else if (t === "--digest") r.auth = { ...(r.auth || {}), type: "digest" };
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
    } else if (/^https?:/.test(t)) r.url = t;
    else if (!["--compressed", "-s", "--silent"].includes(t))
      throw Error(`不支持的 cURL 参数: ${t}`);
  }
  if (!r.url) throw Error("cURL 缺少 URL");
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
    ...(project.openapiComponents
      ? { components: project.openapiComponents }
      : {}),
  };
}
export function toCurl(input) {
  const r = normalizeRequest(input);
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  if (
    ["binary", "msgpack"].includes(r.bodyType) ||
    r.form.some((field) => field.type === "file") ||
    Object.values(r.tls).some(Boolean)
  )
    throw Error(
      "二进制、文件或内联证书请求需手工准备文件；不会生成不等价的 cURL。请使用原始请求/项目导出。",
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
  const args = ["curl", "-X", r.method];
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
  for (const key of ["history", "runs", "dictionary", "documents"]) {
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
export function sampleFromSchema(schema, depth = 0) {
  if (schema.$ref) return null;
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

/** Import metadata atomically; sync mode is idempotent and preserves existing interface IDs. */
export function importIntoProject(project, document, { sync = false } = {}) {
  const requests = importDocument(document);
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
