import { selectedEnvironment } from "./environments.mjs";

const plain = (value) =>
  value &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const limitFor = (type) => (type === "sse" ? 65536 : 1048576);
const validEnvironmentId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value.isWellFormed();

// Parse and account for every UTF-8 segment before constructing the result.
// Values are data, never expressions, replacement patterns or another template.
export function resolveProtocolText(text, variables, limit = 1048576) {
  if (
    typeof text !== "string" ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > limit
  )
    throw Error("协议文本模板无效或超过字节上限");
  const pieces = [];
  let offset = 0,
    bytes = 0;
  const add = (value) => {
    bytes += Buffer.byteLength(value);
    if (bytes > limit) throw Error("协议文本模板展开超过字节上限");
    pieces.push(value);
  };
  while (offset < text.length) {
    const start = text.indexOf("{{", offset);
    const literal = text.slice(offset, start < 0 ? text.length : start);
    if (literal.includes("}}")) throw Error("协议变量占位符格式无效");
    add(literal);
    if (start < 0) break;
    const end = text.indexOf("}}", start + 2);
    if (end < 0) throw Error("协议变量占位符格式无效");
    const name = text.slice(start + 2, end).trim();
    if (!name || name.length > 200 || /[{}]/.test(name) || forbidden.has(name))
      throw Error("协议变量占位符名称无效");
    if (variables !== undefined) {
      const property = Object.getOwnPropertyDescriptor(variables, name);
      if (!property || !("value" in property))
        throw Error("协议模板缺少变量: " + name);
      const value = property.value;
      if (
        !(
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        )
      )
        throw Error("协议模板变量必须是文本、有限数字或布尔值: " + name);
      const output = String(value);
      if (!output.isWellFormed()) throw Error("协议模板变量不是有效UTF-8文本");
      add(output);
    }
    offset = end + 2;
  }
  return variables === undefined ? text : pieces.join("");
}

export function validateProtocolTemplate(input, message = input.message ?? "") {
  if (input.templateMode === undefined) return;
  if (!["variables", "literal"].includes(input.templateMode))
    throw Error("协议模板模式无效");
  const text = input.type === "sse" ? input.body : message;
  if (input.type === "sse" && (input.method !== "POST" || text === undefined))
    throw Error("SSE 模板模式仅支持 POST 文本正文");
  const limit = limitFor(input.type);
  if (
    typeof text !== "string" ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > limit
  )
    throw Error("协议模板模式仅支持有界纯文本");
  if (input.templateMode === "variables")
    resolveProtocolText(text, undefined, limit);
}

export function resolveProtocolDefinition(
  definition,
  variables,
  message = definition.message ?? "",
) {
  validateProtocolTemplate(definition, message);
  if (definition.templateMode !== "variables") return { ...definition };
  const field = definition.type === "sse" ? "body" : "message";
  return {
    ...definition,
    templateMode: "literal",
    [field]: resolveProtocolText(
      field === "body" ? definition.body : message,
      variables,
      limitFor(definition.type),
    ),
  };
}

// Capture immutable scalar values, not mutable objects or script/credential scopes.
// Non-scalar values remain invalid if referenced; no value is stringified here.
export function protocolTemplateContext(project, environmentId) {
  if (
    environmentId !== undefined &&
    (typeof environmentId !== "string" || !environmentId)
  )
    throw Error("协议模板环境ID无效");
  const environment = selectedEnvironment(project, environmentId);
  if (!validEnvironmentId(environment.id))
    throw Error("协议模板选中环境ID无效");
  const variables = Object.create(null);
  let entries = 0,
    bytes = 0;
  for (const map of [
    project.globalVariables ?? {},
    environment.variables ?? {},
  ]) {
    if (!plain(map)) throw Error("协议模板变量层无效");
    for (const name of Reflect.ownKeys(map)) {
      const property = Object.getOwnPropertyDescriptor(map, name);
      if (
        typeof name !== "string" ||
        !("value" in property) ||
        !property.enumerable ||
        !name ||
        name.length > 200 ||
        forbidden.has(name) ||
        ++entries > 10000
      )
        throw Error("协议模板变量快照无效或超限");
      const value = property.value;
      bytes +=
        Buffer.byteLength(name) +
        (typeof value === "string" ? Buffer.byteLength(value) : 16);
      if (bytes > 4 * 1048576) throw Error("协议模板变量快照超过4MiB");
      variables[name] =
        typeof value === "object" || typeof value === "function" ? null : value;
    }
  }
  return { environmentId: environment.id, variables };
}

export function validateTemplateProvenance(value, definition) {
  if (value === undefined) return;
  if (
    !plain(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    Reflect.ownKeys(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      );
    }) ||
    !Object.hasOwn(value, "sourceDefinitionHash") ||
    !Object.hasOwn(value, "environmentId") ||
    typeof value.sourceDefinitionHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceDefinitionHash) ||
    !validEnvironmentId(value.environmentId) ||
    definition.templateMode !== "literal"
  )
    throw Error("协议模板来源记录无效");
}
