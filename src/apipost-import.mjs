import { importExtendedApipostAuth } from "./apipost-auth-import.mjs";
import { importJwtConfig } from "../public/jwt-auth-model.js";
import { importApipostDocument } from "./apipost-documents.mjs";
import { randomUUID } from "node:crypto";
const truth = (value) => value === true || value === 1 || value === "1";
const checked = (value) => value === undefined || truth(value);
export function apipostDocument(document) {
  if (
    document?.openapi ||
    document?.swagger ||
    Array.isArray(document?.requests) ||
    Array.isArray(document?.item)
  )
    return null;
  if (document?.status === "success" && Array.isArray(document.data?.apis))
    return document.data;
  return Array.isArray(document?.apis) ? document : null;
}
function schema(value, depth = 0) {
  if (depth > 40) throw Error("Apipost结构层级过深");
  if (Array.isArray(value)) return value.map((item) => schema(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key === "ref" && typeof item === "string" && item.startsWith("#/")
        ? "$ref"
        : key,
      schema(item, depth + 1),
    ]),
  );
}
export function importApipostRows(value = []) {
  if (!Array.isArray(value) || value.length > 5000)
    throw Error("Apipost参数须为至多5000项的数组");
  return value.map((row) => {
    if (!row || typeof row.key !== "string") throw Error("Apipost参数名无效");
    const type = String(row.field_type || "string").toLowerCase();
    const types = {
      int: "integer",
      integer: "integer",
      float: "number",
      double: "number",
      number: "number",
      bool: "boolean",
      boolean: "boolean",
      array: "array",
      object: "object",
      string: "string",
    };
    return {
      key: row.key,
      value: Object.hasOwn(row, "value") ? structuredClone(row.value) : "",
      enabled: checked(row.is_checked),
      required: truth(row.not_null),
      description: String(row.description || ""),
      schema: { type: types[type] || "string" },
      ...(String(row.type).toLowerCase() === "file"
        ? {
            type: "file",
            requiresFile: true,
            filename: String(row.value || row.key)
              .split(/[\\/]/)
              .pop(),
            value: "",
          }
        : {}),
    };
  });
}
export function importApipostAuth(value = { type: "noauth" }) {
  if (!value || value.type === "noauth" || value.type === "none")
    return { type: "none" };
  if (value.type === "jwt") return importJwtConfig(value.jwt);
  if (value.type === "basic")
    return {
      type: "basic",
      username: String(value.basic?.username || ""),
      password: String(value.basic?.password || ""),
    };
  if (value.type === "bearer")
    return {
      type: "bearer",
      token: String(value.bearer?.key ?? value.bearer?.token ?? ""),
    };
  const extended = importExtendedApipostAuth(value);
  if (extended) return extended;
  throw Error(
    "Apipost认证格式尚未支持，请先转换为OpenAPI/Postman: " + value.type,
  );
}
const rows = importApipostRows;
const auth = importApipostAuth;
function inheritedParameters(request) {
  return (
    request &&
    (["header", "query", "body", "cookie", "cookies"].some(
      (key) => Array.isArray(request[key]) && request[key].length,
    ) ||
      (request.auth?.type && !["noauth", "none"].includes(request.auth.type)))
  );
}
export function importApipost(
  document,
  { preserveEmptyExamples = false, documentProjectId } = {},
) {
  const source = apipostDocument(document);
  if (!source) throw Error("不是支持的Apipost公共JSON格式");
  // Offline2 exports overlap with legacy `apis`, but carry different dependencies.
  // Reject even empty markers until the complete format has a verified migration.
  if (
    ["global", "models", "samples", "automated_testings"].some((key) =>
      Object.hasOwn(source, key),
    )
  )
    throw Error(
      "Apipost Offline2/现代JSON结构不完整或尚未验证，不能按旧版JSON导入；请提供完整导出文件并保留测试和全局配置",
    );
  if (
    (source.env !== undefined && !Array.isArray(source.env)) ||
    (source.dataModel !== undefined && !Array.isArray(source.dataModel))
  )
    throw Error("Apipost环境/模型格式无效");
  if (source.env?.length || source.dataModel?.length)
    throw Error(
      "此Apipost文件含环境或数据模型，请先使用OpenAPI导出；不会静默丢弃依赖",
    );
  if (inheritedParameters(source.project?.request))
    throw Error("Apipost全局参数继承尚未支持");
  const hasScript = (value, depth = 0) => {
    if (depth > 10) throw Error("Apipost脚本结构过深");
    if (typeof value === "string") return Boolean(value.trim());
    return value && typeof value === "object"
      ? Object.values(value).some((item) => hasScript(item, depth + 1))
      : false;
  };
  if (hasScript(source.project?.script))
    throw Error("Apipost全局脚本需要手工迁移");
  const entries = [],
    ids = new Map(),
    parent = new Map();
  const visit = (list, ancestor, depth) => {
    if (!Array.isArray(list) || depth > 30)
      throw Error("Apipost目录结构无效或过深");
    for (const node of list) {
      if (!node || !["folder", "api", "doc"].includes(node.target_type))
        throw Error("Apipost包含未支持的资源类型");
      if (entries.length >= 5000) throw Error("Apipost最多5000条资源");
      if (typeof node.name === "string" && node.name.length > 200)
        throw Error("Apipost资源名称过长");
      entries.push(node);
      parent.set(node, ancestor);
      const key = node.target_id ?? node.id;
      if (key !== undefined) {
        if (ids.has(String(key))) throw Error("Apipost资源ID重复");
        ids.set(String(key), node);
      }
      if (node.children) visit(node.children, node, depth + 1);
    }
  };
  visit(source.apis, null, 0);
  const location = (node, seen = new Set()) => {
    if (!node) return "";
    if (seen.has(node)) throw Error("Apipost目录引用成环");
    if (seen.size > 30) throw Error("Apipost目录引用过深");
    seen.add(node);
    let ancestor = parent.get(node);
    if (
      node.parent_id !== undefined &&
      !["", "0"].includes(String(node.parent_id))
    ) {
      ancestor = ids.get(String(node.parent_id));
      if (!ancestor || ancestor.target_type !== "folder")
        throw Error("Apipost目录引用不存在");
    }
    const prefix = location(ancestor, seen);
    return node.target_type === "folder"
      ? [prefix, String(node.name || "未命名目录")].filter(Boolean).join("/")
      : prefix;
  };
  // Path-based Workbench identity cannot represent two distinct source folders
  // at the same path. Reject before any project mutation, never silently merge.
  const folderPaths = new Set();
  for (const node of entries.filter(
    (entry) => entry.target_type === "folder",
  )) {
    const path = location(node);
    if (folderPaths.has(path))
      throw Error("Apipost不同来源目录映射到同一路径，不会合并目录");
    folderPaths.add(path);
  }
  const output = [],
    documents = [];
  for (const node of entries) {
    if (node.target_type === "doc") {
      documents.push(
        importApipostDocument(
          node,
          location(node),
          documentProjectId ?? source.project_id,
        ),
      );
      continue;
    }
    if (node.target_type === "folder") {
      if (inheritedParameters(node.request))
        throw Error("Apipost目录参数继承尚未支持");
      if (hasScript(node.script) || hasScript(node.request?.script))
        throw Error("Apipost目录脚本需要手工迁移");
      location(node);
      continue;
    }
    const request = node.request || {},
      body = request.body || {},
      notes = [];
    for (const script of [
      node.script,
      request.script,
      node.pre_script,
      node.test,
      request.pre_script,
      request.test,
    ])
      if (hasScript(script))
        throw Error("Apipost脚本需要手工审核/迁移，不自动丢弃或执行");
    let url = String(node.url || "");
    if (!url || url.length > 32768) throw Error("Apipost接口URL为空或过长");
    if (!/^https?:\/\//i.test(url) && !url.includes("{{")) {
      if (url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(url))
        throw Error("Apipost相对URL/协议需要先明确环境前缀");
      notes.push("原URL未声明协议，已采用HTTPS；发送前请确认。");
      url = "https://" + url;
    }
    const mode = body.mode || "none";
    if (
      ![
        "none",
        "json",
        "raw",
        "xml",
        "text",
        "html",
        "javascript",
        "form-data",
        "urlencoded",
      ].includes(mode)
    )
      throw Error("Apipost请求体类型尚未支持: " + mode);
    const form = rows(body.parameter || []);
    if (form.some((row) => row.type === "file"))
      notes.push("原文件路径未读取；必须重新选择文件。");
    const raw =
      body.raw === undefined || body.raw === null
        ? ""
        : typeof body.raw === "string"
          ? body.raw
          : JSON.stringify(body.raw);
    let bodyType = ["form-data", "urlencoded"].includes(mode)
      ? mode
      : raw
        ? mode === "json"
          ? "json"
          : "raw"
        : "none";
    const headers = rows(request.header || []);
    const media = {
      xml: "application/xml",
      html: "text/html",
      text: "text/plain",
      javascript: "application/javascript",
    };
    if (
      raw &&
      media[mode] &&
      !headers.some((row) => row.key.toLowerCase() === "content-type")
    )
      headers.push({ key: "Content-Type", value: media[mode], enabled: true });
    const examples = [],
      responses = [];
    for (const [name, definition] of Object.entries(node.response || {})) {
      if (!definition || typeof definition !== "object") continue;
      const status = Number(
        definition.expect?.code || (name === "success" ? 200 : 404),
      );
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw Error("Apipost响应状态无效");
      const format = definition.expect?.contentType || "json";
      const contentType = {
        json: "application/json",
        xml: "application/xml",
        html: "text/html",
        text: "text/plain",
        raw: "text/plain",
      }[format];
      if (!contentType) throw Error("Apipost响应媒体类型尚未支持");
      const responseSchema = schema(definition.expect?.schema || {});
      responses.push({
        status: String(status),
        description: String(definition.expect?.name || name),
        schema: responseSchema,
        content: { [contentType]: { schema: responseSchema } },
      });
      if (
        definition.raw !== undefined &&
        (preserveEmptyExamples || definition.raw !== "")
      )
        examples.push({
          name: String(definition.expect?.name || name),
          status,
          headers: { "content-type": contentType },
          body:
            typeof definition.raw === "string"
              ? definition.raw
              : JSON.stringify(definition.raw),
        });
    }
    output.push({
      id: randomUUID(),
      sourceOperationId:
        node.target_id !== undefined &&
        node.target_id !== null &&
        String(node.target_id) !== ""
          ? "apipost:" + node.target_id
          : "",
      name: String(node.name || "导入接口"),
      folder: location(node),
      method: node.method || "GET",
      url,
      description: String(request.description || ""),
      headers,
      query: rows(request.query || []),
      path: rows(request.resful || request.path || []),
      cookies: rows(request.cookie || request.cookies || []),
      bodyType,
      body: raw,
      form,
      auth: auth(request.auth),
      // Explicit native noauth/none is an opt-out, never target-project inheritance.
      ...(["noauth", "none"].includes(request.auth?.type)
        ? { inheritAuth: false }
        : {}),
      schema: schema(body.raw_schema || {}),
      examples,
      responses,
      importNotes: notes,
    });
  }
  return {
    requests: output,
    documents,
    folders: entries
      .filter((node) => node.target_type === "folder")
      .map((node) => location(node)),
  };
}
