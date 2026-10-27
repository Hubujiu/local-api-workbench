import { exportApipostTaskPipeline } from "./apipost-task-export.mjs";
import { validateNativeInheritanceProject } from "./native-inheritance.mjs";
import {
  applyNativeInheritanceExport,
  verifyNativeInheritanceExport,
} from "./native-inheritance-export.mjs";
import {
  prepareSampleExport,
  verifySampleDefinitions,
} from "./apipost-sample-export.mjs";
import {
  prepareProtocolExport,
  verifyProtocolDocument,
} from "./apipost-protocol-export.mjs";
import { exportExtendedApipostAuth } from "./apipost-auth-export.mjs";
import { prepareApipostModelExport } from "./apipost-model-export.mjs";
import { exportApipostDocuments } from "./apipost-document-export.mjs";
import { exportApipostMock } from "./apipost-mock-export.mjs";
import { exportApipostResponses } from "./apipost-response-export.mjs";
import { createHash } from "node:crypto";
import { normalizeRequest, importIntoProject } from "./core.mjs";
import { variableRows } from "../public/variable-definitions.js";

// Independently written interchange adapter. No original code or runtime is used.
const populated = (v) =>
  v != null &&
  v !== "" &&
  v !== false &&
  (typeof v !== "object" || Object.keys(v).length > 0);
const unsupported = (value, label) => {
  if (populated(value))
    throw Error(`Apipost导出尚不能表达${label}；请使用项目备份`);
};
export const apipostExportId = (kind, value) =>
  kind + createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
function variables(values, definitions) {
  return Object.fromEntries(
    variableRows(values, definitions).map((row) => {
      if (
        !row.currentSet ||
        row.currentValue === null ||
        row.initialValue === null
      )
        throw Error("Apipost导出不能保留未设置或null的变量值；请使用项目备份");
      return [
        row.key,
        {
          value: row.initialValue,
          description: row.description,
          current_value: row.currentValue,
        },
      ];
    }),
  );
}

function rows(values, kind) {
  return values.map((row, index) => {
    if (typeof row.key !== "string" || typeof row.value !== "string")
      throw Error("Apipost导出参数名和值须为文本");
    unsupported(row.dynamic, `${kind}动态函数`);
    if (row.type === "file")
      throw Error("Apipost导出不读取或携带本地文件；请使用项目备份");
    for (const key of ["contentType", "content_type", "fileBase64", "filePath"])
      unsupported(row[key], `${kind}.${key}`);
    const schema = row.schema ?? {};
    if (
      !schema ||
      typeof schema !== "object" ||
      Array.isArray(schema) ||
      Object.keys(schema).some((key) => key !== "type") ||
      (schema.type !== undefined &&
        !["string", "integer", "number", "boolean", "array", "object"].includes(
          schema.type,
        ))
    )
      throw Error("Apipost导出参数schema仅支持明确基础类型；不会丢弃约束");
    return {
      param_id: apipostExportId("p", kind + ":" + index),
      key: row.key,
      value: row.value,
      is_checked: row.enabled === false ? -1 : 1,
      not_null: row.required === true ? 1 : -1,
      description: row.description || "",
      field_type: schema.type ?? "string",
      schema: structuredClone(row.schema || {}),
    };
  });
}
function auth(value) {
  const extended = exportExtendedApipostAuth(value);
  if (extended) return extended;
  switch (value.type) {
    case "none":
      return { type: "noauth" };
    case "basic":
      return {
        type: "basic",
        basic: {
          username: value.username || "",
          password: value.password || "",
        },
      };
    case "bearer":
      return { type: "bearer", bearer: { key: value.token || "" } };
    case "apiKey":
      return {
        type: "kv",
        kv: { in: value.in, key: value.key, value: value.value },
      };
    default:
      throw Error("Apipost导出尚不支持此认证类型；请使用项目备份");
  }
}
function tasks(request, phase) {
  const code = request[phase === "before" ? "beforeScript" : "afterScript"];
  const source = request.importedScriptTasks?.[phase];
  if ((source?.length || code) && request.scriptDialect !== "apipost8")
    throw Error("Apipost导出不能转换其他脚本方言；请使用项目备份");
  if (source?.length) {
    const active = source.filter((task) => task.enabled === 1);
    const original =
      active.length === 1
        ? active[0].data
        : active
            .filter((task) => task.data && task.data !== "undefined")
            .map((task) => "\n" + task.data.trim() + "\n")
            .join("");
    if (original !== code)
      throw Error("当前脚本已修改，不能用旧的任务来源替换；请使用项目备份");
    return source.map((task) => {
      if (task.type !== "customScript" || task.origin)
        throw Error(
          "Apipost导出尚不支持数据库任务或展开继承脚本；请使用项目备份",
        );
      return {
        id: task.id,
        name: task.name,
        type: task.type,
        enabled: task.enabled,
        data: task.data,
      };
    });
  }
  return code
    ? [
        {
          id: apipostExportId("t", request.id + phase),
          name: phase === "before" ? "前置脚本" : "后置脚本",
          type: "customScript",
          enabled: 1,
          data: code,
        },
      ]
    : [];
}
export function exportApipost(project, options = {}) {
  validateNativeInheritanceProject(project);
  if (
    !project ||
    !Array.isArray(project.requests) ||
    project.requests.length > 5000 ||
    !Array.isArray(project.environments) ||
    project.environments.length > 100
  )
    throw Error("Apipost导出项目结构无效或超过限制");
  // This is a definition interchange, not a backup, execution archive or grant.
  for (const key of [
    "plans",
    "apiResourceTrash",
    "parameterDictionary",
    "models",
  ])
    unsupported(project[key], key);
  // false is meaningful here: absence enables Mock serving. Native definitions
  // have no verified project-wide equivalent, so never silently reopen it.
  if (project.settings?.mockEnabled === false)
    throw Error("Apipost导出不能保留项目Mock关闭状态；请使用项目备份");
  for (const [key, value] of Object.entries(project.settings || {}))
    if (
      ![
        "statuses",
        "recursiveFolderScopes",
        "apipostProtocolSources",
        "nativeInheritance",
      ].includes(key)
    )
      unsupported(value, `设置 ${key}`);
  if (
    typeof project.id !== "string" ||
    !project.id ||
    typeof project.name !== "string" ||
    !project.name.trim()
  )
    throw Error("Apipost导出项目标识或名称无效");
  for (const [label, items] of [
    ["环境", project.environments],
    ["服务", project.servers || []],
    ["状态", project.settings?.statuses || []],
  ]) {
    if (!Array.isArray(items) || items.length > 100)
      throw Error("Apipost导出" + label + "列表无效");
    const seen = new Set();
    for (const item of items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        seen.has(item.id) ||
        typeof item.name !== "string" ||
        !item.name.trim()
      )
        throw Error("Apipost导出" + label + "标识或名称无效/重复");
      seen.add(item.id);
    }
  }
  const sourceServerIds = new Set((project.servers || []).map((s) => s.id));
  for (const env of project.environments)
    for (const [key, value] of Object.entries(env.serverUrls || {})) {
      if (!sourceServerIds.has(key))
        throw Error("Apipost导出环境服务引用不存在");
      if (value) {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw Error("Apipost导出服务地址不等价或无效");
      }
    }
  const projectId = apipostExportId("project", project.id);
  const modelExport = prepareApipostModelExport(
    project,
    (kind, value) => apipostExportId(kind, projectId + "\0" + value),
    options,
  );
  if ((project.servers || []).length > 1)
    throw Error("Apipost导出暂仅支持一个默认服务；多服务绑定请使用项目备份");
  const servers = (project.servers || []).map((s, index) => ({
    server_id: "1",
    name: s.name,
    sort: (index + 1) * 1000,
  }));
  const serverIds = new Map(
    (project.servers || []).map((s, index) => [s.id, servers[index].server_id]),
  );
  if (!servers.length)
    servers.push({ server_id: "1", name: "默认服务", sort: 1000 });
  const marks = (project.settings?.statuses || []).map((s) => ({
    mark_id: apipostExportId("m", s.id),
    name: s.name,
    color: s.color,
    project_id: projectId,
    is_default_mark: -1,
    is_sys_default: -1,
  }));
  const markIds = new Set((project.settings?.statuses || []).map((s) => s.id));
  const protocolExport = prepareProtocolExport(project, {
    projectId,
    id: apipostExportId,
  });
  const apis = [],
    folders = new Map(protocolExport.folders);
  function folder(name) {
    if (!name) return "0";
    if (folders.has(name)) return folders.get(name);
    const parts = name.split("/");
    if (
      parts.length > 30 ||
      parts.some(
        (p) =>
          !p.trim() ||
          [".", "..", "__proto__", "constructor", "prototype"].includes(p),
      )
    )
      throw Error("Apipost导出目录路径无效");
    const parent_id = folder(parts.slice(0, -1).join("/"));
    const target_id = apipostExportId("f", name);
    folders.set(name, target_id);
    apis.push({
      target_id,
      project_id: projectId,
      parent_id,
      target_type: "folder",
      name: parts.at(-1),
      request: {},
      sort: apis.length + 1,
    });
    return target_id;
  }
  for (const name of project.folders || []) folder(name);
  const requestIds = new Set();
  function requestNode(input) {
    if (!input.id || requestIds.has(input.id))
      throw Error("Apipost导出接口ID缺失或重复");
    requestIds.add(input.id);
    const pipeline = exportApipostTaskPipeline(input);
    if (typeof input.schema === "boolean")
      throw Error(
        "原生导出不支持API直接布尔schema；请引用明确模型或使用项目备份",
      );
    const r = normalizeRequest(input);
    if (r.scriptURLMode === "sdk")
      throw Error("Apipost导出不能保留SDK URL对象模式；请使用项目备份");
    for (const key of [
      "importedNativeTaskSource",
      "bodyDynamic",
      "before",
      "after",
      "assertions",
      "extract",
      "mockRules",
      "openapiOperation",
      "attributes",
      "proxy",
      "tls",
      "sharedBeforeScripts",
      "sharedAfterScripts",
      "scriptURLRuntime",
    ])
      unsupported(r[key] ?? input[key], key);
    if (r.timeout !== 15000)
      throw Error("Apipost导出尚不能保留自定义超时；请使用项目备份");
    if (r.cookies.length && r.cookieEncoding === "raw")
      throw Error("Apipost导出不能无损表达原始Cookie编码；请使用项目备份");
    if (
      !["none", "json", "raw", "urlencoded", "form-data"].includes(r.bodyType)
    )
      throw Error("Apipost导出不支持此Body类型");
    if (
      r.bodyType === "raw" &&
      !r.headers.some(
        (h) => h.enabled !== false && h.key.toLowerCase() === "content-type",
      )
    )
      throw Error("Apipost文本导出需要明确Content-Type；请先保存请求头");
    if (r.serviceId && !serverIds.has(r.serviceId))
      throw Error("Apipost导出服务引用不存在");
    if (r.statusId && !markIds.has(r.statusId))
      throw Error("Apipost导出状态引用不存在");
    if (
      !/^https?:\/\//i.test(r.url) &&
      !r.url.includes("{{") &&
      !(r.serviceId && r.url.startsWith("/"))
    )
      throw Error("Apipost导出URL必须为HTTP地址、模板或绑定服务的相对路径");
    if (r.url.includes("#")) throw Error("Apipost导出暂不支持URL片段");
    // Original import reconstructs URL from query rows, dropping URL-only query.
    // Promote literal pairs before editable rows. Refuse spelling we cannot retain.
    const queryIndex = r.url.indexOf("?");
    const literal = queryIndex < 0 ? "" : r.url.slice(queryIndex + 1);
    const literalRows = [];
    if (queryIndex >= 0 && !literal)
      throw Error("Apipost导出不能保留空Query分隔符");
    for (const part of literal ? literal.split("&") : []) {
      const pairs = [...new URLSearchParams(part)];
      if (pairs.length !== 1 || !pairs[0][0] || /[+%]/.test(part))
        throw Error("Apipost导出不能无损表达此URL Query编码；请使用项目备份");
      const [key, value] = pairs[0];
      const encoded = new URLSearchParams([[key, value]]).toString();
      if (
        part !==
        (!r.queryAddEqual && value === "" ? encoded.slice(0, -1) : encoded)
      )
        throw Error("Apipost导出不能无损表达此URL Query编码；请使用项目备份");
      literalRows.push({ key, value, enabled: true });
    }
    const queryRows = [...literalRows, ...r.query];
    const suffix = queryRows
      .filter((q) => q.enabled !== false && q.key)
      .map((q) => {
        const pair = new URLSearchParams([[q.key, q.value]]).toString();
        return !r.queryAddEqual && q.value === "" ? pair.slice(0, -1) : pair;
      })
      .join("&");
    const url =
      (queryIndex < 0 ? r.url : r.url.slice(0, queryIndex)) +
      (suffix ? "?" + suffix : "");

    return {
      target_id: apipostExportId("a", r.id),
      project_id: projectId,
      parent_id: folder(r.folder),
      target_type: "api",
      name: r.name,
      description: r.description,
      method: r.method,
      protocol: r.httpVersion === "2" ? "http/2" : "http/1.1",
      url,
      sort: apis.length + 1,
      version: 0,
      status: 1,
      attribute_info: {},
      ...(r.serviceId ? { server_id: serverIds.get(r.serviceId) } : {}),
      ...(r.statusId ? { mark_id: apipostExportId("m", r.statusId) } : {}),
      request: {
        auth: auth(r.auth),
        header: { parameter: rows(r.headers, "header") },
        query: {
          parameter: rows(queryRows, "query"),
          query_add_equal: r.queryAddEqual ? 1 : -1,
        },
        restful: { parameter: rows(r.path, "path") },
        cookie: {
          parameter: rows(r.cookies, "cookie"),
          cookie_encode: r.cookieEncoding === "apipost" ? 1 : -1,
        },
        body: {
          mode: r.bodyType === "raw" ? "plain" : r.bodyType,
          raw: r.body,
          parameter: rows(r.form, "body"),
          raw_parameter: [],
          raw_schema: modelExport.rewrite(r.schema || {}),
          binary: null,
        },
        pre_tasks: pipeline?.before ?? tasks(r, "before"),
        post_tasks: pipeline?.after ?? tasks(r, "after"),
      },
      response: exportApipostResponses(r, {
        rewriteSchema: modelExport.rewrite,
      }),
      ...exportApipostMock(r.nativeMock, {
        projectId,
        targetId: apipostExportId("a", r.id),
      }),
    };
  }
  for (const input of project.requests.filter((r) => !r.deletedAt))
    apis.push(requestNode(input));
  const samples = prepareSampleExport(project, {
    projectId,
    id: apipostExportId,
    encodeRequest: requestNode,
  });
  apis.push(
    ...exportApipostDocuments(project, {
      projectId,
      id: apipostExportId,
      folder,
    }),
  );
  apis.push(...protocolExport.emit(folder));
  if (apis.length > 5000) throw Error("Apipost最多5000条资源");
  const document = {
    project_id: projectId,
    name: project.name,
    intro: project.description || "",
    global: {
      envs: project.environments.map((env, index) => ({
        env_id: apipostExportId("e", env.id),
        name: env.name,
        is_private: -1,
        sort: (index + 1) * 1000,
        env_var_list: variables(
          env.variables || {},
          env.variableDefinitions || {},
        ),
        server_list: servers.map((s) => ({
          ...s,
          uri:
            env.serverUrls?.[
              [...serverIds].find(([, value]) => value === s.server_id)?.[0]
            ] || "",
        })),
      })),
      servers,
      global_vars: variables(
        project.globalVariables || {},
        project.globalVariableDefinitions || {},
      ),
      global_param: {
        auth: { type: "noauth" },
        header: { parameter: [] },
        query: { parameter: [] },
        cookie: { parameter: [] },
        body: { parameter: [] },
        pre_tasks: [],
        post_tasks: [],
      },
      codes: [],
      marks,
      attributes: [],
      mock_custom_rules: [],
      db_link: [],
      describe_library: [],
      custom_func: [],
    },
    apis,
    samples,
    models: modelExport.models,
    automated_testings: [],
  };
  applyNativeInheritanceExport(project, document, {
    id: apipostExportId,
    auth,
    rows,
  });
  verifyNativeInheritanceExport(
    project,
    document,
    (id) => apipostExportId("a", id),
    options,
  );
  if (Buffer.byteLength(JSON.stringify(document)) > 4 * 1024 * 1024)
    throw Error("Apipost导出超过4MiB");
  verifyProtocolDocument(project, document);
  if (samples.length) {
    const check = {
      requests: [],
      environments: [],
      folders: [],
      servers: [],
      settings: {},
    };
    importIntoProject(check, document, options);
    verifySampleDefinitions(project, check, (id) => apipostExportId("a", id));
  }
  return document;
}
