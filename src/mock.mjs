import { validateHeaderName, validateHeaderValue } from "node:http";
import { jsonPath } from "./core.mjs";
export function validateMockRules(rules = []) {
  if (!Array.isArray(rules) || rules.length > 100)
    throw Error("Mock规则最多100条");
  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.conditions) || rule.conditions.length > 50)
      throw Error("Mock匹配条件格式无效");
    for (const condition of rule.conditions)
      if (
        typeof condition.target !== "string" ||
        !["eq", "neq", "contains", "exists"].includes(condition.op)
      )
        throw Error("Mock匹配操作无效");
    const response = rule.response;
    if (
      !response ||
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status > 599
    )
      throw Error("Mock响应状态须为200至599");
    if (
      typeof response.body !== "string" ||
      Buffer.byteLength(response.body) > 8 * 1024 * 1024
    )
      throw Error("Mock响应体超过8MiB或格式无效");
    if (
      response.delayMs !== undefined &&
      (!Number.isInteger(response.delayMs) ||
        response.delayMs < 0 ||
        response.delayMs > 5000)
    )
      throw Error("Mock延迟须为0至5000ms");
    for (const [key, value] of Object.entries(response.headers || {})) {
      validateHeaderName(key);
      if (
        [
          "content-length",
          "transfer-encoding",
          "connection",
          "upgrade",
          "trailer",
        ].includes(key.toLowerCase())
      )
        throw Error("Mock不可覆盖传输控制头");
      if (typeof value !== "string") throw Error("Mock响应头必须为字符串");
      validateHeaderValue(key, value);
    }
  }
  return rules;
}
export function selectMockResponse(request, input) {
  validateMockRules(request.mockRules || []);
  const source = {
    method: input.method,
    query: input.query || {},
    headers: input.headers || {},
    body: input.body,
  };
  for (const rule of request.mockRules || []) {
    if (rule.enabled === false) continue;
    const matches = rule.conditions.every((condition) => {
      const actual = jsonPath(source, condition.target);
      switch (condition.op) {
        case "eq":
          return JSON.stringify(actual) === JSON.stringify(condition.value);
        case "neq":
          return JSON.stringify(actual) !== JSON.stringify(condition.value);
        case "contains":
          return String(actual ?? "").includes(String(condition.value));
        case "exists":
          return actual !== undefined && actual !== null;
      }
    });
    if (matches) return { ...rule.response, ruleName: rule.name || "" };
  }
  const index = Number(input.query?.example) || 0;
  const example = request.examples?.[index] || { status: 200, body: "{}" };
  return {
    status: example.status || 200,
    body: example.body || "{}",
    headers: { "content-type": "application/json" },
    delayMs: 0,
  };
}
