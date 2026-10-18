// Deterministic illustrative samples, not a general JSON Schema solver.
export function sampleFromSchema(
  schema,
  depth = 0,
  root = schema,
  options = {},
) {
  const budget = { nodes: 0 };
  function sample(schema, level, seen, fieldName = "") {
    if (++budget.nodes > 10000 || level > 12)
      throw Error("Schema 生成超过节点/深度上限");
    if (schema === false) throw Error("Schema 禁止任何值");
    if (schema === true) return null;
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw Error("Schema 必须为对象");
    if (schema.const !== undefined) return structuredClone(schema.const);
    if (schema.example !== undefined) return structuredClone(schema.example);
    if (schema.default !== undefined) return structuredClone(schema.default);
    if (schema.enum?.length) return structuredClone(schema.enum[0]);
    if (schema.$ref) {
      const ref = schema.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#/"))
        throw Error("不支持外部 Schema 引用，请提供 example");
      if (seen.has(ref)) throw Error("递归 Schema 请提供有限 example");
      let target = root;
      for (const part of ref
        .slice(2)
        .split("/")
        .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))) {
        if (
          ["__proto__", "prototype", "constructor"].includes(part) ||
          !target ||
          !Object.hasOwn(target, part)
        )
          throw Error("Schema 引用不存在");
        target = target[part];
      }
      const overrides = { ...schema };
      delete overrides.$ref;
      const next =
        target === false
          ? false
          : { ...(target === true ? {} : target), ...overrides };
      return sample(next, level + 1, new Set([...seen, ref]), fieldName);
    }
    for (const key of [
      "allOf",
      "not",
      "if",
      "contains",
      "patternProperties",
      "dependentSchemas",
      "dependentRequired",
      "minProperties",
      "maxProperties",
    ])
      if (schema[key] !== undefined)
        throw Error("复杂约束 " + key + " 请提供 example");
    const mocked = options.valueForField?.(fieldName, schema);
    if (mocked !== undefined) return structuredClone(mocked);
    if (schema.oneOf?.length || schema.anyOf?.length)
      return sample(
        (schema.oneOf || schema.anyOf)[0],
        level + 1,
        seen,
        fieldName,
      );
    const type = Array.isArray(schema.type)
      ? schema.type.find((x) => x !== "null") || "null"
      : schema.type;
    if (
      type !== undefined &&
      ![
        "object",
        "array",
        "integer",
        "number",
        "boolean",
        "null",
        "string",
      ].includes(type)
    )
      throw Error("未知 Schema 类型");
    if (type === "object" || schema.properties) {
      const properties = schema.properties || {};
      if (typeof properties !== "object" || Array.isArray(properties))
        throw Error("properties 必须是对象");
      if (schema.required !== undefined && !Array.isArray(schema.required))
        throw Error("required 必须是数组");
      const entries = Object.entries(properties).map(([key, value]) => [
        key,
        sample(value, level + 1, seen, key),
      ]);
      for (const name of schema.required || []) {
        if (typeof name !== "string") throw Error("required 字段名无效");
        if (!Object.hasOwn(properties, name)) {
          if (schema.additionalProperties === false)
            throw Error("required 与 additionalProperties 约束冲突");
          entries.push([
            name,
            sample(
              typeof schema.additionalProperties === "object"
                ? schema.additionalProperties
                : {},
              level + 1,
              seen,
              name,
            ),
          ]);
        }
      }
      return Object.fromEntries(entries);
    }
    if (type === "array") {
      const min = schema.minItems ?? 0,
        max = schema.maxItems ?? Math.max(min, 100);
      if (
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min < 0 ||
        max < min
      )
        throw Error("数组约束无效");
      const count = Math.max(min, Math.min(1, max));
      if (count > 100) throw Error("数组样例上限100项，请提供 example");
      if (schema.uniqueItems && count > 1) {
        const values = schema.items?.enum;
        if (!Array.isArray(values))
          throw Error("uniqueItems 请提供枚举或 example");
        const unique = [
          ...new Map(
            values.map((value) => [JSON.stringify(value), value]),
          ).values(),
        ];
        if (unique.length < count) throw Error("唯一数组约束无法满足");
        return structuredClone(unique.slice(0, count));
      }
      if (Array.isArray(schema.items) || schema.prefixItems)
        throw Error("元组 Schema 请提供 example");
      return Array.from({ length: count }, () =>
        sample(schema.items ?? {}, level + 1, seen, fieldName),
      );
    }
    if (type === "integer" || type === "number")
      return numberSample(schema, type);
    if (type === "boolean") return false;
    if (type === "null") return null;
    if (schema.pattern) throw Error("pattern 约束请提供 example");
    const min = schema.minLength ?? 0,
      max = schema.maxLength ?? 10000;
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < min
    )
      throw Error("字符串长度约束无效");
    if (min > 10000) throw Error("字符串样例上限10000字符");
    const formatted = {
      email: "user@example.test",
      date: "2026-01-01",
      "date-time": "2026-01-01T00:00:00Z",
      uuid: "00000000-0000-4000-8000-000000000000",
      uri: "https://example.test",
      hostname: "example.test",
      ipv4: "127.0.0.1",
    }[schema.format];
    if (schema.format && formatted === undefined)
      throw Error("未知 format 请提供 example");
    const value = formatted ?? "x".repeat(min);
    if (value.length < min || value.length > max)
      throw Error("格式与长度约束需要自定义 example");
    return value;
  }
  const value = sample(schema, depth, new Set());
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    throw Error("生成样例超过1 MiB上限");
  return value;
}
function numberSample(schema, type) {
  for (const key of ["minimum", "maximum", "multipleOf"])
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    )
      throw Error("数值约束无效");
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"])
    if (
      schema[key] !== undefined &&
      typeof schema[key] !== "boolean" &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    )
      throw Error("数值约束无效");
  const low = Math.max(
    schema.minimum ?? -Infinity,
    typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum
      : -Infinity,
  );
  const high = Math.min(
    schema.maximum ?? Infinity,
    typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum
      : Infinity,
  );
  const lowExclusive =
    schema.exclusiveMinimum === true ||
    (typeof schema.exclusiveMinimum === "number" &&
      schema.exclusiveMinimum === low);
  const highExclusive =
    schema.exclusiveMaximum === true ||
    (typeof schema.exclusiveMaximum === "number" &&
      schema.exclusiveMaximum === high);
  if (low > high || (low === high && (lowExclusive || highExclusive)))
    throw Error("数值约束无解");
  let value = Math.max(low, Math.min(0, high));
  if (type === "integer") {
    value = Math.ceil(value);
    if (value === low && lowExclusive) value++;
    if (value > high || (value === high && highExclusive))
      value =
        Math.floor(high) - (highExclusive && Number.isInteger(high) ? 1 : 0);
  } else {
    if (value === low && lowExclusive)
      value = Number.isFinite(high)
        ? low + (high - low) / 2
        : low + Math.max(1, Math.abs(low)) * 0.01;
    if (value === high && highExclusive)
      value = Number.isFinite(low)
        ? low + (high - low) / 2
        : high - Math.max(1, Math.abs(high)) * 0.01;
  }
  if (schema.multipleOf !== undefined) {
    const multiple = schema.multipleOf;
    if (multiple <= 0) throw Error("multipleOf 约束必须为正数");
    let factor = Number.isFinite(low)
      ? Math.ceil(low / multiple)
      : Number.isFinite(high)
        ? Math.min(0, Math.floor(high / multiple))
        : 0;
    if (factor * multiple === low && lowExclusive) factor++;
    if (!Number.isFinite(low) && factor * multiple === high && highExclusive)
      factor--;
    value = Number((factor * multiple).toPrecision(15));
  }
  if (
    !Number.isFinite(value) ||
    value < low ||
    value > high ||
    (lowExclusive && value <= low) ||
    (highExclusive && value >= high) ||
    (type === "integer" && !Number.isSafeInteger(value))
  )
    throw Error("无法生成满足数值约束的安全样例，请提供 example");
  return value;
}
