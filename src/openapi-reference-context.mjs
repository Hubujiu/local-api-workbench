import { schemaChildMode } from "../public/schema-positions.js";
const referenceModes = new Set([
  "generic",
  "schema",
  "pathItem",
  "parameter",
  "requestBody",
  "response",
  "example",
  "callback",
  "link",
  "securityScheme",
]);
export const referenceModeIsAllowed = (mode) => referenceModes.has(mode);
const fields = {
  document: {
    components: "components",
    paths: "paths",
    webhooks: "map:pathItem",
    definitions: "map:schema",
    parameters: "map:parameter",
    responses: "map:response",
    securityDefinitions: "map:securityScheme",
  },
  components: {
    schemas: "map:schema",
    parameters: "map:parameter",
    headers: "map:parameter",
    requestBodies: "map:requestBody",
    responses: "map:response",
    examples: "map:example",
    callbacks: "map:callback",
    links: "map:link",
    securitySchemes: "map:securityScheme",
    pathItems: "map:pathItem",
  },
  operation: {
    parameters: "list:parameter",
    requestBody: "requestBody",
    responses: "map:response",
    callbacks: "map:callback",
  },
  parameter: {
    schema: "schema",
    items: "schema",
    content: "map:media",
    examples: "map:example",
  },
  requestBody: { content: "map:media" },
  response: {
    schema: "schema",
    content: "map:media",
    headers: "map:parameter",
    links: "map:link",
  },
  media: {
    schema: "schema",
    examples: "map:example",
    encoding: "map:encoding",
  },
  encoding: { headers: "map:parameter" },
};
const methods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
export function referenceChildMode(mode, key, value, swagger = false) {
  if (mode === "generic") return "generic";
  if (mode === "map:dependency")
    return Array.isArray(value) ? "literal" : "schema";
  // Paths Object extensions are literal data, not reusable Path Item entries.
  if (mode === "paths") return key.startsWith("/") ? "pathItem" : "literal";
  if (mode.startsWith("map:") || mode.startsWith("list:"))
    return mode.slice(mode.indexOf(":") + 1);
  if (key.startsWith("x-")) return "literal";
  if (mode === "schema") {
    const child = schemaChildMode(key, value);
    return child === "map"
      ? "map:schema"
      : child === "list"
        ? "list:schema"
        : child === "dependencies"
          ? "map:dependency"
          : child;
  }
  if (mode === "pathItem")
    return key === "parameters"
      ? "list:parameter"
      : methods.has(key)
        ? "operation"
        : "literal";
  if (mode === "callback") return "pathItem";
  if (swagger && mode === "parameter" && key === "examples") return "literal";
  const known = fields[mode];
  return known && Object.hasOwn(known, key) ? known[key] : "literal";
}
