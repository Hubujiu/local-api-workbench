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
      !("value" in property)
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
    if (!property?.enumerable || !("value" in property))
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

export function normalizePickVarsData(value, { enabled = true } = {}) {
  nativeDataObject(value, ["source", "variables"]);
  if (value.source !== "responseJson")
    throw Error("pickVars仅支持responseJson，不支持Header/XML等来源");
  nativeDataArray(value.variables, 100);
  const variables = value.variables.map((row) => {
    nativeDataObject(row, ["name", "expression", "type"]);
    if (
      !text(row.name, 200) ||
      !text(row.expression, 1000) ||
      typeof row.type !== "string" ||
      !Object.hasOwn(scopes, row.type)
    )
      throw Error("pickVars变量字段或作用域无效");
    if (enabled) {
      if (!safeName(row.name)) throw Error("pickVars变量名无效");
      jsonPathSegments(row.expression.trim() || "$");
    }
    return { name: row.name, expression: row.expression, type: row.type };
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
    variables: data.variables.map((row) => ({
      name: row.name,
      scope: scopes[row.type],
      segments: jsonPathSegments(row.expression.trim() || "$"),
    })),
  }));
}

// Serialized trusted implementation, not user text. Data enters as a JSON string
// handle; no source name, expression or response is concatenated into VM code.
function installPickVars(json, readBody, environment, global, temporary) {
  const parse = JSON.parse,
    descriptor = Object.getOwnPropertyDescriptor,
    keys = Object.keys,
    create = Object.create,
    define = Object.defineProperty,
    isArray = Array.isArray,
    finite = Number.isFinite;
  const operations = parse(json),
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
      if (!property || !("value" in property))
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
  let next = 0;
  return (index) => {
    if (index !== next || index >= operations.length)
      throw Error("pickVars任务次序无效");
    next++;
    let root;
    try {
      root = parse(readBody());
    } catch {
      throw Error("pickVars需要严格JSON响应");
    }
    if (root === null || typeof root !== "object")
      throw Error("pickVars响应根须为JSON对象或数组");
    const rows = operations[index].variables,
      assignments = create(null);
    nodes = 0;
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at];
      let value = root;
      for (let part = 0; part < row.segments.length; part++) {
        if (value === null || typeof value !== "object")
          throw Error("pickVars响应路径不存在");
        const property = descriptor(value, row.segments[part]);
        if (!property?.enumerable || !("value" in property))
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
}
export const pickVarsInstallerSource = installPickVars.toString();
