import { isDeepStrictEqual } from "node:util";
import { moveFolderTree } from "../public/folder-tree.js";
import { validateResourceJSON } from "./api-resource-lifecycle.mjs";
import { importApipostAuth, importApipostRows } from "./apipost-import.mjs";
import { validateGlobalParameters } from "../public/global-parameters.js";
import { validateSharedAuthSettings } from "../public/shared-auth.js";

const kinds = ["headers", "query", "cookies", "form"];
const sourceKinds = {
  headers: "header",
  query: "query",
  cookies: "cookie",
  form: "body",
};
const snapshots = [
  "authSnapshot",
  "parametersSnapshot",
  "serviceSnapshot",
  "sharedScriptsSnapshot",
];
const fail = (message) => {
  throw Error("原生继承图：" + message);
};
const populated = (v) =>
  v != null &&
  v !== "" &&
  v !== false &&
  (typeof v !== "object" || Object.keys(v).length > 0);
function fields(value, allowed, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(label + "字段无效");
}
function identifier(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    fail("来源或绑定标识无效");
  return value;
}
export function inheritanceMode(value) {
  if (value === undefined || value === "flatten") return "flatten";
  if (value !== "preserve")
    throw Error("inheritanceMode仅支持flatten或preserve");
  return value;
}
export function normalizeNativeInheritanceBinding(value) {
  if (value === undefined) return undefined;
  validateResourceJSON(value, 2048);
  fields(value, ["sourceProjectId", "sourceId", "authMode"], "接口绑定");
  identifier(value.sourceProjectId);
  identifier(value.sourceId);
  if (!["absent", "inherit", "none", "own"].includes(value.authMode))
    fail("认证继承意图无效");
  return structuredClone(value);
}
function rows(value, kind) {
  if (!Array.isArray(value) || value.length > 100)
    fail("每层每类参数最多100项");
  for (const row of value) {
    fields(
      row,
      [
        "key",
        "value",
        "enabled",
        "required",
        "description",
        "schema",
        ...(kind === "form" ? ["type"] : []),
      ],
      "参数",
    );
    if (kind === "form" && row.type !== undefined && row.type !== "text")
      fail("表单仅支持文本行");
    if (kind === "form" && /["\r\n\0]/.test(row.key))
      fail("表单名称不能含传输会改写的字符");
    if (row.required !== undefined && typeof row.required !== "boolean")
      fail("参数必填标识无效");
    if (row.description !== undefined && typeof row.description !== "string")
      fail("参数描述无效");
    if (row.schema !== undefined) {
      fields(row.schema, ["type"], "参数schema");
      if (
        row.schema.type !== undefined &&
        !["string", "integer", "number", "boolean", "array", "object"].includes(
          row.schema.type,
        )
      )
        fail("参数schema类型无效");
    }
  }
  validateGlobalParameters({
    [kind]: value.map(({ key, value, enabled }) => ({
      key,
      value,
      ...(enabled === undefined ? {} : { enabled }),
    })),
  });
  return value;
}
function auth(value) {
  fields(value, ["mode", "value"], "认证");
  if (!["absent", "inherit", "none", "own"].includes(value.mode))
    fail("认证继承意图无效");
  if (value.mode === "own") {
    if (!value.value || value.value.type === "none") fail("显式认证缺少提供方");
    validateSharedAuthSettings({ globalAuth: value.value });
  } else if (value.value !== undefined) fail("非own认证不能携带提供方字段");
}
function layer(value) {
  fields(value, ["auth", ...kinds], "层定义");
  auth(value.auth);
  for (const kind of kinds)
    rows(kind === "form" && value[kind] === undefined ? [] : value[kind], kind);
}
function sourceAuth(value) {
  if (value === undefined) return { mode: "absent" };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("源认证无效");
  if (value.type === "inherit") return { mode: "inherit" };
  if (["none", "noauth"].includes(value.type)) return { mode: "none" };
  const result = { mode: "own", value: importApipostAuth(value) };
  auth(result);
  return result;
}
function sourceLayer(request = {}, shared = false, snapshotRows = false) {
  fields(
    request,
    [
      "auth",
      "header",
      "query",
      "cookie",
      "body",
      "restful",
      "pre_tasks",
      "post_tasks",
      "script",
      "pre_script",
      "test",
      "description",
    ],
    "源request",
  );
  for (const key of ["pre_tasks", "post_tasks", "script", "pre_script", "test"])
    if (populated(request[key])) fail("preserve首片不支持任务或脚本");
  if (shared && (populated(request.body?.raw) || populated(request.restful)))
    fail("preserve不支持继承原始Body或路径参数");
  if (populated(request.description)) fail("preserve首片不保留request内部描述");
  if (shared && request.body !== undefined) {
    fields(request.body, ["mode", "parameter", "raw"], "共享Body");
    if (request.body.mode !== undefined && request.body.mode !== "none")
      fail("preserve首片不支持共享Body模式");
  }
  if (
    shared &&
    (request.query?.query_add_equal !== undefined ||
      request.cookie?.cookie_encode !== undefined)
  )
    fail("preserve首片不保留父层Query或Cookie编码开关");
  const result = { auth: sourceAuth(request.auth) };
  for (const kind of kinds) {
    const block = request[sourceKinds[kind]];
    if (
      kind === "form" &&
      !shared &&
      !["urlencoded", "form-data"].includes(block?.mode)
    ) {
      result.form = [];
      continue;
    }
    if (block !== undefined)
      fields(
        block,
        [
          "parameter",
          ...(kind === "form"
            ? ["mode", "raw", "raw_parameter", "raw_schema", "binary"]
            : []),
          ...(kind === "query"
            ? ["query_add_equal"]
            : kind === "cookies"
              ? ["cookie_encode"]
              : []),
        ],
        "源参数表",
      );
    if (
      kind === "form" &&
      (populated(block?.binary) ||
        populated(block?.raw) ||
        populated(block?.raw_parameter) ||
        populated(block?.raw_schema))
    )
      fail("表单层不能携带原始Body或schema生成行为");
    const items = block?.parameter || [];
    if (!Array.isArray(items) || items.length > 100) fail("源参数最多100项");
    for (const row of items) {
      fields(
        row,
        [
          "param_id",
          "key",
          "value",
          "is_checked",
          "is_system",
          "not_null",
          "description",
          "field_type",
          "schema",
          "type",
        ],
        "源参数行",
      );
      if (
        populated(row.is_system) &&
        ![-1, 0, "-1", "0"].includes(row.is_system)
      )
        fail("preserve首片不支持系统参数行");
      if (kind === "form" && String(row.field_type).toLowerCase() === "file")
        fail("表单不读取文件参数");
      if (row.type !== undefined && row.type !== "text")
        fail("preserve不读取文件参数");
      if (
        row.is_checked !== undefined &&
        ![-1, 0, 1, "-1", "0", "1", true, false].includes(row.is_checked)
      )
        fail("源参数启用标识无效");
      if (row.schema !== undefined) {
        fields(row.schema, ["type"], "源参数schema");
        if (
          row.schema.type !== undefined &&
          row.schema.type !== (row.field_type || "string")
        )
          fail("源参数schema不等价");
      }
    }
    result[kind] = importApipostRows(items);
    if (snapshotRows) {
      // Frozen effective lists may retain a disabled own row alongside its
      // enabled inherited counterpart. Validate each row without treating this
      // list as a new editable layer or changing its order/mask semantics.
      for (const row of result[kind]) rows([row], kind);
    } else rows(result[kind], kind);
  }
  if (!snapshotRows) layer(result);
  return result;
}
function formContract(request, layers) {
  const inherited = layers.some((value) => (value.form || []).length > 0);
  if (!inherited) return;
  if (
    !["urlencoded", "form-data"].includes(request.bodyType) ||
    typeof request.method !== "string" ||
    ["GET", "HEAD"].includes((request.method || "GET").toUpperCase())
  )
    fail("继承表单仅支持显式非GET/HEAD表单请求");
  for (const value of [...layers, { headers: request.headers || [] }])
    for (const header of value.headers || [])
      if (
        header.enabled !== false &&
        header.key.toLowerCase() === "content-type" &&
        (request.bodyType === "form-data" ||
          header.value.trim().toLowerCase() !==
            "application/x-www-form-urlencoded")
      )
        fail("继承表单Content-Type不在已证实子集");
}
export function assertEmptyInheritanceTarget(project) {
  for (const key of [
    "requests",
    "folders",
    "plans",
    "cases",
    "caseFolders",
    "documents",
    "dictionary",
    "modelFolders",
    "models",
    "protocols",
    "servers",
    "history",
    "runs",
    "protocolRuns",
    "parameterDictionary",
    "apiResourceTrash",
    "globalVariables",
    "globalVariableDefinitions",
    "openapiComponents",
    "settings",
  ])
    if (populated(project[key]))
      fail("preserve必须导入空项目，不能覆盖已有业务数据");
  const environments = project.environments || [];
  if (!Array.isArray(environments) || environments.length > 1)
    fail("preserve必须导入空项目，已有环境包含业务数据");
  if (environments.length) {
    const env = environments[0];
    if (
      !env ||
      typeof env.id !== "string" ||
      !env.id ||
      Object.keys(env).some(
        (key) => !["id", "name", "variables"].includes(key),
      ) ||
      env.name !== "默认环境" ||
      !isDeepStrictEqual(env.variables, { baseUrl: "http://127.0.0.1:4318" }) ||
      (project.currentEnvironmentId !== undefined &&
        project.currentEnvironmentId !== env.id)
    )
      fail("preserve必须导入空项目，仅可替换未修改的Store默认环境");
  } else if (project.currentEnvironmentId !== undefined)
    fail("preserve空项目不能保留已有环境选择");
}
export function prepareNativeInheritanceSource(
  source,
  { snapshotRows = false } = {},
) {
  validateResourceJSON(source);
  identifier(source.project_id);
  for (const key of [
    "models",
    "samples",
    "automated_testings",
    "nativeExecutionFlows",
  ])
    if (populated(source[key])) fail("preserve首片仅支持HTTP定义图");
  for (const [key, value] of Object.entries(source.global || {}))
    if (
      !["envs", "servers", "global_vars", "global_param"].includes(key) &&
      populated(value)
    )
      fail("preserve首片不支持其他全局资源");
  if (!Array.isArray(source.global?.envs) || !source.global.envs.length)
    fail("源须有明确环境");
  const servers = source.global.servers || [];
  if (
    servers.length > 1 ||
    (servers.length === 1 && String(servers[0].server_id) !== "1")
  )
    fail("preserve首片仅支持默认单服务");
  if (!Array.isArray(source.apis) || source.apis.length > 1100)
    fail("HTTP图最多1000接口和100目录");
  const ownDocument = structuredClone(source);
  ownDocument.global.global_param = {};
  const graph = {
    version: 1,
    sourceProjectId: source.project_id,
    projectLayer: sourceLayer(source.global.global_param, true),
    folders: [],
    bindings: [],
  };
  const apiLayers = new Map(),
    byId = new Map();
  for (const node of source.apis) {
    fields(
      node,
      [
        "target_id",
        "target_type",
        "project_id",
        "parent_id",
        "name",
        "description",
        "method",
        "url",
        "protocol",
        "sort",
        "version",
        "status",
        "attribute_info",
        "server_id",
        "mark_id",
        "request",
        "response",
      ],
      "HTTP资源",
    );
    identifier(node.target_id);
    if (node.target_id === "0") fail("源资源不能占用根父标识0");
    if (
      byId.has(node.target_id) ||
      !["api", "folder"].includes(node.target_type)
    )
      fail("HTTP图身份重复或类型不支持");
    byId.set(node.target_id, node);
  }
  function folderPath(id, seen = new Set()) {
    if (id === "0" || id === "") return "";
    const n = byId.get(id);
    if (!n || n.target_type !== "folder" || seen.has(id) || seen.size >= 30)
      fail("父目录缺失、成环或超过30层");
    if (
      typeof n.name !== "string" ||
      !n.name.trim() ||
      n.name !== n.name.trim() ||
      /[\\/\r\n\0]/.test(n.name) ||
      [".", "..", "__proto__", "constructor", "prototype"].includes(n.name)
    )
      fail("目录名无法保真");
    seen.add(id);
    const parent = folderPath(String(n.parent_id ?? "0"), seen);
    return parent ? parent + "/" + n.name : n.name;
  }
  for (const [index, node] of source.apis.entries()) {
    const parentId = String(node.parent_id ?? "0");
    const path = folderPath(parentId);
    if (node.project_id !== undefined && node.project_id !== source.project_id)
      fail("跨来源资源绑定");
    if (
      node.server_id !== undefined &&
      !["0", "1"].includes(String(node.server_id))
    )
      fail("目录服务覆盖不支持");
    const own = sourceLayer(
      node.request,
      node.target_type === "folder",
      snapshotRows && node.target_type === "api",
    );
    if (node.target_type === "folder") {
      graph.folders.push({
        sourceId: node.target_id,
        parentId,
        name: node.name,
        path: folderPath(node.target_id),
        layer: own,
      });
      ownDocument.apis[index].request = {};
    } else {
      apiLayers.set(node.target_id, {
        parentId,
        path,
        authMode: own.auth.mode,
      });
      // The ordinary converter validates and normalizes only the API's own rows.
      // Its full effective import is independently compared before publication.
      ownDocument.apis[index].request.auth =
        own.auth.mode === "own" ? node.request.auth : { type: "noauth" };
    }
  }
  if (graph.folders.length > 100 || apiLayers.size > 1000)
    fail("HTTP图数量超限");
  return { graph, ownDocument, apiLayers };
}
function ownRequest(request, binding) {
  normalizeNativeInheritanceBinding(request.nativeInheritance);
  if (!isDeepStrictEqual(request.nativeInheritance, binding))
    fail("接口绑定不匹配");
  if (snapshots.some((flag) => request[flag] === true))
    fail("带绑定的live定义不能冒充冻结快照");
  if (
    [
      "beforeScript",
      "afterScript",
      "nativeTasks",
      "importedScriptTasks",
      "importedNativeTaskSource",
      "before",
      "after",
      "sharedBeforeScripts",
      "sharedAfterScripts",
    ].some((key) => populated(request[key]))
  )
    fail("preserve首片不支持请求任务");
  for (const kind of kinds) rows(request[kind] || [], kind);
  if (
    (request.form || []).some(
      (row) =>
        row.type === "file" ||
        row.requiresFile ||
        row.filename ||
        row.filePath ||
        row.fileBase64,
    )
  )
    fail("preserve首片不支持文件参数");
  if (binding.authMode !== "own" && request.auth?.type !== "none")
    fail("继承或noauth接口不能携带own认证");
  if (binding.authMode === "own") auth({ mode: "own", value: request.auth });
}
export function validateNativeInheritanceProject(project) {
  const graph = project.settings?.nativeInheritance;
  if (graph === undefined) {
    if ((project.requests || []).some((r) => r.nativeInheritance !== undefined))
      fail("接口绑定缺少项目图");
    return undefined;
  }
  validateResourceJSON(graph, 262144);
  fields(
    graph,
    ["version", "sourceProjectId", "projectLayer", "folders", "bindings"],
    "项目图",
  );
  if (graph.version !== 1) fail("图版本不支持");
  identifier(graph.sourceProjectId);
  layer(graph.projectLayer);
  if (
    !Array.isArray(graph.folders) ||
    graph.folders.length > 100 ||
    !Array.isArray(graph.bindings) ||
    graph.bindings.length > 1000
  )
    fail("图数量超限");
  for (const key of [
    "globalAuth",
    "folderAuth",
    "globalParameters",
    "folderParameters",
    "globalScripts",
    "folderScripts",
    "folderServices",
  ])
    if (populated(project.settings[key])) fail("源图不能混合目标共享设置");
  const folders = new Map(),
    paths = new Set();
  for (const f of graph.folders) {
    fields(f, ["sourceId", "parentId", "name", "path", "layer"], "目录");
    identifier(f.sourceId);
    if (
      folders.has(f.sourceId) ||
      typeof f.parentId !== "string" ||
      typeof f.name !== "string" ||
      !f.name.trim() ||
      f.name !== f.name.trim() ||
      /[\\/\r\n\0]/.test(f.name) ||
      [".", "..", "__proto__", "constructor", "prototype"].includes(f.name)
    )
      fail("目录身份无效");
    layer(f.layer);
    folders.set(f.sourceId, f);
  }
  function ancestry(parentId) {
    const chain = [],
      seen = new Set();
    while (parentId && parentId !== "0") {
      const f = folders.get(parentId);
      if (!f || seen.has(parentId) || seen.size >= 30)
        fail("目录孤儿、循环或深度无效");
      seen.add(parentId);
      chain.unshift(f);
      parentId = f.parentId;
    }
    return chain;
  }
  for (const f of folders.values()) {
    if (
      f.path !==
        ancestry(f.sourceId)
          .map((x) => x.name)
          .join("/") ||
      paths.has(f.path)
    )
      fail("目录路径变化或重复；本片不支持移动关系");
    paths.add(f.path);
  }
  if (
    !isDeepStrictEqual([...(project.folders || [])].sort(), [...paths].sort())
  )
    fail("目录图不完整；不支持部分移动或删除");
  const requests = new Map((project.requests || []).map((r) => [r.id, r])),
    bound = new Map(),
    sourceIds = new Set(folders.keys());
  for (const b of graph.bindings) {
    fields(b, ["requestId", "sourceId", "parentId"], "绑定");
    identifier(b.requestId);
    identifier(b.sourceId);
    if (
      bound.has(b.requestId) ||
      sourceIds.has(b.sourceId) ||
      typeof b.parentId !== "string"
    )
      fail("重复或无效接口绑定");
    const r = requests.get(b.requestId);
    if (
      !r ||
      r.deletedAt ||
      r.folder !==
        ancestry(b.parentId)
          .map((f) => f.name)
          .join("/")
    )
      fail("接口缺失、已删除或目录关系变化");
    const binding = normalizeNativeInheritanceBinding(r.nativeInheritance);
    if (
      !binding ||
      binding.sourceProjectId !== graph.sourceProjectId ||
      binding.sourceId !== b.sourceId
    )
      fail("接口跨来源或缺少绑定");
    ownRequest(r, binding);
    formContract(r, [
      graph.projectLayer,
      ...ancestry(b.parentId).map((f) => f.layer),
    ]);
    bound.set(b.requestId, b);
    sourceIds.add(b.sourceId);
  }
  if (
    requests.size !== bound.size ||
    (project.requests || []).length !== bound.size
  )
    fail("项目接口与绑定图不完整");
  for (const item of project.cases || [])
    if (
      !bound.has(item.sourceRequestId) ||
      item.request?.id !== item.sourceRequestId
    )
      fail("冻结用例来源接口与请求身份不一致");
  for (const frozen of [
    ...(project.plans || []).flatMap((p) =>
      (p.steps || []).map((s) => s.request),
    ),
    ...(project.cases || []).map((c) => c.request),
  ])
    if (frozen?.nativeInheritance !== undefined)
      fail("冻结定义不能保留live绑定");
  return { graph, folders, bound, ancestry };
}
export function resolveNativeInheritance(
  project,
  request,
  { allowFrozen = false } = {},
) {
  const state = validateNativeInheritanceProject(project);
  if (!state) {
    if (request?.nativeInheritance !== undefined) fail("当前项目没有此来源图");
    return request;
  }
  const b = state.bound.get(request.id);
  if (request.nativeInheritance === undefined) {
    const frozenFlags = snapshots.every((flag) => request[flag] === true);
    // Snapshot flags or a live API ID alone are not proof of freezing. A direct
    // execution/new plan can reuse only an exact snapshot already stored in this
    // project. Edited old cases/steps use their separate trusted save context.
    const savedSnapshot =
      frozenFlags &&
      [
        ...(project.cases || [])
          .filter((item) => item.sourceRequestId === request.id)
          .map((item) => item.request),
        ...(project.plans || []).flatMap((plan) =>
          (plan.steps || []).map((step) => step.request),
        ),
      ].some(
        (saved) =>
          saved &&
          saved.nativeInheritance === undefined &&
          snapshots.every((flag) => saved[flag] === true) &&
          isDeepStrictEqual(saved, request),
      );
    if (b && !(frozenFlags && (allowFrozen || savedSnapshot)))
      fail("live接口丢失绑定，不能静默降级");
    return request;
  }
  if (!b) fail("临时请求不属于当前项目绑定");
  const stored = project.requests.find((r) => r.id === b.requestId);
  ownRequest(request, stored.nativeInheritance);
  if (request.folder !== stored.folder) fail("临时请求不能改变绑定目录");
  const layers = [
    state.graph.projectLayer,
    ...state.ancestry(b.parentId).map((f) => f.layer),
    {
      auth: {
        mode: request.nativeInheritance.authMode,
        ...(request.nativeInheritance.authMode === "own"
          ? { value: request.auth }
          : {}),
      },
      headers: request.headers || [],
      query: request.query || [],
      cookies: request.cookies || [],
      form: request.form || [],
    },
  ];
  formContract(request, layers.slice(0, -1));
  const result = structuredClone(request);
  let effectiveAuth = { type: "none" };
  for (const current of layers) {
    if (current.auth.mode === "own") effectiveAuth = current.auth.value;
    else if (current.auth.mode === "none") effectiveAuth = { type: "none" };
  }
  result.auth = structuredClone(effectiveAuth);
  for (const kind of kinds) {
    const key = (row) => (kind === "headers" ? row.key.toLowerCase() : row.key);
    let merged = [];
    for (const current of layers) {
      const active = new Set(
        (current[kind] || []).filter((row) => row.enabled !== false).map(key),
      );
      merged = [
        ...merged.filter((row) => !active.has(key(row))),
        ...(current[kind] || []),
      ];
    }
    result[kind] = structuredClone(merged);
  }
  delete result.nativeInheritance;
  result.inheritAuth =
    result.inheritGlobalParameters =
    result.inheritSharedScripts =
      false;
  for (const flag of snapshots) result[flag] = true;
  return result;
}

// Explicit owner operations preserve identities; generic project saves remain
// unable to detach or replace a graph. Recomputed again against locked storage.
export function editNativeInheritance(project, operation) {
  validateResourceJSON(operation, 4096);
  const state = validateNativeInheritanceProject(project);
  if (!state) fail("当前项目没有可编辑的继承图");
  fields(
    operation,
    operation?.type === "move-folder"
      ? ["type", "sourceId", "parentId", "name"]
      : ["type", "requestId", "parentId"],
    "结构操作",
  );
  if (!["move-folder", "move-request"].includes(operation.type))
    fail("仅支持目录改名/移动或接口移动");
  identifier(operation.parentId);
  if (operation.parentId !== "0" && !state.folders.has(operation.parentId))
    fail("目标父目录不属于当前项目");
  const parentPath =
    operation.parentId === "0"
      ? ""
      : state.folders.get(operation.parentId).path;
  let next;
  if (operation.type === "move-folder") {
    identifier(operation.sourceId);
    const folder = state.folders.get(operation.sourceId);
    if (!folder) fail("源目录不属于当前项目");
    const name = operation.name;
    if (
      typeof name !== "string" ||
      !name ||
      name !== name.trim() ||
      name.length > 200 ||
      !name.isWellFormed() ||
      /[\\/\r\n\0]/.test(name) ||
      [".", "..", "__proto__", "constructor", "prototype"].includes(name)
    )
      fail("目录名称无效");
    if (
      state
        .ancestry(operation.parentId)
        .some((f) => f.sourceId === folder.sourceId)
    )
      fail("不能移入自己的子目录");
    const destination = parentPath ? parentPath + "/" + name : name;
    next = moveFolderTree(project, folder.path, destination);
    const graph = next.settings.nativeInheritance;
    const moved = graph.folders.find((f) => f.sourceId === folder.sourceId);
    moved.name = name;
    moved.parentId = operation.parentId;
    for (const f of graph.folders) {
      if (f.path === folder.path || f.path.startsWith(folder.path + "/"))
        f.path = destination + f.path.slice(folder.path.length);
    }
  } else {
    if (
      typeof operation.requestId !== "string" ||
      !state.bound.has(operation.requestId)
    )
      fail("源接口不属于当前项目");
    next = structuredClone(project);
    next.settings.nativeInheritance.bindings.find(
      (b) => b.requestId === operation.requestId,
    ).parentId = operation.parentId;
    next.requests.find((r) => r.id === operation.requestId).folder = parentPath;
  }
  validateNativeInheritanceProject(next);
  return next;
}

// Structural edits need a deliberate graph-aware operation, not a partial CRUD
// update. Value-only layer/own-request changes remain allowed.
export function assertNativeInheritanceIdentity(previous, next, operation) {
  const prior = validateNativeInheritanceProject(previous || {});
  if (!prior) return;
  const current = validateNativeInheritanceProject(next);
  const edited =
    operation === undefined
      ? undefined
      : editNativeInheritance(previous, operation);
  const expected = edited ? edited.settings.nativeInheritance : prior.graph;
  if (edited) {
    // A dedicated structural operation cannot edit live values or snapshots.
    for (const key of [
      "settings",
      "folders",
      "requests",
      "documents",
      "protocols",
      "cases",
      "plans",
      "runs",
      "history",
      "protocolRuns",
    ])
      if (!isDeepStrictEqual(edited[key], next[key]))
        fail("结构操作不能夹带其他配置或冻结证据修改");
  }
  const identity = (g) => ({
    sourceProjectId: g.sourceProjectId,
    folders: g.folders.map(({ sourceId, parentId, name, path }) => ({
      sourceId,
      parentId,
      name,
      path,
    })),
    bindings: g.bindings,
  });
  if (
    !current ||
    !isDeepStrictEqual(identity(expected), identity(current.graph))
  )
    fail("本片不支持移除、移动或替换已绑定资源图；请使用独立项目");
}

// The source request comes from the authorized project's stored API, not tool
// input. Retain that context across freeze (which intentionally removes binding).
// Ordinary/flattened APIs keep the pre-existing MCP row-override contract.
export function assertNativeInheritanceMCPInput(
  project,
  sourceRequest,
  effective,
  input,
) {
  const state = validateNativeInheritanceProject(project);
  if (!state || !state.bound.has(sourceRequest.id)) return;
  const stored = project.requests.find((r) => r.id === sourceRequest.id);
  ownRequest(sourceRequest, stored.nativeInheritance);
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  // Use the actual frozen base, not a newly resolved live body. Header patches
  // enable even disabled rows, so preserved form APIs cannot bypass the bounded
  // Content-Type contract via a temporary MCP input.
  if (["urlencoded", "form-data"].includes(effective.bodyType)) {
    const patch = input.headers;
    if (patch && typeof patch === "object" && !Array.isArray(patch))
      for (const key of Object.keys(patch))
        if (
          key.toLowerCase() === "content-type" &&
          (effective.headers || []).some(
            (row) => row.key.toLowerCase() === "content-type",
          ) &&
          (effective.bodyType === "form-data" ||
            typeof patch[key] !== "string" ||
            patch[key].trim().toLowerCase() !==
              "application/x-www-form-urlencoded")
        )
          fail("继承图表单MCP Content-Type不在已证实子集");
  }
  const fields = [
    ["headers", "headers"],
    ["query", "query"],
    ["path", "path"],
    ["cookies", "cookies"],
  ];
  if (["urlencoded", "form-data"].includes(effective.bodyType))
    fields.push(["body", "form"]);
  for (const [inputKey, rowsKey] of fields) {
    const patch = input[inputKey];
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    const canonical = (key) =>
      rowsKey === "headers" ? key.toLowerCase() : key;
    for (const key of Object.keys(patch))
      if (
        (effective[rowsKey] || []).filter(
          (row) => canonical(row.key || "") === canonical(key),
        ).length > 1
      )
        fail("MCP临时输入不能覆盖同名多行参数");
  }
}
