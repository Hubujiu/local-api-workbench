// Definition-only migration. This module never constructs runtime credentials.
import { isDeepStrictEqual } from "node:util";
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const methods = ["get", "put", "post", "delete", "options", "head", "patch"];
const flows = {
  implicit: "implicit",
  password: "password",
  application: "clientCredentials",
  accessCode: "authorizationCode",
};

function fail(message) {
  throw Error("Swagger 2 security: " + message);
}
function record(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(label + " must be an object");
  return value;
}
function text(value, label, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0))
    fail(label + " must be a string" + (empty ? "" : " (nonempty)"));
  return value;
}
function safeName(name, label) {
  if (unsafe.has(name) || !/^[a-zA-Z0-9._-]+$/.test(name))
    fail(label + " is not a supported OpenAPI component name: " + name);
}
function url(value, label) {
  text(value, label);
  if (/\s|[\u0000-\u001f\u007f]/u.test(value))
    fail(label + " must be a URL reference");
  try {
    // Relative OAuth URL references remain relative; no resolution or fetch.
    new URL(value, "https://swagger.invalid/");
  } catch {
    fail(label + " must be a URL reference");
  }
  return value;
}
function extension(value) {
  let nodes = 0;
  function visit(item, depth = 0) {
    if (++nodes > 50000 || depth > 50) fail("extension JSON exceeds limits");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    record(item, "extension JSON");
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
  visit(value);
  return structuredClone(value);
}

function convertScheme(scheme, name) {
  record(scheme, "securityDefinitions." + name);
  if (Object.hasOwn(scheme, "$ref"))
    fail("unresolved security scheme reference: " + name);
  const type = scheme.type;
  const allowed = new Set(["type", "description"]);
  if (type === "apiKey") {
    allowed.add("name");
    allowed.add("in");
  } else if (type === "oauth2") {
    for (const key of ["flow", "authorizationUrl", "tokenUrl", "scopes"])
      allowed.add(key);
  } else if (type !== "basic")
    fail("unsupported security scheme type: " + name);
  const metadata = {};
  for (const [key, value] of Object.entries(scheme)) {
    if (key === "description")
      metadata.description = text(value, name + ".description", {
        empty: true,
      });
    else if (key.startsWith("x-")) metadata[key] = extension(value);
    else if (!allowed.has(key))
      fail("unsupported security scheme field: " + name + "." + key);
  }
  if (type === "basic") return { type: "http", scheme: "basic", ...metadata };
  if (type === "apiKey") {
    if (!["header", "query"].includes(scheme.in))
      fail("apiKey in must be header or query: " + name);
    text(scheme.name, name + ".name");
    if (/[\u0000-\u001f\u007f]/u.test(scheme.name))
      fail("invalid apiKey name: " + name);
    if (
      scheme.in === "header" &&
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(scheme.name)
    )
      fail("invalid apiKey header name: " + name);
    return { type: "apiKey", name: scheme.name, in: scheme.in, ...metadata };
  }
  if (typeof scheme.flow !== "string" || !Object.hasOwn(flows, scheme.flow))
    fail("unsupported OAuth2 flow: " + name);
  const scopes = record(scheme.scopes, name + ".scopes");
  for (const [scope, description] of Object.entries(scopes)) {
    if (unsafe.has(scope) || !scope) fail("invalid OAuth2 scope: " + name);
    text(description, name + ".scopes." + scope, { empty: true });
  }
  const flow = {};
  if (["implicit", "accessCode"].includes(scheme.flow))
    flow.authorizationUrl = url(
      scheme.authorizationUrl,
      name + ".authorizationUrl",
    );
  else if (Object.hasOwn(scheme, "authorizationUrl"))
    fail("authorizationUrl is not applicable to this flow: " + name);
  if (scheme.flow !== "implicit")
    flow.tokenUrl = url(scheme.tokenUrl, name + ".tokenUrl");
  else if (Object.hasOwn(scheme, "tokenUrl"))
    fail("tokenUrl is not applicable to implicit flow: " + name);
  flow.scopes = structuredClone(scopes);
  return { type: "oauth2", flows: { [flows[scheme.flow]]: flow }, ...metadata };
}

function validateRequirements(requirements, source, label) {
  if (!Array.isArray(requirements)) fail(label + " must be an array");
  for (const requirement of requirements) {
    record(requirement, label + " requirement");
    for (const [name, scopes] of Object.entries(requirement)) {
      safeName(name, label + " scheme");
      if (!Object.hasOwn(source, name))
        fail(label + " references undefined source scheme: " + name);
      if (!Array.isArray(scopes))
        fail(label + " scope list must be an array: " + name);
      const scheme = source[name];
      if (scheme.type !== "oauth2" && scopes.length)
        fail(label + " non-OAuth2 scopes must be empty: " + name);
      for (const scope of scopes) {
        text(scope, label + " scope");
        if (!Object.hasOwn(scheme.scopes, scope))
          fail(
            label + " references undefined OAuth2 scope: " + name + "/" + scope,
          );
      }
    }
  }
}

/** Input must have passed the context-aware local-reference resolver. */
export function swagger2SecurityDefinitions(document) {
  if (!Object.hasOwn(document, "swagger")) return undefined;
  if (document.swagger !== "2.0") fail("only Swagger 2.0 is supported");
  const source = Object.hasOwn(document, "securityDefinitions")
    ? record(document.securityDefinitions, "securityDefinitions")
    : {};
  const converted = Object.fromEntries(
    Object.entries(source).map(([name, scheme]) => {
      safeName(name, "securityDefinitions scheme");
      return [name, convertScheme(scheme, name)];
    }),
  );
  for (const field of ["components", "openapiComponents"]) {
    if (!Object.hasOwn(document, field)) continue;
    const components = record(document[field], field);
    if (!Object.hasOwn(components, "securitySchemes")) continue;
    const registry = record(
      components.securitySchemes,
      field + ".securitySchemes",
    );
    // Swagger has one authoritative registry. A second registry may repeat its
    // converted definitions, but must not introduce unvalidated aliases or old
    // #/securityDefinitions pointers that become dangling in OpenAPI 3.
    for (const name of Object.keys(registry)) {
      if (!Object.hasOwn(converted, name))
        fail("hybrid securitySchemes introduces a non-source scheme: " + name);
    }
    for (const [name, scheme] of Object.entries(converted)) {
      if (
        Object.hasOwn(registry, name) &&
        !isDeepStrictEqual(registry[name], scheme)
      )
        fail("conflicting source component: " + name);
    }
  }
  if (Object.hasOwn(document, "security"))
    validateRequirements(document.security, source, "root security");
  for (const [path, item] of Object.entries(document.paths || {})) {
    if (path.startsWith("x-") || !item || typeof item !== "object") continue;
    for (const method of methods) {
      const operation = item[method];
      if (operation && Object.hasOwn(operation, "security"))
        validateRequirements(
          operation.security,
          source,
          method + " " + path + " security",
        );
    }
  }
  return converted;
}
