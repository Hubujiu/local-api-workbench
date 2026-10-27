import { nativeXMLPath } from "./native-xml-path.mjs";
import { jsonPathSegments } from "./json-path.mjs";

export function nativeDataObject(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("原生提取任务须为普通数据对象");
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !property.enumerable ||
      !Object.hasOwn(property, "value")
    )
      throw Error("原生提取任务包含未知字段或访问器");
  }
}
export function nativeDataArray(value, limit) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw Error("原生提取任务数组无效或超限");
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, index);
    if (!property?.enumerable || !Object.hasOwn(property, "value"))
      throw Error("原生提取任务数组不能有空洞或访问器");
  }
}
const text = (value, limit) =>
  typeof value === "string" && value.isWellFormed() && value.length <= limit;
const safeName = (value) =>
  text(value, 200) &&
  value.trim() &&
  !["__proto__", "prototype", "constructor"].includes(value);
const scopes = {
  tempVars: "temporary",
  envVars: "environment",
  globalVars: "global",
};

export const isNativeRequestPick = (source) =>
  ["requestHeader", "requestBody"].includes(source);
const metadataSources = ["responseCode", "responseTime", "responseSize"];
const wholeValueSource = (source) =>
  source === "responseText" || metadataSources.includes(source);

const headerName = (expression) => {
  const name = expression.trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
    throw Error("pickVars响应头表达式须为字面HTTP字段名");
  return name.toLowerCase();
};

export function normalizePickVarsData(value, { enabled = true } = {}) {
  nativeDataObject(value, ["source", "variables"]);
  if (!["source", "variables"].every((key) => Object.hasOwn(value, key)))
    throw Error("pickVars缺少自有来源或变量字段");
  if (
    ![
      "requestHeader",
      "requestBody",
      "responseJson",
      "responseHeader",
      "responseXml",
      "responseText",
      ...metadataSources,
    ].includes(value.source)
  )
    throw Error(
      "pickVars仅支持requestHeader/requestBody/responseJson/responseHeader/responseXml/responseText/responseCode/responseTime/responseSize来源",
    );
  const isText = wholeValueSource(value.source);
  nativeDataArray(value.variables, 100);
  const variables = value.variables.map((row) => {
    nativeDataObject(row, ["name", "expression", "type"]);
    const required = isText ? ["name", "type"] : ["name", "expression", "type"];
    if (!required.every((key) => Object.hasOwn(row, key)))
      throw Error("pickVars变量缺少自有字段");
    if (
      !text(row.name, 200) ||
      (Object.hasOwn(row, "expression") && !text(row.expression, 1000)) ||
      typeof row.type !== "string" ||
      !Object.hasOwn(scopes, row.type)
    )
      throw Error("pickVars变量字段或作用域无效");
    if (enabled) {
      if (!safeName(isText ? row.name.trim() : row.name))
        throw Error("pickVars变量名无效");
      if (["responseHeader", "requestHeader"].includes(value.source))
        headerName(row.expression);
      else if (value.source === "responseXml") nativeXMLPath(row.expression);
      else if (!isText) jsonPathSegments(row.expression.trim() || "$");
    }
    return {
      name: row.name,
      ...(Object.hasOwn(row, "expression")
        ? { expression: row.expression }
        : {}),
      type: row.type,
    };
  });
  const result = { source: value.source, variables };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw Error("pickVars数据最多64KiB");
  return result;
}
export function compilePickVarsOperations(value = []) {
  nativeDataArray(value, 16);
  const normalized = value.map((data) => normalizePickVarsData(data));
  if (Buffer.byteLength(JSON.stringify(normalized)) > 262144)
    throw Error("pickVars阶段数据超过256KiB");
  return normalized.map((data) => ({
    source: data.source,
    variables: data.variables.map((row) => ({
      name: wholeValueSource(data.source) ? row.name.trim() : row.name,
      scope: scopes[row.type],
      ...(["responseHeader", "requestHeader"].includes(data.source)
        ? { header: headerName(row.expression) }
        : data.source === "responseXml"
          ? { xmlPath: nativeXMLPath(row.expression) }
          : wholeValueSource(data.source)
            ? {}
            : { segments: jsonPathSegments(row.expression.trim() || "$") }),
    })),
  }));
}

// Serialized trusted implementation, not user text. Data enters as a JSON string
// handle; no source name, expression or response is concatenated into VM code.
function installPickVars(
  json,
  readBody,
  headers,
  evidenceJSON,
  environment,
  global,
  temporary,
  readXML,
  readText,
  metricResponse,
  readRequest,
) {
  const parse = JSON.parse,
    descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn,
    keys = Object.keys,
    create = Object.create,
    define = Object.defineProperty,
    isArray = Array.isArray,
    finite = Number.isFinite,
    charCode = Function.prototype.call.bind(String.prototype.charCodeAt);
  const operations = parse(json),
    evidence = parse(evidenceJSON),
    setters = { environment, global, temporary };
  let nodes = 0;
  const copy = (value, depth = 0) => {
    if (++nodes > 10000 || depth > 64) throw Error("pickVars提取值结构超限");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") {
      if (!finite(value)) throw Error("pickVars提取值必须是有限JSON数字");
      return value;
    }
    const output = isArray(value) ? [] : create(null),
      names = keys(value);
    for (let at = 0; at < names.length; at++) {
      const key = names[at],
        property = descriptor(value, key);
      if (!property || !hasOwn(property, "value"))
        throw Error("pickVars提取值必须是JSON数据");
      define(output, key, {
        value: copy(property.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (isArray(output)) define(output, "toJSON", { value: undefined });
    return output;
  };
  const headerValue = (name) => {
    const count =
      evidence?.complete === true ? descriptor(evidence.counts, name) : null;
    if (!count || count.value !== 1)
      throw Error("pickVars响应头需要完整且唯一的传输证据");
    const property = descriptor(headers, name);
    if (
      !property?.enumerable ||
      !hasOwn(property, "value") ||
      typeof property.value !== "string"
    )
      throw Error("pickVars响应头不存在或不是自有字符串数据");
    const value = property.value;
    if (value.length > 65536) throw Error("pickVars响应头值超过64KiB");
    let bytes = 0;
    for (let at = 0; at < value.length; at++) {
      const code = charCode(value, at);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = charCode(value, ++at);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw Error("pickVars响应头值包含无效Unicode");
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Error("pickVars响应头值包含无效Unicode");
      else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (bytes > 65536) throw Error("pickVars响应头值超过64KiB");
    }
    return value;
  };
  const metadataValue = (source) => {
    const name = source === "responseCode" ? "code" : source;
    const property = descriptor(metricResponse, name);
    if (!property?.enumerable || !hasOwn(property, "value"))
      throw Error("pickVars指标必须是当前自有数据字段");
    const value = property.value;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && finite(value)) return value;
    if (typeof value !== "string")
      throw Error("pickVars指标必须是有限JSON原始值");
    if (value.length > 65536) throw Error("pickVars指标超过64KiB");
    let bytes = 0;
    for (let at = 0; at < value.length; at++) {
      const code = charCode(value, at);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = charCode(value, ++at);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw Error("pickVars指标包含无效Unicode");
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw Error("pickVars指标包含无效Unicode");
      else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (bytes > 65536) throw Error("pickVars指标超过64KiB");
    }
    return value;
  };
  let consumed = 0,
    completed = 0,
    failed = false;
  const perform = (index) => {
    const operation = operations[index];
    let root;
    // Header-only extraction must not depend on the body being JSON.
    if (operation.source === "responseJson") {
      try {
        root = parse(readBody());
      } catch {
        throw Error("pickVars需要严格JSON响应");
      }
      if (root === null || typeof root !== "object")
        throw Error("pickVars响应根须为JSON对象或数组");
    }
    if (
      operation.source === "requestBody" ||
      operation.source === "requestHeader"
    )
      root = readRequest(operation.source);
    const selectXML = operation.source === "responseXml" ? readXML() : null;
    // Text is the entire current body, read once per task, never per row.
    const currentText = operation.source === "responseText" ? readText() : null;
    const isMetadata =
      operation.source === "responseCode" ||
      operation.source === "responseTime" ||
      operation.source === "responseSize";
    // Snapshot the captured current facade once per task, never per row.
    const currentMetadata = isMetadata ? metadataValue(operation.source) : null;
    const rows = operation.variables,
      assignments = create(null);
    nodes = 0;
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at];
      let value =
        operation.source === "requestHeader"
          ? (() => {
              const item = descriptor(root, row.header);
              if (!item?.enumerable || !hasOwn(item, "value"))
                throw Error("请求Header提取字段不存在");
              return item.value;
            })()
          : operation.source === "responseHeader"
            ? headerValue(row.header)
            : operation.source === "responseXml"
              ? selectXML(row.xmlPath)
              : operation.source === "responseText"
                ? currentText
                : isMetadata
                  ? currentMetadata
                  : root;
      if (
        operation.source === "responseJson" ||
        operation.source === "requestBody"
      )
        for (let part = 0; part < row.segments.length; part++) {
          if (value === null || typeof value !== "object")
            throw Error("pickVars响应路径不存在");
          const property = descriptor(value, row.segments[part]);
          if (!property?.enumerable || !hasOwn(property, "value"))
            throw Error("pickVars响应路径不存在");
          value = property.value;
        }
      assignments[at] = {
        name: row.name,
        scope: row.scope,
        value: copy(value),
      };
    }
    // Validate all rows before applying any assignment. A phase failure is never
    // returned as a successful VM result, so none of its scope changes commit.
    for (let at = 0; at < rows.length; at++) {
      const row = assignments[at];
      setters[row.scope](row.name, row.value);
    }
  };
  return {
    run: (index) => {
      if (failed || index !== consumed || index >= operations.length) {
        failed = true;
        throw Error("pickVars任务次序无效");
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
    assertComplete: () => {
      if (failed || completed !== operations.length)
        throw Error("pickVars阶段存在未完成的提取任务");
    },
  };
}
export const pickVarsInstallerSource = installPickVars.toString();
