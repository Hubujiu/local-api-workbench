// Pure local inference. An example demonstrates types, not requiredness or limits.
export function inferSchemaFromJSON(source) {
  if (typeof source !== "string") throw Error("JSON样例必须为文本");
  if (new TextEncoder().encode(source).length > 65536)
    throw Error("JSON样例最多64KiB UTF-8");
  let example;
  try {
    example = JSON.parse(source);
  } catch {
    throw Error("JSON样例格式无效");
  }
  let nodes = 0;
  function infer(value, depth) {
    if (++nodes > 2000 || depth > 20)
      throw Error("JSON样例最多2000个节点、20层嵌套");
    if (value === null) return { type: "null" };
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        throw Error("JSON样例包含非有限数或不安全整数，请将精确大数改为字符串");
      return { type: Number.isInteger(value) ? "integer" : "number" };
    }
    if (typeof value === "string" || typeof value === "boolean")
      return { type: typeof value };
    if (Array.isArray(value)) {
      const variants = [],
        seen = new Set();
      for (const item of value) {
        const schema = infer(item, depth + 1),
          key = JSON.stringify(schema);
        if (!seen.has(key)) {
          seen.add(key);
          variants.push(schema);
        }
        if (variants.length > 16)
          throw Error("JSON数组最多16种不同结构，请先整理样例");
      }
      return {
        type: "array",
        items: variants.length > 1 ? { anyOf: variants } : variants[0] || {},
      };
    }
    const properties = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        infer(child, depth + 1),
      ]),
    );
    return { type: "object", properties };
  }
  return { ...infer(example, 0), example };
}
