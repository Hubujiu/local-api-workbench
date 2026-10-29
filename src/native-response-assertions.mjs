import { nativeCookieName } from "./native-cookie-name.mjs";
import { nativeXMLPath } from "./native-xml-path.mjs";
import { jsonPathSegments } from "./json-path.mjs";
import {
  nativeDataArray,
  nativeDataObject,
} from "./native-response-extraction.mjs";

export const isNativeVariableAssertion = (type) =>
  ["tempVars", "envVars", "globalVars"].includes(type);

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
  "regularmatch",
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
      "responseCookie",
      "responseXml",
      "responseText",
      "responseTime",
      "responseSize",
      "tempVars",
      "envVars",
      "globalVars",
    ].includes(value.type)
  )
    throw Error(
      "原生断言仅支持responseCode/responseJson/responseHeader/responseCookie/responseXml/responseText/responseTime/responseSize/tempVars/envVars/globalVars",
    );
  const expression = value.expression;
  nativeDataObject(expression, ["path", "compareType", "compareValue"]);
  const isText = ["responseText", "responseTime", "responseSize"].includes(
      value.type,
    ),
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
    throw Error("原生断言仅支持有界文字路径与声明字面比较");
  if (
    compareType === "regularmatch" &&
    (!hasExpected ||
      !text(expression.compareValue, 1024) ||
      Buffer.byteLength(expression.compareValue) > 4096 ||
      (enabled && expression.compareValue.length === 0))
  )
    throw Error("原生正则断言需要非空有界字面模式（1024字符/4096字节）");
  if (
    enabled &&
    !isText &&
    !isNativeVariableAssertion(value.type) &&
    /\{\{/.test(path)
  )
    throw Error("原生断言模板尚未支持，不能替换为不同的变量展开语义");
  if (enabled && value.type === "responseCookie" && !nativeCookieName(path))
    throw Error("原生Cookie断言仅支持普通非保留名称");
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
    ...(data.type === "responseCookie" ? { cookie: data.expression.path } : {}),
    ...(data.type === "responseXml"
      ? { xmlPath: nativeXMLPath(data.expression.path) }
      : {}),
    ...(["responseText", "responseTime", "responseSize"].includes(data.type)
      ? {
          diagnostic: Object.hasOwn(data.expression, "path")
            ? data.expression.path
            : "",
        }
      : {}),
    ...(isNativeVariableAssertion(data.type)
      ? {
          variable: data.expression.path.replace(/^[{}]+|[{}]+$/g, ""),
          diagnostic: data.expression.path,
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
  metricResponse,
  variableMaps,
  cookies,
  cookieEvidenceJSON,
) {
  const parse = JSON.parse,
    descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn,
    ownKeys = Reflect.ownKeys,
    charCode = Function.prototype.call.bind(String.prototype.charCodeAt),
    indexOf = Function.prototype.call.bind(String.prototype.indexOf),
    finite = Number.isFinite,
    number = Number,
    string = String,
    Pattern = RegExp,
    executePattern = Function.prototype.call.bind(RegExp.prototype.exec),
    slice = Function.prototype.call.bind(String.prototype.slice),
    Failure = Error,
    stringify = JSON.stringify,
    create = Object.create,
    define = Object.defineProperty;
  const operations = parse(json),
    evidence = create(null),
    headerEvidence = parse(headerEvidenceJSON),
    initialHeaders = create(null),
    cookieEvidence = cookieEvidenceJSON ? parse(cookieEvidenceJSON) : null;
  let cookiesMatch = cookieEvidence?.complete === true;
  if (cookiesMatch && cookies && typeof cookies === "object") {
    const keys = ownKeys(cookies),
      expected = ownKeys(cookieEvidence.values);
    cookiesMatch = keys.length === expected.length;
    for (let at = 0; cookiesMatch && at < keys.length; at++) {
      const actual = descriptor(cookies, keys[at]),
        known = descriptor(cookieEvidence.values, keys[at]);
      cookiesMatch =
        !!known &&
        actual?.enumerable === true &&
        hasOwn(actual, "value") &&
        actual.value === known.value;
    }
  } else cookiesMatch = false;
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
  const utf8Bytes = (value) => {
    if (typeof value === "string") {
      if (value.length > 65536) throw Failure("原生断言字符串超过64KiB");
      let bytes = 0;
      for (let at = 0; at < value.length; at++) {
        const code = charCode(value, at);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = charCode(value, ++at);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            throw Failure("原生断言字符串包含无效Unicode");
          bytes += 4;
        } else if (code >= 0xdc00 && code <= 0xdfff)
          throw Failure("原生断言字符串包含无效Unicode");
        else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
        if (bytes > 65536) throw Failure("原生断言字符串超过64KiB");
      }
      return bytes;
    }
    return 0;
  };
  const boundedString = (value) => {
    utf8Bytes(value);
    return value;
  };
  const readCookie = (name) => {
    if (!cookiesMatch) throw Failure("原生Cookie断言需要完整且匹配的传输证据");
    const known = descriptor(cookieEvidence.values, name),
      current = descriptor(cookies, name);
    if (!known && current) throw Failure("原生Cookie断言字段缺少传输证据");
    if (!current) return undefined;
    if (
      !current.enumerable ||
      !hasOwn(current, "value") ||
      typeof current.value !== "string"
    )
      throw Failure("原生Cookie断言只读取当前自有字符串数据");
    return boundedString(current.value);
  };
  const readVariable = (type, name) => {
    const map =
      type === "tempVars"
        ? descriptor(variableMaps.local, name)
          ? variableMaps.local
          : variableMaps.effective
        : type === "envVars"
          ? variableMaps.environment
          : variableMaps.globals;
    const property = descriptor(map, name);
    if (!property) return undefined;
    if (!property.enumerable || !hasOwn(property, "value"))
      throw Failure("原生变量断言只读取当前自有数据字段");
    return boundedString(property.value);
  };
  // Independently implemented bounded adapter for Postman superstring's
  // 19-round token grammar; provenance and deliberate differences are in ADR.
  // Fixed grammar only; user patterns are never used by this scanner.
  const marker = new Pattern("\\{\\{([^{}]*?)\\}\\}", "g"),
    reserved = create(null);
  const reservedKeys = ownKeys(Object.prototype);
  for (let at = 0; at < reservedKeys.length; at++)
    reserved[reservedKeys[at]] = true;
  reserved.prototype = true;
  let expansionAttempts = 0;
  const expandExpected = (input) => {
    utf8Bytes(input);
    let current = input;
    for (let round = 0; round < 19; round++) {
      marker.lastIndex = 0;
      let match,
        output = "",
        bytes = 0,
        cursor = 0;
      const append = (part) => {
        const count = utf8Bytes(part);
        if (bytes + count > 65536) throw Failure("原生断言变量展开超过64KiB");
        bytes += count;
        output += part;
      };
      while ((match = executePattern(marker, current)) !== null) {
        if (++expansionAttempts > 1000)
          throw Failure("原生断言阶段变量展开最多1000次");
        const name = match[1];
        if (name.length > 1000) throw Failure("原生断言变量名称最多1000字符");
        if (charCode(name, 0) === 36 || hasOwn(reserved, name))
          throw Failure("原生断言变量展开不支持内置或保留名称");
        append(slice(current, cursor, match.index));
        const local = descriptor(variableMaps.local, name),
          property = local || descriptor(variableMaps.effective, name);
        let replacement = match[0];
        if (property) {
          if (!property.enumerable || !hasOwn(property, "value"))
            throw Failure("原生断言变量展开只读取自有数据字段");
          const value = property.value,
            kind = typeof value;
          if (
            (value !== null &&
              kind !== "undefined" &&
              kind !== "string" &&
              kind !== "boolean" &&
              kind !== "number") ||
            (kind === "number" && !finite(value))
          )
            throw Failure("原生断言变量展开只接受有限原始值");
          replacement = value === undefined ? "" : string(value);
          utf8Bytes(replacement);
        }
        append(replacement);
        cursor = match.index + match[0].length;
      }
      append(slice(current, cursor));
      if (output === current) return output;
      current = output;
    }
    return current;
  };
  const readMetric = (name) => {
    const property = descriptor(metricResponse, name);
    if (!property) return undefined;
    if (!property.enumerable || !hasOwn(property, "value"))
      throw Failure("原生指标断言只读取当前自有数据字段");
    return boundedString(property.value);
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
      op.type === "responseCookie" ||
      op.type === "responseHeader" ||
      op.type === "responseXml" ||
      op.type === "responseText" ||
      op.type === "responseTime" ||
      op.type === "responseSize" ||
      op.type === "tempVars" ||
      op.type === "envVars" ||
      op.type === "globalVars"
        ? null
        : readResponse();
    let value =
      op.type === "responseCookie"
        ? readCookie(op.cookie)
        : op.type === "responseHeader"
          ? readHeader(op.header)
          : op.type === "responseXml"
            ? readXML()(op.xmlPath)
            : op.type === "responseText"
              ? readText()
              : op.type === "responseTime" || op.type === "responseSize"
                ? readMetric(op.type)
                : op.type === "tempVars" ||
                    op.type === "envVars" ||
                    op.type === "globalVars"
                  ? readVariable(op.type, op.variable)
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
    const actual = string(value),
      expected = hasOwn(op, "expected")
        ? expandExpected(op.expected)
        : undefined;
    let passed = false,
      message = "响应值不满足声明比较";
    switch (op.comparison) {
      case "regularmatch": {
        // Pattern syntax is evaluated only after this task reads a safe source.
        // No flags grammar: remove all literal edge slashes, not whitespace.
        boundedString(actual);
        if (
          !expected.length ||
          expected.length > 1024 ||
          utf8Bytes(expected) > 4096
        )
          throw Failure(
            "原生正则断言展开后需要非空有界模式（1024字符/4096字节）",
          );
        let first = 0,
          last = expected.length;
        while (first < last && charCode(expected, first) === 47) first++;
        while (last > first && charCode(expected, last - 1) === 47) last--;
        const pattern = slice(expected, first, last);
        // Normalization already bounds the raw pattern; trimming only shrinks it.
        const expression = new Pattern(pattern);
        passed = executePattern(expression, actual) !== null;
        message = "响应值不匹配声明正则";
        break;
      }
      case "eq":
        passed = actual === expected;
        message = "响应值与预期不相等";
        break;
      case "uneq":
        passed = actual !== expected;
        message = "响应值与预期相等";
        break;
      case "includes":
        passed = indexOf(actual, expected) !== -1;
        message = "响应值不包含预期字符串";
        break;
      case "unincludes":
        passed = indexOf(actual, expected) === -1;
        message = "响应值包含预期字符串";
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        // Raw permitted primitives, not String(value). Conversion may produce
        // NaN/Infinity; these stay internal and ordinary comparisons are total.
        const left = number(value),
          right = number(expected);
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
          indexOf("," + expected + ",", "," + actual + ",") !== -1;
        passed = op.comparison === "belongscollection" ? member : !member;
        break;
      }
      default:
        throw Failure("原生断言比较类型无效");
    }
    if (op.diagnostic) message = op.diagnostic + ": " + message;
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
