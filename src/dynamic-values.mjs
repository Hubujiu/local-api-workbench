import { randomInt } from "node:crypto";
import { sampleProjectSchema } from "./mock-fields.mjs";
import { previewFunction } from "./custom-functions.mjs";
export async function resolveDynamicValue(spec, variables, functions = []) {
  if (!spec || !["fixed", "variable", "mock"].includes(spec.source))
    throw Error("动态值来源无效");
  const chain = spec.functions || [];
  if (
    !Array.isArray(chain) ||
    chain.length > 10 ||
    chain.some((name) => typeof name !== "string")
  )
    throw Error("动态值最多10个处理函数");
  let value;
  if (spec.source === "variable") {
    if (
      typeof spec.value !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(spec.value) ||
      !Object.hasOwn(variables, spec.value)
    )
      throw Error("动态值引用未定义变量");
    value = variables[spec.value];
  } else if (spec.source === "mock") {
    if (
      typeof spec.value !== "string" ||
      !["string", "number", "integer", "boolean", "object", "array"].includes(
        spec.type || "string",
      )
    )
      throw Error("Mock动态值类型或表达式无效");
    value = sampleProjectSchema(
      { settings: { mockSeed: spec.seed ?? randomInt(0, 4294967296) } },
      { type: spec.type || "string", mock: spec.value },
    );
  } else value = spec.value;
  const bounded = (value) => {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (
        ["undefined", "function", "symbol", "bigint"].includes(typeof item) ||
        (typeof item === "number" && !Number.isFinite(item))
      )
        throw Error("动态值必须是有限JSON值");
      return item;
    });
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > 65536
    )
      throw Error("动态值须为不超过64KiB的JSON值");
    return value;
  };
  bounded(value);
  for (const name of chain) {
    const fn = functions.find((item) => item.name === name);
    if (!fn) throw Error("动态值函数不存在: " + name);
    value = (await previewFunction(fn, value)).value;
  }
  return bounded(value);
}
export async function resolveDynamicRequest(
  request,
  variables,
  functions,
  interpolate,
) {
  const clone = structuredClone(request),
    specs = [];
  for (const group of ["query", "headers", "path", "cookies", "form"]) {
    for (const [index, row] of (clone[group] || []).entries()) {
      if (!row.dynamic) continue;
      if (row.enabled !== false) {
        if (row.type === "file") throw Error("文件参数不能配置动态文本值");
        specs.push({ group, index, spec: row.dynamic });
        row.value = "";
      }
      delete row.dynamic;
    }
  }
  const body = String(clone.body || "");
  const definitions = clone.bodyDynamic || {};
  const parts = body.split(/(\{\{@value:[A-Za-z0-9_-]{1,100}\}\})/g);
  const bodySpecs = [];
  for (const [index, part] of parts.entries()) {
    const match = /^\{\{@value:([A-Za-z0-9_-]{1,100})\}\}$/.exec(part);
    if (!match) continue;
    if (!Object.hasOwn(definitions, match[1]))
      throw Error("Body动态值定义不存在: " + match[1]);
    const spec = definitions[match[1]];
    if (!["json", "text"].includes(spec.format))
      throw Error("Body动态值输出格式无效");
    bodySpecs.push({ index, spec });
  }
  clone.body = "";
  delete clone.bodyDynamic;
  if (specs.length + bodySpecs.length > 100)
    throw Error("每个请求最多100个动态值");
  const transforms = [...specs, ...bodySpecs].reduce(
    (total, { spec }) =>
      total + (Array.isArray(spec.functions) ? spec.functions.length : 0),
    0,
  );
  if (transforms > 20) throw Error("每个请求最多20次动态函数处理");
  const deadline = Date.now() + 5000;
  const resolved = interpolate(clone, variables);
  for (const { group, index, spec } of specs) {
    if (Date.now() > deadline) throw Error("动态值处理超过5秒总预算");
    const value = await resolveDynamicValue(spec, variables, functions);
    if (Date.now() > deadline) throw Error("动态值处理超过5秒总预算");
    resolved[group][index].value =
      typeof value === "string" ? value : JSON.stringify(value);
  }
  for (const [index, part] of parts.entries()) {
    const dynamic = bodySpecs.find((item) => item.index === index);
    if (!dynamic) {
      parts[index] = interpolate(part, variables);
      continue;
    }
    if (Date.now() > deadline) throw Error("动态值处理超过5秒总预算");
    const value = await resolveDynamicValue(dynamic.spec, variables, functions);
    if (Date.now() > deadline) throw Error("动态值处理超过5秒总预算");
    parts[index] =
      dynamic.spec.format === "json" || typeof value !== "string"
        ? JSON.stringify(value)
        : value;
  }
  resolved.body = parts.join("");
  if (bodySpecs.length && resolved.body.length > 1024 * 1024)
    throw Error("动态Body超过1MiB");
  return resolved;
}
