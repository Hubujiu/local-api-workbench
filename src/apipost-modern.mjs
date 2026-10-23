import { variableRows } from "../public/variable-definitions.js";
import { validateModelFolders } from "../public/model-folders.js";
import { prepareApipostModels } from "./apipost-models.mjs";
import { createHash } from "node:crypto";
import { importApipost } from "./apipost-import.mjs";
import { validateResources } from "./resources.mjs";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const empty = (value) =>
  value == null ||
  value === "" ||
  (Array.isArray(value)
    ? !value.length
    : object(value)
      ? !Object.keys(value).length
      : false);
const reject = (value, label) => {
  if (!empty(value))
    throw Error("Apipost现代JSON尚未支持 " + label + "，不会丢弃依赖");
};
const list = (value, label, max = 5000) => {
  if (!Array.isArray(value) || value.length > max)
    throw Error("Apipost " + label + " 数组无效");
  return value;
};
const safe = (value) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    throw Error("Apipost标识/变量名无效");
  return value;
};
const digest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
export function isModernApipost(source) {
  return (
    object(source) &&
    typeof source.project_id === "string" &&
    typeof source.name === "string" &&
    object(source.global) &&
    ["apis", "models", "samples", "automated_testings"].every((k) =>
      Array.isArray(source[k]),
    )
  );
}
function variables(map = {}) {
  if (!object(map) || Object.keys(map).length > 5000)
    throw Error("Apipost变量表无效");
  return Object.fromEntries(
    Object.entries(map).map(([key, item]) => {
      safe(key);
      if (!object(item)) throw Error("Apipost变量定义无效");
      const value = Object.hasOwn(item, "current_value")
        ? item.current_value
        : item.value;
      return [key, structuredClone(value ?? "")];
    }),
  );
}
function variableDefinitions(map = {}) {
  const definitions = Object.fromEntries(
    Object.entries(map).map(([key, item]) => [
      key,
      {
        initialValue: structuredClone(item.value ?? ""),
        description: item.description ?? "",
      },
    ]),
  );
  variableRows({}, definitions);
  return definitions;
}
function parameterRows(value, label) {
  if (value === undefined) return [];
  if (!object(value)) throw Error("Apipost现代参数包装无效: " + label);
  return list(value.parameter ?? [], label);
}
export function importModernApipost(source, project, { sync = false } = {}) {
  if (sync) throw Error("Apipost现代JSON暂不支持同步覆盖，请使用完整项目导入");
  if (!isModernApipost(source)) throw Error("Apipost现代JSON结构不完整");
  for (const [key, value] of Object.entries(source))
    if (
      ![
        "project_id",
        "name",
        "intro",
        "global",
        "apis",
        "models",
        "samples",
        "automated_testings",
      ].includes(key)
    )
      reject(value, key);
  const prefix = "apipost-" + digest(safe(source.project_id));
  const resource = (kind, id) =>
    prefix + "-" + kind + "-" + digest(safe(String(id)));
  for (const name of ["samples", "automated_testings"])
    reject(source[name], name);
  const models = prepareApipostModels(source.models, resource, source.name);
  const global = source.global;
  const knownGlobal = new Set([
    "envs",
    "servers",
    "global_vars",
    "global_param",
    "codes",
    "marks",
    "attributes",
    "mock_custom_rules",
    "db_link",
    "describe_library",
    "custom_func",
  ]);
  for (const [key, value] of Object.entries(global))
    if (!knownGlobal.has(key)) reject(value, "global." + key);
  for (const name of [
    "codes",
    "attributes",
    "mock_custom_rules",
    "db_link",
    "describe_library",
    "custom_func",
  ])
    reject(global[name], "global." + name);
  const servers = list(global.servers ?? [], "servers", 100).map((s) => ({
    id: resource("server", s.server_id),
    name: safe(s.name),
  }));
  const serverMap = new Map(
    (global.servers ?? []).map((s, i) => [String(s.server_id), servers[i].id]),
  );
  if (serverMap.size !== servers.length) throw Error("Apipost服务ID重复");
  const environments = list(global.envs ?? [], "envs", 100).map((env) => {
    const urls = {};
    for (const item of list(env.server_list ?? [], "server_list", 100)) {
      const mapped = serverMap.get(String(item.server_id));
      if (!mapped || Object.hasOwn(urls, mapped))
        throw Error("Apipost环境服务引用无效或重复");
      const uri = String(item.uri ?? "");
      if (uri) {
        let url;
        try {
          url = new URL(uri);
        } catch {
          throw Error("Apipost服务地址须为明确HTTP/HTTPS地址");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw Error("Apipost服务地址无效或含未支持的凭据/查询/片段");
      }
      urls[mapped] = uri.replace(/\/$/, "");
    }
    return {
      id: resource("env", env.env_id),
      name: safe(env.name),
      variables: variables(env.env_var_list ?? {}),
      variableDefinitions: variableDefinitions(env.env_var_list ?? {}),
      serverUrls: urls,
    };
  });
  if (new Set(environments.map((e) => e.id)).size !== environments.length)
    throw Error("Apipost环境ID重复");
  const globals = variables(global.global_vars ?? {});
  const globalDefinitions = variableDefinitions(global.global_vars ?? {});
  const statuses = list(global.marks ?? [], "marks", 100).map((mark) => ({
    id: resource("mark", mark.mark_id),
    name: safe(mark.name),
    color: mark.color,
  }));
  const marks = new Set((global.marks ?? []).map((m) => String(m.mark_id)));
  const nodes = list(source.apis, "apis");
  const ids = new Map();
  for (const node of nodes) {
    if (!object(node) || !["api", "folder"].includes(node.target_type))
      throw Error("Apipost包含未支持的资源类型");
    const id = safe(String(node.target_id));
    if (ids.has(id)) throw Error("Apipost资源ID重复");
    ids.set(id, node);
    reject(node.children, "嵌套资源");
    reject(node.attribute_info, "接口属性");
    reject(node.tags, "接口标签");
    reject(node.ai_expect?.list, "AI条件Mock");
    if (node.mock_ip_white_list_enable && node.mock_ip_white_list_enable !== -1)
      throw Error("Apipost Mock IP白名单需手工迁移");
  }
  const chain = (node) => {
    const result = [];
    const seen = new Set();
    while (node) {
      if (seen.has(node) || seen.size > 30)
        throw Error("Apipost目录引用成环或过深");
      seen.add(node);
      result.unshift(node.request ?? {});
      const id = String(node.parent_id ?? "0");
      if (id === "0" || id === "") break;
      node = ids.get(id);
      if (!node || node.target_type !== "folder")
        throw Error("Apipost目录引用不存在");
    }
    return [global.global_param ?? {}, ...result];
  };
  const mapped = nodes.map((node) => {
    const request = node.request ?? {};
    if (!object(request)) throw Error("Apipost请求无效");
    if (request.body !== undefined && !object(request.body))
      throw Error("Apipost Body定义无效");
    if (node.response !== undefined && !object(node.response))
      throw Error("Apipost响应定义无效");
    for (const [key, value] of Object.entries(request))
      if (
        ![
          "auth",
          "body",
          "header",
          "query",
          "cookie",
          "restful",
          "pre_tasks",
          "post_tasks",
          "script",
          "pre_script",
          "test",
          "description",
        ].includes(key)
      )
        reject(value, "request." + key);
    reject(request.body?.binary, "二进制Body");
    reject(request.body?.raw_parameter, "Body参数树");
    const ancestry = chain(node);
    for (const layer of ancestry) {
      for (const task of [
        "pre_tasks",
        "post_tasks",
        "script",
        "pre_script",
        "test",
      ])
        reject(layer[task], task);
    }
    let inheritedAuth = { type: "noauth" };
    for (const layer of ancestry)
      if (layer.auth && layer.auth.type !== "inherit")
        inheritedAuth = layer.auth;
    const merge = (key) => {
      const values = new Map();
      for (const layer of ancestry)
        for (const row of parameterRows(layer[key], key)) {
          if (!object(row) || typeof row.key !== "string")
            throw Error("Apipost参数无效");
          values.set(key === "header" ? row.key.toLowerCase() : row.key, row);
        }
      return [...values.values()];
    };
    for (const layer of ancestry.slice(0, -1)) {
      reject(layer.body?.parameter, "继承Body参数");
      reject(layer.body?.raw, "继承原始Body");
    }
    if (
      request.cookie?.cookie_encode &&
      parameterRows(request.cookie, "cookie").length
    )
      throw Error("Apipost Cookie编码选项需手工迁移");
    if (
      [0, -1].includes(request.query?.query_add_equal) &&
      parameterRows(request.query, "query").some(
        (row) => String(row.value ?? "") === "",
      )
    )
      throw Error("Apipost省略等号查询参数需手工迁移");
    const response = {};
    for (const [index, item] of list(
      node.response?.example ?? [],
      "response.example",
    ).entries()) {
      if (!object(item) || !object(item.expect))
        throw Error("Apipost响应示例无效");
      if (item.expect.sleep) throw Error("Apipost响应延迟需手工迁移");
      reject(item.headers, "响应示例头");
      response["example" + index] = {
        ...item,
        expect: {
          ...item.expect,
          contentType: item.expect.content_type ?? "json",
          schema: models.rewrite(item.expect.schema ?? {}),
        },
      };
    }
    let url = String(node.url ?? "");
    if (url.startsWith("//")) throw Error("Apipost接口路径不能覆盖服务主机");
    let serviceId = "";
    if (
      node.target_type === "api" &&
      !/^https?:\/\//i.test(url) &&
      !url.includes("{{")
    ) {
      if (!url.startsWith("/") || url.startsWith("//"))
        throw Error("Apipost相对接口路径无效");
      const sourceId =
        node.server_id === undefined
          ? serverMap.has("1")
            ? "1"
            : serverMap.size === 1
              ? [...serverMap.keys()][0]
              : ""
          : String(node.server_id);
      serviceId = serverMap.get(sourceId);
      if (!serviceId) throw Error("Apipost相对URL缺少明确服务");
    } else if (
      node.target_type === "api" &&
      url.startsWith("/") &&
      url.includes("{{")
    ) {
      const sourceId =
        node.server_id === undefined
          ? serverMap.has("1")
            ? "1"
            : serverMap.size === 1
              ? [...serverMap.keys()][0]
              : ""
          : String(node.server_id);
      serviceId = serverMap.get(sourceId);
      if (!serviceId) throw Error("Apipost相对URL缺少明确服务");
    }
    if (node.protocol && !["http/1.1", "http/2"].includes(node.protocol))
      throw Error("Apipost请求协议尚未支持");
    if (node.mark_id && !marks.has(String(node.mark_id)))
      throw Error("Apipost状态引用不存在");
    return {
      node,
      url,
      serviceId,
      legacy: {
        ...node,
        url: serviceId ? "https://migration.invalid" + url : url,
        request:
          node.target_type === "folder"
            ? {}
            : {
                ...request,
                description: node.description ?? "",
                body: {
                  ...request.body,
                  raw_schema: models.rewrite(request.body?.raw_schema ?? {}),
                },
                header: merge("header"),
                query: merge("query"),
                cookie: merge("cookie"),
                restful: undefined,
                resful: parameterRows(request.restful, "restful"),
                auth: inheritedAuth,
              },
        response,
      },
    };
  });
  const legacy = importApipost(
    { apis: mapped.map((x) => x.legacy) },
    { preserveEmptyExamples: true },
  );
  for (const request of legacy.requests) {
    const row = mapped.find(
      (x) => "apipost:" + x.node.target_id === request.sourceOperationId,
    );
    request.url = row.url;
    request.serviceId = row.serviceId;
    request.httpVersion = row.node.protocol === "http/2" ? "2" : "1.1";
    request.statusId = row.node.mark_id
      ? resource("mark", row.node.mark_id)
      : "";
    request.importNotes.push(
      "现代Apipost JSON有限互操作；不代表原生目录已验证。请选择导入环境后再发送；Mock开关和原版响应自动校验不自动启用。",
    );
  }
  const mergeResources = (old = [], items = []) => {
    const result = structuredClone(old);
    for (const item of items) {
      const exists = result.find((x) => x.id === item.id);
      if (exists && JSON.stringify(exists) !== JSON.stringify(item))
        throw Error("Apipost资源同名冲突，请导入新项目");
      if (!exists) result.push(item);
    }
    return result;
  };
  const mergedGlobals = { ...(project.globalVariables ?? {}) };
  for (const [key, value] of Object.entries(globals)) {
    if (
      Object.hasOwn(mergedGlobals, key) &&
      JSON.stringify(mergedGlobals[key]) !== JSON.stringify(value)
    )
      throw Error("Apipost全局变量冲突: " + key);
    mergedGlobals[key] = value;
  }
  const mergedGlobalDefinitions = structuredClone(
    project.globalVariableDefinitions || {},
  );
  variableRows(project.globalVariables || {}, mergedGlobalDefinitions);
  for (const [key, definition] of Object.entries(globalDefinitions)) {
    const previous = mergedGlobalDefinitions[key];
    if (
      previous &&
      (JSON.stringify(previous.initialValue) !==
        JSON.stringify(definition.initialValue) ||
        (previous.description || "") !== definition.description)
    )
      throw Error("Apipost全局变量初始定义冲突: " + key);
    mergedGlobalDefinitions[key] = definition;
  }
  const previousEnvironments = (project.environments || []).map((env) => {
    const incoming = environments.find((item) => item.id === env.id);
    if (!incoming || env.variableDefinitions !== undefined) return env;
    const withoutDefinitions = { ...incoming };
    delete withoutDefinitions.variableDefinitions;
    return JSON.stringify(env) === JSON.stringify(withoutDefinitions)
      ? incoming
      : env;
  });
  const settings = {
    ...(project.settings ?? {}),
    statuses: mergeResources(project.settings?.statuses, statuses),
  };
  validateResources(settings);
  const components = structuredClone(project.openapiComponents ?? {});
  components.schemas ??= {};
  for (const [key, schema] of Object.entries(models.schemas)) {
    if (
      Object.hasOwn(components.schemas, key) &&
      JSON.stringify(components.schemas[key]) !== JSON.stringify(schema)
    )
      throw Error("Apipost模型同名冲突，请导入新项目");
    components.schemas[key] = schema;
  }
  const dictionary = mergeResources(project.dictionary, models.dictionary);
  const modelFolders = mergeResources(project.modelFolders, models.folders);
  validateModelFolders({ dictionary, modelFolders });
  return {
    ...legacy,
    metadata: {
      openapiComponents: components,
      dictionary,
      ...(modelFolders.length ? { modelFolders } : {}),
      environments: mergeResources(previousEnvironments, environments),
      servers: mergeResources(project.servers, servers),
      globalVariables: mergedGlobals,
      globalVariableDefinitions: mergedGlobalDefinitions,
      settings,
    },
  };
}
