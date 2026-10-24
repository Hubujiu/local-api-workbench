import { intersectSampleSchemas } from "./schema-intersection.mjs";
import { isDeepStrictEqual } from "node:util";
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
      let ref = schema.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#"))
        throw Error("不支持外部 Schema 引用，请提供 example");
      try {
        ref = "#" + decodeURIComponent(ref.slice(1));
      } catch {
        throw Error("Schema 引用包含无效URI编码");
      }
      if (!ref.startsWith("#/"))
        throw Error("仅支持本地JSON Pointer Schema引用，请提供 example");
      if (/~(?:[^01]|$)/.test(ref))
        throw Error("Schema 引用包含无效JSON Pointer转义");
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
      if (
        typeof target !== "boolean" &&
        (!target || typeof target !== "object" || Array.isArray(target))
      )
        throw Error("Schema 引用目标不是Schema");
      const overrides = { ...schema };
      delete overrides.$ref;
      const next =
        target === false ? false : intersectSampleSchemas(target, overrides);
      return sample(next, level + 1, new Set([...seen, ref]), fieldName);
    }
    if (schema.allOf !== undefined) {
      if (
        !Array.isArray(schema.allOf) ||
        !schema.allOf.length ||
        schema.allOf.length > 16
      )
        throw Error("allOf需1至16个分支，请提供 example");
      const base = { ...schema };
      delete base.allOf;
      const combined = schema.allOf.reduce(
        (result, branch) => intersectSampleSchemas(result, branch),
        base,
      );
      return sample(combined, level + 1, seen, fieldName);
    }
    for (const key of [
      "not",
      "if",
      "contains",
      "patternProperties",
      "dependentSchemas",
      "dependentRequired",
      "unevaluatedItems",
      "unevaluatedProperties",
    ])
      if (schema[key] !== undefined)
        throw Error("复杂约束 " + key + " 请提供 example");
    const mocked = options.valueForField?.(fieldName, schema);
    if (mocked !== undefined) return structuredClone(mocked);
    if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
      if (schema.oneOf !== undefined && schema.anyOf !== undefined)
        throw Error("多个组合关键字请提供 example");
      const key = schema.oneOf !== undefined ? "oneOf" : "anyOf";
      const branches = schema[key];
      if (!Array.isArray(branches) || !branches.length || branches.length > 16)
        throw Error(key + "需1至16个分支，请提供 example");
      if (
        branches.some(
          (branch) =>
            typeof branch !== "boolean" &&
            (!branch || typeof branch !== "object" || Array.isArray(branch)),
        )
      )
        throw Error(key + "分支必须为Schema对象或布尔值");
      const base = { ...schema };
      delete base[key];
      const live = branches.filter((branch) => branch !== false);
      let partitions, tagged;
      if (key === "oneOf" && live.length > 1) {
        partitions = live.map((branch) => {
          const types = Array.isArray(branch?.type)
            ? branch.type
            : [branch?.type];
          const expanded = new Set();
          for (const type of types) {
            if (
              ![
                "string",
                "number",
                "integer",
                "boolean",
                "null",
                "object",
                "array",
              ].includes(type)
            )
              throw Error("oneOf分支需明确互斥类型，否则请提供 example");
            expanded.add(type);
            if (type === "number") expanded.add("integer");
          }
          if (!expanded.size) throw Error("oneOf分支类型为空");
          return expanded;
        });
        if (
          partitions.some((types, i) =>
            partitions
              .slice(i + 1)
              .some((other) => [...types].some((type) => other.has(type))),
          )
        ) {
          tagged = taggedObjectPartition(live, budget);
          if (!tagged) throw Error("oneOf分支类型不互斥，请提供 example");
          partitions = undefined;
        }
      }
      const failures = [];
      for (let i = 0; i < live.length; i++) {
        try {
          const merged = intersectSampleSchemas(base, live[i]);
          const value = sample(merged, level + 1, seen, fieldName);
          const type =
            value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : Number.isInteger(value)
                  ? "integer"
                  : typeof value;
          if (partitions && !partitions[i].has(type))
            throw Error("oneOf分支样例类型不匹配");
          if (
            tagged &&
            (type !== "object" ||
              !Object.hasOwn(value, tagged.key) ||
              !tagged.values[i].has(value[tagged.key]))
          )
            throw Error("oneOf分支样例标签不匹配");
          return value;
        } catch (error) {
          failures.push(String(error.message).slice(0, 160));
        }
      }
      throw Error(
        key +
          "无法生成支持范围内的样例，请提供 example：" +
          failures.join("；"),
      );
    }
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
      const min = schema.minProperties ?? 0,
        max = schema.maxProperties ?? 1000;
      for (const bound of [min, max])
        if (!Number.isSafeInteger(bound) || bound < 0 || bound > 1000)
          throw Error("对象属性数须为0至1000，请提供example处理更大对象");
      if (min > max) throw Error("对象属性数下限大于上限");
      const required = new Set(schema.required || []);
      if (required.size > max) throw Error("required超过最大属性数");
      for (const name of required) {
        if (typeof name !== "string") throw Error("required 字段名无效");
        if (
          !Object.hasOwn(properties, name) &&
          schema.additionalProperties === false
        )
          throw Error("required 与 additionalProperties 约束冲突");
      }
      const additional =
        typeof schema.additionalProperties === "object"
          ? schema.additionalProperties
          : {};
      const selected = new Map();
      let optionalSlots = max - required.size;
      for (const [name, value] of Object.entries(properties)) {
        if (required.has(name)) selected.set(name, value);
        else if (value !== false && optionalSlots > 0) {
          selected.set(name, value);
          optionalSlots--;
        }
      }
      for (const name of required)
        if (!selected.has(name)) selected.set(name, additional);
      if (selected.size < min && schema.additionalProperties === false)
        throw Error("可用属性不足minProperties且禁止额外属性");
      let suffix = 1;
      while (selected.size < min) {
        const name = "additionalProperty" + suffix++;
        if (!selected.has(name) && !Object.hasOwn(properties, name))
          selected.set(name, additional);
      }
      const entries = [...selected].map(([key, value]) => [
        key,
        sample(value, level + 1, seen, key),
      ]);
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
      const legacyTuple = Array.isArray(schema.items);
      if (
        schema.prefixItems !== undefined &&
        (!Array.isArray(schema.prefixItems) || legacyTuple)
      )
        throw Error("元组结构无效或混用新旧关键字");
      const prefix = schema.prefixItems ?? (legacyTuple ? schema.items : null);
      const tail = legacyTuple
        ? (schema.additionalItems ?? {})
        : (schema.items ?? {});
      // A false slot forbids this and all later positions, not the shorter prefix.
      const forbidden = prefix?.indexOf(false) ?? -1;
      const allowed =
        forbidden >= 0
          ? forbidden
          : tail === false
            ? (prefix?.length ?? 0)
            : max;
      const limit = Math.min(max, allowed);
      if (min > limit) throw Error("数组长度与禁止项约束冲突");
      const count = Math.max(min, Math.min(prefix?.length ?? 1, limit));
      if (count > 100) throw Error("数组样例上限100项，请提供 example");
      if (prefix) {
        const values = Array.from({ length: count }, (_, index) =>
          sample(
            index < prefix.length ? prefix[index] : tail,
            level + 1,
            seen,
            fieldName,
          ),
        );
        if (
          schema.uniqueItems &&
          values.some((value, index) =>
            values
              .slice(0, index)
              .some((previous) => isDeepStrictEqual(previous, value)),
          )
        )
          throw Error("唯一元组无法生成不同样例，请提供 example");
        return values;
      }
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

function taggedObjectPartition(branches, budget) {
  if (
    branches.some(
      (branch) =>
        branch?.type !== "object" ||
        !Array.isArray(branch.required) ||
        branch.required.length > 1000 ||
        !branch.properties ||
        typeof branch.properties !== "object" ||
        Array.isArray(branch.properties),
    )
  )
    return null;
  const charge = (amount) => {
    budget.nodes += amount;
    if (budget.nodes > 10000) throw Error("Schema 生成超过节点/深度上限");
  };
  const annotations = new Set([
    "title",
    "description",
    "default",
    "example",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "$comment",
  ]);
  const candidates = [...new Set(branches[0].required)].slice(0, 32);
  for (const key of candidates) {
    charge(1);
    if (
      typeof key !== "string" ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      continue;
    const sets = [];
    for (const branch of branches) {
      charge(branch.required.length + 1);
      if (
        !branch.required.includes(key) ||
        !Object.hasOwn(branch.properties, key)
      )
        break;
      const field = branch.properties[key];
      if (
        !field ||
        typeof field !== "object" ||
        Array.isArray(field) ||
        (field.type !== undefined && field.type !== "string")
      )
        break;
      const fieldKeys = Object.keys(field);
      charge(fieldKeys.length);
      if (
        fieldKeys.some(
          (name) =>
            !["type", "const", "enum"].includes(name) &&
            !annotations.has(name) &&
            !name.startsWith("x-"),
        )
      )
        break;
      const hasConst = Object.hasOwn(field, "const"),
        hasEnum = Object.hasOwn(field, "enum");
      if (!hasConst && !hasEnum) break;
      if (
        hasEnum &&
        (!Array.isArray(field.enum) ||
          !field.enum.length ||
          field.enum.length > 100)
      )
        break;
      const enumValues = hasEnum ? Array.from(field.enum) : [];
      const values = hasConst ? [field.const] : enumValues;
      charge(values.length + (hasEnum ? field.enum.length : 0));
      if (
        values.some(
          (value) => typeof value !== "string" || value.length > 1024,
        ) ||
        (hasEnum &&
          enumValues.some(
            (value) => typeof value !== "string" || value.length > 1024,
          ))
      )
        break;
      if (hasEnum && new Set(enumValues).size !== enumValues.length) break;
      if (hasConst && hasEnum && !field.enum.includes(field.const)) break;
      sets.push(new Set(values));
    }
    if (sets.length !== branches.length) continue;
    if (
      !sets.some((values, i) =>
        sets
          .slice(i + 1)
          .some((other) => [...values].some((value) => other.has(value))),
      )
    )
      return { key, values: sets };
  }
  return null;
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
