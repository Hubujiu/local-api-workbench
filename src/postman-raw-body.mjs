import { types } from "node:util";
import { scriptStages } from "../public/shared-scripts.js";
const invalid = () => Error("Postman raw正文媒体配置不在受支持的子集内");
const media = Object.freeze({
  default: "text/plain",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  json: "application/json",
});
function data(value) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields))
    if (
      typeof key !== "string" ||
      !fields[key].enumerable ||
      !Object.hasOwn(fields[key], "value")
    )
      throw invalid();
  return fields;
}
export function postmanRawLanguage(value) {
  if (value === undefined || value === "") return "default";
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > 1024 ||
    /[{}]/.test(value)
  )
    throw invalid();
  return Object.hasOwn(media, value) && value !== "default" ? value : "text";
}
export function postmanRawBodyPolicy(request) {
  if (!request || typeof request !== "object" || types.isProxy(request))
    throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(request, "postmanRawBody");
  if (!descriptor) {
    if ("postmanRawBody" in request) throw invalid();
    return undefined;
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
    throw invalid();
  const fields = data(descriptor.value);
  if (
    Object.keys(fields).length !== 2 ||
    fields.version?.value !== 1 ||
    !fields.language ||
    typeof fields.language.value !== "string" ||
    !Object.hasOwn(media, fields.language.value)
  )
    throw invalid();
  return { version: 1, language: fields.language.value };
}
export function importPostmanRawBody(body) {
  const fields = data(body),
    options = fields.options ? data(fields.options.value) : {};
  const raw = options.raw ? data(options.raw.value) : {};
  if (raw.language?.value === "json")
    return { bodyType: "json", body: body.raw || "" };
  if (
    Object.keys(options).some((k) => k !== "raw") ||
    Object.keys(raw).some((k) => k !== "language")
  )
    throw invalid();
  const language = postmanRawLanguage(raw.language?.value);
  const text = fields.raw?.value ?? "";
  if (
    typeof text !== "string" ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > 8 * 1024 * 1024
  )
    throw invalid();
  return {
    bodyType: "raw",
    body: text,
    postmanRawBody: { version: 1, language },
  };
}
export function assertPostmanRawProfiles(profiles) {
  for (const profile of profiles)
    if (profile !== undefined && Object.keys(data(profile)).length)
      throw invalid();
}
export function validatePostmanRawBodyRequest(request) {
  const policy = postmanRawBodyPolicy(request);
  if (!policy) return;
  if (
    ["GET", "HEAD"].includes(String(request.method).toUpperCase()) &&
    (request.body ||
      ["form-data", "urlencoded", "binary", "msgpack"].includes(
        request.bodyType,
      ))
  )
    throw Error("Postman raw媒体子集不发送GET/HEAD正文");
  if (
    request.bodyType === "json" &&
    (typeof request.body !== "string" || !request.body.trim())
  )
    throw invalid();
  if (request.bodyType === "json") {
    try {
      JSON.parse(request.body);
    } catch {
      throw invalid();
    }
  }
  // Reject the entire ambiguous absent-language/header subset; do not emulate JSONC.
  if (
    policy.language === "default" &&
    request.bodyType === "raw" &&
    (request.headers || []).some(
      (h) => String(h.key).toLowerCase() === "content-type",
    )
  )
    throw invalid();
}
export function applyPostmanRawMedia(request, headers, body = request.body) {
  const policy = postmanRawBodyPolicy(request);
  if (!policy) return;
  validatePostmanRawBodyRequest(request);
  if (body && ["GET", "HEAD"].includes(String(request.method).toUpperCase()))
    throw Error("Postman raw媒体子集不发送GET/HEAD正文");
  if (request.bodyType !== "raw" || !body) return;
  if (!Object.hasOwn(headers, "content-type"))
    headers["content-type"] = media[policy.language];
}
export function postmanRawExportDefinition(request, { openapi = false } = {}) {
  if (!postmanRawBodyPolicy(request)) return request;
  if (
    scriptStages(request, "before").length ||
    request.before?.length ||
    Object.keys(request.bodyDynamic || {}).length ||
    /\{\{/.test(request.body || "")
  )
    throw Error("Postman raw媒体动态正文请使用项目备份，不预测脚本输出");
  const headers = {};
  for (const row of request.headers || [])
    if (
      row.enabled !== false &&
      String(row.key).toLowerCase() === "content-type"
    ) {
      if (Object.hasOwn(headers, "content-type")) throw invalid();
      if (typeof row.value !== "string" || /\{\{/.test(row.value))
        throw invalid();
      headers["content-type"] = row.value;
    }
  applyPostmanRawMedia(request, headers);
  if (
    openapi &&
    request.bodyType === "raw" &&
    (!request.body || headers["content-type"] === "")
  )
    throw Error("OpenAPI不能无损表达空raw正文或显式空媒体头，请使用项目备份");
  if (
    Object.hasOwn(headers, "content-type") &&
    !(request.headers || []).some(
      (h) =>
        h.enabled !== false && String(h.key).toLowerCase() === "content-type",
    )
  )
    return {
      ...request,
      headers: [
        ...(request.headers || []),
        { key: "Content-Type", value: headers["content-type"], enabled: true },
      ],
    };
  return request;
}
