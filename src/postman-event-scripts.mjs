import { types } from "node:util";

const LIMIT = 100000;
const fail = (detail) => Error("Postman事件脚本" + detail);
function record(value, allowed, opaque = []) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail("须为普通对象");
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields)) {
    const field = fields[key];
    if (typeof key !== "string" || !allowed.includes(key))
      throw fail(
        "包含未支持字段: " + (typeof key === "string" ? key : "Symbol"),
      );
    if (
      !field.enumerable ||
      (!opaque.includes(key) && !Object.hasOwn(field, "value"))
    )
      throw fail("不能包含隐藏字段或访问器");
  }
  return fields;
}
function value(fields, key) {
  const field = fields[key];
  if (!field) return undefined;
  if (!Object.hasOwn(field, "value")) throw fail("不能包含访问器");
  return field.value;
}
function array(input) {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  )
    throw fail("列表须为普通数组");
  if (input.length > LIMIT) throw fail("列表最多100000项");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== input.length + 1)
    throw fail("列表不能包含额外属性");
  const output = [];
  for (let i = 0; i < input.length; i++) {
    const field = fields[i];
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw fail("列表不能包含空洞或访问器");
    output.push(field.value);
  }
  return output;
}
function metadata(fields) {
  for (const key of ["id", "name", "type"])
    if (fields[key] && typeof value(fields, key) !== "string")
      throw fail(key + "必须为文本");
  if (!fields.description) return;
  const description = value(fields, "description");
  if (description === null || typeof description === "string") return;
  const detail = record(description, ["content", "type", "version"]);
  for (const key of ["content", "type"])
    if (detail[key] && typeof value(detail, key) !== "string")
      throw fail("description." + key + "必须为文本");
  // Version is inert descriptive metadata; it is not evaluated or copied.
}

// Only returns source text. Never compile scripts, resolve references or fetch src.
// The output is canonical active code, not a lossless Postman source archive.
export function postmanEventScripts(input) {
  const output = { prerequest: [], test: [] };
  if (input === undefined) return output;
  const lengths = { prerequest: 0, test: 0 };
  for (const event of array(input)) {
    const fields = record(
      event,
      ["listen", "disabled", "script", "id", "name", "description"],
      ["script"],
    );
    const listen = value(fields, "listen");
    if (!["prerequest", "test"].includes(listen))
      throw fail("listen仅支持prerequest或test");
    if (fields.disabled && typeof value(fields, "disabled") !== "boolean")
      throw fail("disabled必须为布尔值");
    metadata(fields);
    if (value(fields, "disabled") === true) continue;
    if (!fields.script) continue;
    const script = record(value(fields, "script"), [
      "exec",
      "src",
      "disabled",
      "type",
      "id",
      "name",
      "description",
    ]);
    if (script.disabled)
      throw fail("不支持script.disabled，请使用event.disabled");
    if (script.src) throw fail("不支持src引用，不读取文件或URL，也不回退exec");
    metadata(script);
    if (!script.exec) continue;
    const exec = value(script, "exec");
    const lines = typeof exec === "string" ? (exec ? [exec] : []) : array(exec);
    for (const line of lines) {
      if (typeof line !== "string") throw fail("exec仅支持文本或文本数组");
      lengths[listen] += line.length + (output[listen].length ? 1 : 0);
      if (lengths[listen] > LIMIT) throw fail("阶段源码合计最多100000字符");
      output[listen].push(line);
    }
  }
  return output;
}
