function variableKey(key) {
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 200 ||
    ["__proto__", "prototype", "constructor"].includes(key)
  )
    throw Error("变量名无效");
  return key;
}
function valueCopy(value) {
  const text = JSON.stringify(value, (_key, item) => {
    if (
      item === undefined ||
      ["function", "symbol", "bigint"].includes(typeof item) ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw Error("变量值必须为有效JSON");
    return item;
  });
  if (text === undefined) throw Error("变量值必须为有效JSON");
  return JSON.parse(text);
}
function mapKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("变量表必须为对象");
  return Object.keys(value).map(variableKey);
}
function definitionCopy(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "initialValue") ||
    Object.keys(value).some(
      (key) => !["initialValue", "description"].includes(key),
    )
  )
    throw Error("变量初始定义无效");
  const description = value.description ?? "";
  if (typeof description !== "string" || description.length > 4000)
    throw Error("变量说明必须为最多4000字符的文本");
  return { initialValue: valueCopy(value.initialValue), description };
}
export function variableRows(values = {}, definitions = {}) {
  const keys = [...new Set([...mapKeys(values), ...mapKeys(definitions)])];
  if (keys.length > 10000) throw Error("变量数量超过限制");
  return keys.map((key) => {
    const currentSet = Object.hasOwn(values, key),
      initialExplicit = Object.hasOwn(definitions, key);
    const definition = initialExplicit
      ? definitionCopy(definitions[key])
      : {
          initialValue: currentSet ? valueCopy(values[key]) : "",
          description: "",
        };
    return {
      key,
      ...definition,
      currentSet,
      currentValue: currentSet ? valueCopy(values[key]) : undefined,
      initialExplicit,
    };
  });
}
export function variableMapsFromRows(rows) {
  if (!Array.isArray(rows) || rows.length > 10000)
    throw Error("变量列表最多10000项");
  const values = {},
    definitions = {};
  for (const row of rows) {
    const key = variableKey(row?.key);
    if (Object.hasOwn(definitions, key)) throw Error("变量名重复: " + key);
    if (typeof row.currentSet !== "boolean")
      throw Error("当前值是否设置必须为布尔值");
    definitions[key] = definitionCopy({
      initialValue: row.initialValue,
      description: row.description,
    });
    if (row.currentSet) values[key] = valueCopy(row.currentValue);
  }
  return { values, definitions };
}
export function updateVariable(values = {}, definitions = {}, args = {}) {
  variableRows(values, definitions);
  const key = variableKey(args.key),
    has = (name) => Object.hasOwn(args, name);
  if (has("value") && has("currentValue"))
    throw Error("value 与 currentValue 不可同时提供");
  const existed = Object.hasOwn(values, key) || Object.hasOwn(definitions, key);
  const nextValues = valueCopy(values),
    nextDefinitions = valueCopy(definitions);
  if (has("initialValue") || has("description")) {
    const previous = Object.hasOwn(definitions, key)
      ? definitionCopy(definitions[key])
      : {
          initialValue: Object.hasOwn(values, key)
            ? valueCopy(values[key])
            : has("value")
              ? valueCopy(args.value)
              : "",
          description: "",
        };
    nextDefinitions[key] = definitionCopy({
      initialValue: has("initialValue")
        ? args.initialValue
        : previous.initialValue,
      description: has("description") ? args.description : previous.description,
    });
  }
  if (has("value") || has("currentValue"))
    nextValues[key] = valueCopy(
      has("currentValue") ? args.currentValue : args.value,
    );
  else if (!existed) nextValues[key] = "";
  const variable = variableRows(nextValues, nextDefinitions).find(
    (row) => row.key === key,
  );
  return { values: nextValues, definitions: nextDefinitions, variable };
}
