// Known JSON Schema child positions; annotations and unknown extensions are literal data.
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set([
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
export function schemaChildMode(key, value) {
  return schemaMaps.has(key)
    ? "map"
    : schemaLists.has(key)
      ? "list"
      : key === "dependencies"
        ? "dependencies"
        : key === "items"
          ? Array.isArray(value)
            ? "list"
            : "schema"
          : schemaValues.has(key)
            ? "schema"
            : "literal";
}
