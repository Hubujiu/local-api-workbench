import { normalizeImportedScriptTasks } from "../public/imported-script-tasks.js";
import { validateMockResponse } from "../public/response-example.js";
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
function responseHeaderMap(value) {
  if (empty(value)) return {};
  const names = new Set(),
    entries = [];
  for (const row of list(value, "响应示例头", 100)) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (k) =>
          ![
            "key",
            "value",
            "is_checked",
            "param_id",
            "description",
            "field_type",
            "not_null",
          ].includes(k),
      ) ||
      row.is_checked !== 1 ||
      (row.description !== undefined && row.description !== "") ||
      (row.field_type !== undefined && row.field_type !== "String") ||
      (row.not_null !== undefined && ![-1, 0].includes(row.not_null)) ||
      typeof row.key !== "string" ||
      typeof row.value !== "string"
    )
      throw Error("Apipost响应示例头仅支持启用的普通文本行；其他语义不会丢弃");
    const name = row.key.toLowerCase();
    if (names.has(name)) throw Error("Apipost响应头名称重复");
    names.add(name);
    entries.push([name, row.value]);
  }
  const headers = Object.fromEntries(entries);
  validateMockResponse({ status: 200, body: "", headers });
  return headers;
}
function scriptTasks(value, phase) {
  if (empty(value)) return null;
  const tasks = list(value, phase, 16);
  const metadata = [];
  for (const task of tasks) {
    if (
      !object(task) ||
      Object.keys(task).some(
        (k) => !["type", "id", "name", "enabled", "data"].includes(k),
      ) ||
      task.type !== "customScript" ||
      ![1, 0, -1].includes(task.enabled) ||
      typeof task.data !== "string" ||
      Buffer.byteLength(task.data, "utf8") > 65536
    )
      throw Error(
        "Apipost " +
          phase +
          " 仅支持自定义脚本及明确启停状态；其他任务语义不会丢弃",
      );
    safe(task.id);
    safe(task.name);
    metadata.push({ id: task.id, name: task.name, enabled: task.enabled });
  }
  const source = normalizeImportedScriptTasks({
    version: 1,
    before: tasks,
    after: [],
  }).before;
  const active = tasks.filter((task) => task.enabled === 1);
  const provenance = JSON.stringify(metadata);
  if (provenance.length > 1800)
    throw Error("Apipost脚本任务标识/名称总长度超过导入说明上限");
  // Preserve the existing one-block conversion exactly. Multiple blocks follow
  // observed original order in a shared lexical scope, with newline boundaries.
  const code =
    active.length === 1
      ? active[0].data
      : active
          .filter((task) => task.data && task.data !== "undefined")
          .map((task) => "\n" + task.data.trim() + "\n")
          .join("");
  if (Buffer.byteLength(code, "utf8") > 65536)
    throw Error("Apipost单阶段合并脚本超过64 KiB");
  return {
    code,
    source,
    note:
      phase +
      " 已启用脚本按原顺序转换；停用源码仅保留、不执行。原任务标识/名称/状态：" +
      provenance,
  };
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
      for (const task of ["script", "pre_script", "test"])
        reject(layer[task], task);
      if (layer !== request || node.target_type !== "api") {
        reject(layer.pre_tasks, "继承前置任务");
        reject(layer.post_tasks, "继承后置任务");
      }
    }
    const beforeTask =
      node.target_type === "api"
        ? scriptTasks(request.pre_tasks, "前置")
        : null;
    const afterTask =
      node.target_type === "api"
        ? scriptTasks(request.post_tasks, "后置")
        : null;
    let inheritedAuth = { type: "noauth" };
    for (const layer of ancestry)
      if (layer.auth && layer.auth.type !== "inherit")
        inheritedAuth = layer.auth;
    const merge = (key) => {
      const name = (row) =>
        key === "header" ? row.key.toLowerCase() : row.key;
      let values = [];
      for (const layer of ancestry) {
        const rows = parameterRows(layer[key], key);
        for (const row of rows)
          if (!object(row) || typeof row.key !== "string")
            throw Error("Apipost参数无效");
        const overridden = new Set(rows.map(name));
        values = [
          ...values.filter((row) => !overridden.has(name(row))),
          ...rows,
        ];
      }
      return values;
    };
    for (const layer of ancestry.slice(0, -1)) {
      reject(layer.body?.parameter, "继承Body参数");
      reject(layer.body?.raw, "继承原始Body");
    }
    const cookieFlag = request.cookie?.cookie_encode;
    if (cookieFlag !== undefined && ![0, -1, 1].includes(cookieFlag))
      throw Error("Apipost Cookie编码选项无效");
    const cookieEncoding =
      cookieFlag === undefined || cookieFlag === 1 ? "apipost" : "apipost-name";
    const queryFlag = request.query?.query_add_equal;
    if (queryFlag !== undefined && ![0, -1, 1].includes(queryFlag))
      throw Error("Apipost Query等号选项无效");
    const queryAddEqual = queryFlag === undefined || queryFlag === 1;
    const response = {},
      responseDelays = [],
      responseHeaders = [];
    for (const [index, item] of list(
      node.response?.example ?? [],
      "response.example",
    ).entries()) {
      if (!object(item) || !object(item.expect))
        throw Error("Apipost响应示例无效");
      const delay = item.expect.sleep;
      if (
        delay !== undefined &&
        (!Number.isInteger(delay) || delay < 0 || delay > 5000)
      )
        throw Error("Apipost响应延迟须为0至5000毫秒整数");
      if (item.raw === undefined && delay > 0)
        throw Error("Apipost响应延迟需要明确示例正文");
      if (item.raw !== undefined) responseDelays.push(delay);
      const exampleHeaders = responseHeaderMap(item.headers);
      if (item.raw === undefined && Object.keys(exampleHeaders).length)
        throw Error("Apipost响应示例头需要明确示例正文");
      if (item.raw !== undefined) responseHeaders.push(exampleHeaders);
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
      queryAddEqual,
      cookieEncoding,
      responseDelays,
      responseHeaders,
      beforeTask,
      afterTask,
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
                  mode:
                    request.body?.mode === "plain"
                      ? "text"
                      : request.body?.mode,
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
    if (row.beforeTask || row.afterTask) {
      request.scriptDialect = "apipost8";
      request.importedScriptTasks = normalizeImportedScriptTasks({
        version: 1,
        before: row.beforeTask?.source || [],
        after: row.afterTask?.source || [],
      });
      request.beforeScript = row.beforeTask?.code || "";
      request.afterScript = row.afterTask?.code || "";
      request.importNotes.push(
        "导入不执行脚本；运行前请审核。仅兼容现有 Apipost 8 脚本子集，不是完整 SDK 或任务列表往返迁移。",
      );
      for (const task of [row.beforeTask, row.afterTask])
        if (task) request.importNotes.push(task.note);
    }
    request.url = row.url;
    request.serviceId = row.serviceId;
    request.queryAddEqual = row.queryAddEqual;
    request.cookieEncoding = row.cookieEncoding;
    if (row.responseDelays.length !== request.examples.length)
      throw Error("Apipost响应延迟与示例映射不一致");
    row.responseDelays.forEach((delay, index) => {
      if (delay !== undefined) request.examples[index].delayMs = delay;
    });
    if (row.responseHeaders.length !== request.examples.length)
      throw Error("Apipost响应示例头映射不一致");
    row.responseHeaders.forEach((headers, index) => {
      request.examples[index].headers = {
        ...request.examples[index].headers,
        ...headers,
      };
      validateMockResponse(request.examples[index], {
        allowInformational: true,
      });
    });
    if (row.responseDelays.some((delay) => delay > 0))
      request.importNotes.push(
        "响应示例延迟已保留（最多5000ms）；OpenAPI不承载Mock延迟，请用项目备份保留。",
      );
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
