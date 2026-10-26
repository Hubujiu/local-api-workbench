import { nativeXMLPath } from "./native-xml-path.mjs";
import { jsonPathSegments } from "./json-path.mjs";
import {
  nativeDataArray,
  nativeDataObject,
} from "./native-response-extraction.mjs";

const unaryComparisons = ["null", "notnull", "exist", "notexist"];
const comparisons = [
  "eq",
  "uneq",
  "includes",
  "unincludes",
  "lt",
  "lte",
  "gt",
  "gte",
  ...unaryComparisons,
  "belongscollection",
  "notbelongscollection",
];
const text = (value, max) =>
  typeof value === "string" && value.isWellFormed() && value.length <= max;
export function normalizeNativeAssertionData(value, { enabled = true } = {}) {
  nativeDataObject(value, ["type", "expression"]);
  if (!["type", "expression"].every((key) => Object.hasOwn(value, key)))
    throw Error("原生断言缺少自有来源或表达式字段");
  if (
    ![
      "responseCode",
      "responseJson",
      "responseHeader",
      "responseXml",
      "responseText",
    ].includes(value.type)
  )
    throw Error(
      "原生断言仅支持responseCode/responseJson/responseHeader/responseXml/responseText",
    );
  const expression = value.expression;
  nativeDataObject(expression, ["path", "compareType", "compareValue"]);
  const isText = value.type === "responseText",
    hasPath = Object.hasOwn(expression, "path"),
    hasExpected = Object.hasOwn(expression, "compareValue");
  const path = hasPath ? expression.path : undefined;
  const compareType = Object.hasOwn(expression, "compareType")
    ? expression.compareType
    : undefined;
  if (
    (!hasExpected && !unaryComparisons.includes(compareType)) ||
    (!isText && !hasPath)
  )
    throw Error("原生断言表达式缺少自有字段");
  if (
    (hasPath && !text(path, 1000)) ||
    (hasExpected && !text(expression.compareValue, 65536)) ||
    (compareType !== undefined && !comparisons.includes(compareType)) ||
    (enabled && compareType === undefined)
  )
    throw Error("原生断言仅支持有界文字路径与14种非正则字面比较");
  if (
    enabled &&
    ((!isText && /\{\{/.test(path)) ||
      (hasExpected && /\{\{/.test(expression.compareValue)))
  )
    throw Error("原生断言模板尚未支持，不能替换为不同的变量展开语义");
  if (enabled && value.type === "responseJson")
    jsonPathSegments(expression.path || "$");
  if (enabled && value.type === "responseXml") nativeXMLPath(expression.path);
  const result = {
    type: value.type,
    expression: {
      ...(hasPath ? { path } : {}),
      ...(compareType !== undefined ? { compareType } : {}),
      ...(hasExpected ? { compareValue: expression.compareValue } : {}),
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
    if (!["name", "data"].every((key) => Object.hasOwn(entry, key)))
      throw Error("原生断言缺少自有名称或数据字段");
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
    ...(data.type === "responseHeader"
      ? { header: data.expression.path.toLowerCase() }
      : {}),
    ...(data.type === "responseXml"
      ? { xmlPath: nativeXMLPath(data.expression.path) }
      : {}),
    ...(data.type === "responseText"
      ? {
          diagnostic: Object.hasOwn(data.expression, "path")
            ? data.expression.path
            : "",
        }
      : {}),
    comparison: data.expression.compareType,
    ...(Object.hasOwn(data.expression, "compareValue")
      ? { expected: data.expression.compareValue }
      : {}),
  }));
}

// Trusted implementation is serialized independently of source data. Only
// numeric operation indexes are inserted into the ordered native program.
function installNativeAssertions(
  json,
  readResponse,
  registerTest,
  publicTests,
  headers,
  headerEvidenceJSON,
  readXML,
  readText,
) {
  const parse = JSON.parse,
    descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn,
    charCode = Function.prototype.call.bind(String.prototype.charCodeAt),
    indexOf = Function.prototype.call.bind(String.prototype.indexOf),
    finite = Number.isFinite,
    number = Number,
    string = String,
    Failure = Error,
    stringify = JSON.stringify,
    create = Object.create,
    define = Object.defineProperty;
  const operations = parse(json),
    evidence = create(null),
    headerEvidence = parse(headerEvidenceJSON),
    initialHeaders = create(null);
  // Capture only presence, before user tasks run. A wire field missing from the
  // initial Node projection is unknown, not an observed script-side deletion.
  for (let index = 0; index < operations.length; index++) {
    const op = operations[index];
    if (op.type === "responseHeader")
      initialHeaders[op.header] = !!descriptor(headers, op.header);
  }
  const readHeader = (name) => {
    if (headerEvidence?.complete !== true)
      throw Failure("原生断言响应头需要完整且唯一的传输证据");
    const count = descriptor(headerEvidence.counts, name),
      property = descriptor(headers, name);
    if (!count) {
      if (property) throw Failure("原生断言响应头缺少传输证据");
      return undefined;
    }
    if (!hasOwn(count, "value") || count.value !== 1)
      throw Failure("原生断言响应头需要完整且唯一的传输证据");
    if (!initialHeaders[name])
      throw Failure("原生断言响应头初始映射缺失，不能证明字段被删除");
    if (!property) return undefined;
    if (
      !property.enumerable ||
      !hasOwn(property, "value") ||
      typeof property.value !== "string"
    )
      throw Failure("原生断言响应头不是自有字符串数据");
    const value = property.value;
    if (value.length > 65536) throw Failure("原生断言响应头值超过64KiB");
    let bytes = 0;
    for (let at = 0; at < value.length; at++) {
      const code = charCode(value, at);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = charCode(value, ++at);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw Failure("原生断言响应头值包含无效Unicode");
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Failure("原生断言响应头值包含无效Unicode");
      else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (bytes > 65536) throw Failure("原生断言响应头值超过64KiB");
    }
    return value;
  };
  const safeArray = () => {
    const value = [];
    define(value, "toJSON", { value: undefined });
    return value;
  };
  let consumed = 0,
    completed = 0,
    failed = false;
  const perform = (index) => {
    const op = operations[index];
    // Header/XML/Text bypass the eager body/code reader. Text and XML share
    // their private current-body readers with pick; Code/JSON stays unchanged.
    const response =
      op.type === "responseHeader" ||
      op.type === "responseXml" ||
      op.type === "responseText"
        ? null
        : readResponse();
    let value =
      op.type === "responseHeader"
        ? readHeader(op.header)
        : op.type === "responseXml"
          ? readXML()(op.xmlPath)
          : op.type === "responseText"
            ? readText()
            : response.status;
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
    const actual = string(value);
    let passed = false,
      message = "响应值不满足声明比较";
    switch (op.comparison) {
      case "eq":
        passed = actual === op.expected;
        message = "响应值与预期不相等";
        break;
      case "uneq":
        passed = actual !== op.expected;
        message = "响应值与预期相等";
        break;
      case "includes":
        passed = indexOf(actual, op.expected) !== -1;
        message = "响应值不包含预期字符串";
        break;
      case "unincludes":
        passed = indexOf(actual, op.expected) === -1;
        message = "响应值包含预期字符串";
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        // Raw permitted primitives, not String(value). Conversion may produce
        // NaN/Infinity; these stay internal and ordinary comparisons are total.
        const left = number(value),
          right = number(op.expected);
        passed =
          op.comparison === "lt"
            ? left < right
            : op.comparison === "lte"
              ? left <= right
              : op.comparison === "gt"
                ? left > right
                : left >= right;
        break;
      }
      case "null":
        // Chai .empty on the permitted domain succeeds only for raw "".
        // Its primitive type errors are completed failed tests, not stage errors.
        passed = value === "";
        break;
      case "notnull":
        passed = actual.length !== 0;
        break;
      case "exist":
        passed = value !== null && value !== undefined;
        break;
      case "notexist":
        passed = value === null || value === undefined;
        break;
      case "belongscollection":
      case "notbelongscollection": {
        // Exact comma-delimited membership, including empty members. Reject a
        // comma in the candidate before a bounded delimiter-padded search: a
        // split token can never contain one. No split array or CSV interpretation.
        const member =
          indexOf(actual, ",") === -1 &&
          indexOf("," + op.expected + ",", "," + actual + ",") !== -1;
        passed = op.comparison === "belongscollection" ? member : !member;
        break;
      }
      default:
        throw Failure("原生断言比较类型无效");
    }
    if (op.type === "responseText" && op.diagnostic)
      message = op.diagnostic + ": " + message;
    const before = publicTests.length;
    registerTest(op.name, () => {
      if (!passed) throw Failure(message);
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
