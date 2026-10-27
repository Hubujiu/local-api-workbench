import { jsonPathSegments } from "./json-path.mjs";
import {
  nativeDataArray,
  nativeDataObject,
} from "./native-response-extraction.mjs";

const text = (value, max) =>
  typeof value === "string" && value.isWellFormed() && value.length <= max;
export function normalizeNativeAssertionData(value, { enabled = true } = {}) {
  nativeDataObject(value, ["type", "expression"]);
  if (!["responseCode", "responseJson"].includes(value.type))
    throw Error("原生断言仅支持responseCode/responseJson");
  const expression = value.expression;
  nativeDataObject(expression, ["path", "compareType", "compareValue"]);
  if (
    !text(expression.path, 1000) ||
    !text(expression.compareValue, 65536) ||
    (expression.compareType !== undefined &&
      !["eq", "uneq"].includes(expression.compareType)) ||
    (enabled && expression.compareType === undefined)
  )
    throw Error("原生断言仅支持有界文字路径与eq/uneq字面字符串比较");
  if (
    enabled &&
    (/\{\{/.test(expression.path) || /\{\{/.test(expression.compareValue))
  )
    throw Error("原生断言模板尚未支持，不能替换为不同的变量展开语义");
  if (enabled && value.type === "responseJson")
    jsonPathSegments(expression.path || "$");
  const result = {
    type: value.type,
    expression: {
      path: expression.path,
      ...(expression.compareType !== undefined
        ? { compareType: expression.compareType }
        : {}),
      compareValue: expression.compareValue,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw Error("原生断言数据最多64KiB");
  return result;
}

export function compileNativeAssertions(value = []) {
  nativeDataArray(value, 16);
  const normalized = value.map((entry) => {
    nativeDataObject(entry, ["name", "data"]);
    if (!text(entry.name, 200) || !entry.name.trim())
      throw Error("原生断言名称无效");
    return { name: entry.name, data: normalizeNativeAssertionData(entry.data) };
  });
  if (Buffer.byteLength(JSON.stringify(normalized)) > 262144)
    throw Error("原生断言阶段数据超过256KiB");
  return normalized.map(({ name, data }) => ({
    name,
    type: data.type,
    segments:
      data.type === "responseJson"
        ? jsonPathSegments(data.expression.path || "$")
        : [],
    comparison: data.expression.compareType,
    expected: data.expression.compareValue,
  }));
}

// Trusted implementation is serialized independently of source data. Only
// numeric operation indexes are inserted into the ordered native program.
function installNativeAssertions(
  json,
  readResponse,
  registerTest,
  publicTests,
) {
  const parse = JSON.parse,
    descriptor = Object.getOwnPropertyDescriptor,
    finite = Number.isFinite,
    string = String,
    Failure = Error,
    stringify = JSON.stringify,
    create = Object.create,
    define = Object.defineProperty;
  const operations = parse(json),
    evidence = create(null);
  const safeArray = () => {
    const value = [];
    define(value, "toJSON", { value: undefined });
    return value;
  };
  let consumed = 0,
    completed = 0,
    failed = false;
  const perform = (index) => {
    const op = operations[index],
      response = readResponse();
    let value = response.status;
    if (op.type === "responseJson") {
      try {
        value = parse(response.body);
      } catch {
        throw Failure("原生断言需要严格JSON响应");
      }
      if (value === null || typeof value !== "object")
        throw Failure("原生断言响应根须为JSON对象或数组");
      for (let at = 0; at < op.segments.length; at++) {
        if (value === null || typeof value !== "object") {
          value = undefined;
          break;
        }
        const property = descriptor(value, op.segments[at]);
        if (!property?.enumerable || !("value" in property)) {
          value = undefined;
          break;
        }
        value = property.value;
      }
    }
    if (
      (value !== null &&
        !(
          typeof value === "undefined" ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        )) ||
      (typeof value === "number" && !finite(value))
    )
      throw Failure(
        "原生断言仅比较有限JSON原始值或缺失值，不隐式转换对象/数组",
      );
    const actual = string(value),
      equal = actual === op.expected;
    const passed = op.comparison === "eq" ? equal : !equal;
    const message =
      op.comparison === "eq" ? "响应值与预期不相等" : "响应值与预期相等";
    const before = publicTests.length;
    registerTest(op.name, () => {
      if (op.comparison === "eq" ? !equal : equal)
        throw Failure(
          op.comparison === "eq" ? "响应值与预期不相等" : "响应值与预期相等",
        );
    });
    const record = create(null);
    record.name = op.name;
    record.passed = passed;
    if (!passed) record.error = message;
    evidence[index] = {
      record,
      publicRecord: descriptor(publicTests, before)?.value,
    };
  };
  return {
    run: (index) => {
      if (failed || index !== consumed || index >= operations.length) {
        failed = true;
        throw Failure("原生断言任务次序无效");
      }
      consumed++;
      try {
        perform(index);
        completed++;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    readEvidence: () => {
      if (publicTests.length > 1000) throw Failure("脚本断言最多1000条");
      const entries = safeArray();
      for (let index = 0; index < completed; index++) {
        const item = evidence[index],
          output = create(null);
        output.index = -1;
        output.record = item.record;
        if (item.publicRecord)
          for (let at = 0; at < publicTests.length; at++)
            if (descriptor(publicTests, at)?.value === item.publicRecord) {
              output.index = at;
              break;
            }
        define(entries, index, { value: output, enumerable: true });
      }
      return stringify(entries);
    },
    assertComplete: () => {
      if (failed || completed !== operations.length)
        throw Failure("原生断言阶段存在未完成的声明任务");
    },
  };
}
export const nativeAssertionsInstallerSource =
  installNativeAssertions.toString();
