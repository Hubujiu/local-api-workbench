// Call after local-reference resolution, before creating or synchronizing rows.
// TRACE is a legal OAS 3 Path Item operation, but is not a runtime method here.
// Do not silently admit only the other operations from a mixed document.
export function supportedOpenAPIPathItems(document) {
  const paths = Object.entries(document.paths || {}).filter(([path]) =>
    path.startsWith("/"),
  );
  for (const [, item] of paths)
    if (item && typeof item === "object" && Object.hasOwn(item, "trace"))
      throw Error("OpenAPI TRACE 操作尚不支持；整个导入已拒绝");
  return paths;
}
