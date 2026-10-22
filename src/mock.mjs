import { validateMockResponse } from "../public/response-example.js";
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
    validateMockResponse(rule.response);
  }
  return rules;
}
export function selectMockResponse(request, input, fallback) {
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
  if (!request.examples?.length && fallback)
    return validateMockResponse(fallback());
  const index = Number(input.query?.example) || 0;
  const example = request.examples?.[index] || { status: 200, body: "{}" };
  if (!example || typeof example !== "object" || Array.isArray(example))
    throw Error("响应示例格式无效");
  return validateMockResponse({
    status: example.status ?? 200,
    body: example.body ?? "{}",
    headers: example.headers ?? { "content-type": "application/json" },
    delayMs: example.delayMs ?? 0,
  });
}
