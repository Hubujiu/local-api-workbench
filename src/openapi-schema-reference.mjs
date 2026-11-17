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

export function schemaReferenceWithSiblings(target, siblings) {
  if (
    Object.keys(siblings).every(
      (key) => annotations.has(key) || key.startsWith("x-"),
    )
  )
    return { ...target, ...siblings };
  if (
    Object.hasOwn(siblings, "allOf") &&
    (!Array.isArray(siblings.allOf) || !siblings.allOf.length)
  )
    throw Error("OpenAPI Schema allOf 必须是非空数组");
  // Keep siblings adjacent to allOf: unevaluatedProperties must see the
  // reference's evaluated properties, while additionalProperties stays local.
  return { ...siblings, allOf: [target, ...(siblings.allOf || [])] };
}
