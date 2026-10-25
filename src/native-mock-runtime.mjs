import { normalizeNativeMock, nativeRegex } from "./native-mock.mjs";
import { jsonPathSegments } from "./json-path.mjs";
import { sampleProjectSchema } from "./mock-fields.mjs";
import { validateMockResponse } from "../public/response-example.js";
import { runScript } from "./scripts.mjs";
let activeRegex = 0;
const read = (value, path) => {
  for (const key of jsonPathSegments(path)) {
    if (value == null || !Object.hasOwn(Object(value), key)) return undefined;
    value = value[key];
  }
  return value;
};
const empty = (value) =>
  value == null ||
  (typeof value === "string" || Array.isArray(value)
    ? value.length === 0
    : typeof value === "object"
      ? Object.keys(value).length === 0
      : true);
const contains = (actual, value) =>
  typeof actual === "string"
    ? actual.includes(String(value)) || actual.includes(String(Number(value)))
    : (Array.isArray(actual)
        ? actual
        : actual && typeof actual === "object"
          ? Object.values(actual)
          : []
      ).some(
        (item) =>
          Object.is(item, value) ||
          item === value ||
          Object.is(item, Number(value)) ||
          item === Number(value),
      );
function compare(actual, op, value) {
  try {
    switch (op) {
      case "eq":
        return actual == value;
      case "uneq":
        return actual != value;
      case "gt":
        return Number(actual) > Number(value);
      case "gte":
        return Number(actual) >= Number(value);
      case "lt":
        return Number(actual) < Number(value);
      case "lte":
        return Number(actual) <= Number(value);
      case "includes":
        return contains(actual, value);
      case "unincludes":
        return !contains(actual, value);
      case "null":
        return empty(actual);
      case "notnull":
        return !empty(actual);
      case "exist":
        return actual !== undefined;
      case "notexist":
        return actual === undefined;
      case "belongscollection":
        return String(value).split(",").includes(String(actual));
      case "notbelongscollection":
        return !String(value).split(",").includes(String(actual));
      default:
        throw Error("原版Mock条件不支持");
    }
  } catch {
    return false;
  }
}
export async function nativeMockResponse(project, request, input) {
  const mock = normalizeNativeMock(request.nativeMock);
  if (!mock.enabled)
    return validateMockResponse({
      status: 404,
      body: JSON.stringify({ error: "Mock service is disabled" }),
      headers: { "content-type": "application/json" },
    });
  const source = {
    query: input.query || {},
    headers: input.headers || {},
    body: input.body,
  };
  if (Buffer.byteLength(JSON.stringify(source)) > 262144)
    throw Error("原版条件Mock输入最多256KiB");
  const candidates = [],
    patterns = [];
  let work = 0;
  for (const rule of mock.rules) {
    if (!rule.enabled) continue;
    const checks = [];
    let matches = true;
    for (const condition of rule.conditions) {
      const actual = read(source, condition.path);
      work += JSON.stringify(actual)?.length || 0;
      work += JSON.stringify(condition.value).length;
      if (work > 1048576) throw Error("原版Mock条件比较总量超过1MiB");
      if (condition.op === "regularmatch") {
        let text;
        try {
          text = String(actual);
        } catch {
          matches = false;
          break;
        }
        checks.push({ ...nativeRegex(condition.value), text });
      } else if (!compare(actual, condition.op, condition.value)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const indices = checks.map((check) => patterns.push(check) - 1);
    candidates.push({ rule, indices });
    if (!checks.length) break;
  }
  let results = [];
  if (patterns.length) {
    if (Buffer.byteLength(JSON.stringify(patterns)) > 131072)
      throw Error("原版Mock正则输入合计最多128KiB");
    if (activeRegex >= 4) throw Error("原版Mock正则并发最多4个请求");
    activeRegex++;
    try {
      const execution = await runScript(
        'apt.setVar("matches",apt.getVar("patterns").map(item=>new RegExp(item.pattern,item.flags).test(item.text)));',
        { variables: { patterns }, allowNetwork: false },
      );
      results = execution.variables.matches;
    } finally {
      activeRegex--;
    }
  }
  const selected =
    candidates.find((candidate) =>
      candidate.indices.every((index) => results[index] === true),
    )?.rule.response || mock.fallback;
  const response = {
    status: selected.status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      ...selected.headers,
    },
    delayMs: selected.delayMs ?? 0,
    body:
      selected.schema === undefined
        ? selected.body
        : JSON.stringify(sampleProjectSchema(project, selected.schema)),
  };
  return validateMockResponse(response);
}
