import { isDeepStrictEqual } from "node:util";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { normalizeRequest } from "./core.mjs";
import { projectHistoryProjection } from "./request-definition-history.mjs";

export const POSTMAN_DEFINITION_FORMAT = "postman-collection-v2.1";
const fail = () => {
  throw Error("Postman Collection 定义包含本出口不能保真的配置");
};
const empty = (v) =>
  v === undefined ||
  (Array.isArray(v)
    ? v.length === 0
    : v && typeof v === "object"
      ? Object.keys(v).length === 0
      : v === "");
const text = (v, max = 65536) => {
  if (
    typeof v !== "string" ||
    !v.isWellFormed() ||
    Buffer.byteLength(v) > max ||
    /[\0]/.test(v)
  )
    fail();
  return v;
};
function requestItem(source) {
  const defaults = normalizeRequest({ id: source.id });
  const represented = new Set([
    "id",
    "name",
    "description",
    "folder",
    "method",
    "url",
    "headers",
    "bodyType",
    "body",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (represented.has(key)) continue;
    if (
      key === "postmanRawBody" &&
      source.bodyType === "raw" &&
      isDeepStrictEqual(value, { version: 1, language: "text" })
    )
      continue;
    if (
      [
        "inheritAuth",
        "inheritGlobalParameters",
        "inheritSharedScripts",
      ].includes(key) &&
      typeof value === "boolean"
    )
      continue;
    // These local identities have no behavior and are not exported.
    if (["createdAt", "updatedAt"].includes(key)) {
      text(value);
      continue;
    }
    if (
      !Object.hasOwn(defaults, key) ||
      !isDeepStrictEqual(value, defaults[key])
    )
      fail();
  }
  const method = text(source.method, 32);
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) fail();
  const url = text(source.url, 1024 * 1024);
  if (/[\s\\\x00-\x1f\x7f]|%(?![0-9a-fA-F]{2})/.test(url)) fail();
  const placeholders = /\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g;
  // Importing a literal :name path segment converts it into a path variable.
  // URL templates are deliberately outside this slice: their resolved shape
  // cannot be validated without evaluating user configuration.
  if (/[{}]/.test(url)) fail();
  const rawPath = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url)?.[1];
  if (
    rawPath === undefined ||
    rawPath.split("/").some((segment) => segment.startsWith(":"))
  )
    fail();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    fail();
  const headers = [];
  const names = new Set();
  for (const row of source.headers || []) {
    if (
      Object.keys(row).some(
        (k) => !["key", "value", "enabled", "description"].includes(k),
      )
    )
      fail();
    const key = text(row.key, 8192),
      value = text(row.value);
    if (/\{\{|\}\}/.test(value.replace(placeholders, "placeholder"))) fail();
    if (
      /[{}]/.test(key) ||
      (row.enabled !== undefined && typeof row.enabled !== "boolean")
    )
      fail();
    try {
      validateHeaderName(key);
      validateHeaderValue(key, value.replace(placeholders, "placeholder"));
    } catch {
      fail();
    }
    const name = key.toLowerCase();
    if (
      names.has(name) ||
      [
        "host",
        "content-length",
        "transfer-encoding",
        "trailer",
        "connection",
        "upgrade",
        "expect",
      ].includes(name)
    )
      fail();
    names.add(name);
    headers.push({
      key,
      value,
      ...(row.enabled === false ? { disabled: true } : {}),
      ...(row.description ? { description: text(row.description) } : {}),
    });
  }
  const request = {
    method,
    url,
    header: headers,
    auth: { type: "noauth" },
    ...(source.description ? { description: text(source.description) } : {}),
  };
  const body = text(source.body ?? "", 4 * 1024 * 1024);
  if (/\{\{|\}\}/.test(body.replace(placeholders, "placeholder"))) fail();
  if (source.bodyType === "raw") {
    if (["GET", "HEAD"].includes(method)) fail();
    // Explicit media is required: Postman otherwise synthesizes text/plain,
    // whereas a canonical raw request may intentionally omit Content-Type.
    if (
      !headers.some(
        (h) =>
          !h.disabled &&
          h.key.toLowerCase() === "content-type" &&
          h.value &&
          !/[{}]/.test(h.value),
      )
    )
      fail();
    request.body = {
      mode: "raw",
      raw: body,
      options: { raw: { language: "text" } },
    };
  } else if (source.bodyType !== "none" || body) fail();
  return {
    name: text(source.name, 8192),
    request,
  };
}

// This exporter never executes or resolves definitions. It is independent from
// cURL/code-example literal-body preparation and multipart export paths.
export function exportPostmanDefinition(project) {
  const p = projectHistoryProjection(project, {
    maxBytes: 32 * 1024 * 1024,
    maxDepth: 64,
    maxNodes: 200000,
  });
  const allowed = new Set([
    "id",
    "version",
    "name",
    "description",
    "createdAt",
    "updatedAt",
    "archived",
    "requests",
    "folders",
    "environments",
    "globalVariables",
    "settings",
    "documents",
    "cases",
    "caseFolders",
    "dictionary",
    "modelFolders",
    "protocols",
    "openapiComponents",
    "servers",
    "parameterDictionary",
  ]);
  for (const [key, value] of Object.entries(p)) {
    if (!allowed.has(key)) fail();
    if (
      [
        "settings",
        "documents",
        "cases",
        "caseFolders",
        "dictionary",
        "modelFolders",
        "protocols",
        "servers",
        "parameterDictionary",
      ].includes(key) &&
      !empty(value)
    )
      fail();
  }
  if (
    p.openapiComponents &&
    Object.values(p.openapiComponents).some((v) => !empty(v))
  )
    fail();
  const root = [],
    folders = new Map([["", root]]);
  for (const folder of p.folders || []) {
    text(folder, 8192);
    const parts = folder.split("/");
    if (parts.some((x) => !x || x === "." || x === "..")) fail();
    let prefix = "";
    for (const name of parts) {
      const parent = prefix;
      prefix = prefix ? prefix + "/" + name : name;
      if (!folders.has(prefix)) {
        const item = [];
        folders.get(parent).push({ name, item });
        folders.set(prefix, item);
      }
    }
  }
  const order = new Map();
  for (const [index, request] of (p.requests || []).entries()) {
    const parent = folders.get(request.folder || "");
    if (!parent) fail();
    const item = requestItem(request);
    order.set(item, index);
    parent.push(item);
  }
  const flattened = [];
  const visit = (items) => {
    for (const item of items) {
      if (item.item) visit(item.item);
      else flattened.push(order.get(item));
    }
  };
  visit(root);
  if (flattened.some((index, position) => index !== position)) fail();
  return {
    info: {
      name: text(p.name, 8192),
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      ...(p.description ? { description: text(p.description) } : {}),
    },
    item: root,
  };
}
