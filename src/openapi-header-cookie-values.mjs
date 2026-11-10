import { importOpenAPIScalarValue } from "./openapi-scalar-values.mjs";

const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const objectKeywords = [
  "properties",
  "patternProperties",
  "additionalProperties",
  "required",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
];

function objectContract(schema) {
  const pending = [schema],
    seen = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!object(item) || seen.has(item)) continue;
    seen.add(item);
    const types = Array.isArray(item.type) ? item.type : [item.type];
    if (types.includes("object")) return true;
    // These keywords can also accept non-object instances. Without an explicit
    // non-object type the wire contract is ambiguous, not necessarily invalid.
    if (!own(item, "type") && objectKeywords.some((key) => own(item, key)))
      return true;
    if (!own(item, "type") || types.includes("array")) {
      if (own(item, "const") && objectValue(item.const)) return true;
      if (Array.isArray(item.enum) && item.enum.some(objectValue)) return true;
    }
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (Array.isArray(item[key]))
        for (const child of item[key]) pending.push(child);
    // Follow positive conditional results, not the if predicate itself.
    if (own(item, "if"))
      for (const key of ["then", "else"]) pending.push(item[key]);
    if (!own(item, "type") || types.includes("array")) {
      if (Array.isArray(item.items))
        for (const child of item.items) pending.push(child);
      else pending.push(item.items);
      if (Array.isArray(item.prefixItems))
        for (const child of item.prefixItems) pending.push(child);
      for (const key of ["contains", "additionalItems", "unevaluatedItems"])
        pending.push(item[key]);
    }
  }
  return false;
}

function objectValue(value) {
  const pending = [value],
    seen = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (object(item)) return true;
    if (!Array.isArray(item) || seen.has(item)) continue;
    seen.add(item);
    for (const child of item) pending.push(child);
  }
  return false;
}

function selectedCandidates(parameter, legacyValue) {
  if (own(parameter, "example")) return [parameter.example];
  if (own(parameter, "examples"))
    return object(parameter.examples)
      ? Object.values(parameter.examples)
          .filter((example) => object(example) && own(example, "value"))
          .map((example) => example.value)
      : [];
  if (object(parameter.schema))
    for (const key of ["default", "example"])
      if (own(parameter.schema, key)) return [parameter.schema[key]];
  return [legacyValue];
}

// OAS3 import admission only. Do not infer serialization from existing rows,
// flatten objects into strings, or change the generic scalar/array contracts.
export function importOpenAPIHeaderCookieValue(parameter, legacyValue = "") {
  const fail = (detail) => {
    throw Error(
      `OpenAPI ${parameter.in === "header" ? "Header" : "Cookie"} ${detail}；不能按普通文本导入`,
    );
  };
  if (own(parameter, "content")) fail("content参数序列化尚不支持");
  if (objectContract(parameter.schema)) fail("对象参数序列化尚不支持或不明确");
  // Keep the established scalar validation and its error contract first.
  // Only unsupported compound paths delegate to the fallback checked below.
  const value = importOpenAPIScalarValue(parameter, legacyValue);
  if (selectedCandidates(parameter, legacyValue).some(objectValue))
    fail("对象或含对象的复合参数值尚不支持");
  // Compound schemas delegate to legacy fallbacks before normal selection.
  // In particular, a Cookie fallback can be an object-valued schema default.
  if (objectValue(value)) fail("对象或含对象的复合参数值尚不支持");
  return value;
}
