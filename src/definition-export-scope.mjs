import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  referenceChildMode,
  referenceModeIsAllowed,
} from "./openapi-reference-context.mjs";

// Pure definition selection. This is deliberately not a backup, schema evaluator,
// importer, permission check, or exporter. Export adapters still validate the
// complete selected definitions and may reject semantics they cannot preserve.
const fail = (reason) => {
  throw Error("定义导出范围无效：" + reason);
};
const MAX_RESOURCES = 10000;
const MAX_EDGES = 50000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_NODES = 200000;
const MAX_DEPTH = 64;
const MAX_REFERENCE_BYTES = 8192;
const kinds = new Set([
  "api",
  "document",
  "folder",
  "case",
  "case-folder",
  "model",
  "model-folder",
  "environment",
  "globals",
  "protocol-bundle",
  "collection-bundle",
]);
const bundleIds = {
  globals: "configuration",
  "protocol-bundle": "definitions",
  "collection-bundle": "registry",
};
const protocolSettings = new Set([
  "socketioDefinitions",
  "grpcDefinitions",
  "apipostProtocolSources",
]);
const omitted = [
  "plans",
  "history",
  "runs",
  "loadRuns",
  "protocolRuns",
  "requestDefinitionHistory",
  "apiResourceTrash",
  "settings.apipostDirectoryArtifacts",
];
const transientRoots = new Set([
  ...omitted.filter((key) => !key.includes(".")),
  "requestDefinitionHistoryFormat",
  "loadReportFormat",
  "revision",
  "configRevision",
  "_diskFingerprint",
  "currentEnvironmentId",
  "storageFormat",
  "collections",
]);
const metadataFields = new Set([
  "version",
  "id",
  "name",
  "description",
  "createdAt",
  "updatedAt",
  "archived",
]);
const primaryFields = {
  requests: "api",
  documents: "document",
  cases: "case",
  caseFolders: "case-folder",
  modelFolders: "model-folder",
  environments: "environment",
};
const resourceKey = (kind, id) => JSON.stringify([kind, id]);
const entry = (node) => ({ kind: node.kind, id: node.id });
const compare = (a, b) =>
  a.kind < b.kind
    ? -1
    : a.kind > b.kind
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
const set = (target, key, value) =>
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function ordinary(value, array = false) {
  if (!value || typeof value !== "object" || types.isProxy(value))
    fail("仅接受普通JSON对象，不能包含代理");
  if (
    Array.isArray(value) !== array ||
    !(array ? [Array.prototype] : [Object.prototype, null]).includes(
      Object.getPrototypeOf(value),
    )
  )
    fail("JSON对象原型无效");
  return value;
}
function read(value, key) {
  if (types.isProxy(value)) fail("JSON不能包含代理");
  ordinary(value, Array.isArray(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, String(key));
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
    fail("JSON字段不能包含访问器或隐藏属性");
  return descriptor.value;
}
function fields(value) {
  ordinary(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail("JSON不能包含符号字段");
  return keys;
}
function array(value, max = MAX_RESOURCES) {
  if (value === undefined) return [];
  ordinary(value, true);
  const length = Object.getOwnPropertyDescriptor(value, "length").value;
  if (length > max || Reflect.ownKeys(value).length !== length + 1)
    fail("数组超限、稀疏或含附加字段");
  const result = [];
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(value, i)) fail("JSON数组不能稀疏");
    result.push(read(value, i));
  }
  return result;
}
function identifier(value, label = "资源标识") {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    !value.isWellFormed() ||
    value.includes("\0")
  )
    fail(label);
  return value;
}
function folderPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2000 ||
    !value.isWellFormed() ||
    /[\0\r\n]/.test(value) ||
    value.split("/").length > 30 ||
    value
      .split("/")
      .some((part) => !part.trim() || part === "." || part === "..")
  )
    fail("目录路径无效");
  return value;
}
function populated(value) {
  return (
    value !== undefined &&
    value !== null &&
    value !== "" &&
    value !== false &&
    (typeof value !== "object" ||
      (Array.isArray(value)
        ? array(value).length > 0
        : fields(value).length > 0))
  );
}
function copier({
  maxBytes = MAX_BYTES,
  maxNodes = MAX_NODES,
  maxDepth = MAX_DEPTH,
} = {}) {
  let bytes = 0,
    nodes = 0;
  const active = new Set();
  const charge = (size) => {
    bytes += size;
    if (bytes > maxBytes) fail("选中投影JSON字节超限");
  };
  function copy(value, depth = 0) {
    if (++nodes > maxNodes || depth > maxDepth)
      fail("选中投影JSON节点或深度超限");
    if (value === null || typeof value === "boolean") {
      charge(value === false ? 5 : 4);
      return value;
    }
    if (typeof value === "string") {
      if (!value.isWellFormed() || value.length > maxBytes)
        fail("选中投影JSON字节超限");
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      charge(JSON.stringify(value).length);
      return value;
    }
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      active.has(value)
    )
      fail("选中定义须为无循环的普通JSON，不能包含代理或函数");
    const isArray = Array.isArray(value);
    ordinary(value, isArray);
    active.add(value);
    charge(2);
    const keys = Reflect.ownKeys(value);
    const length = isArray
      ? Object.getOwnPropertyDescriptor(value, "length").value
      : 0;
    if (isArray && (length > maxNodes || keys.length !== length + 1))
      fail("JSON数组超限、稀疏或含附加字段");
    const out = isArray ? [] : {};
    let count = 0;
    for (const key of keys) {
      if (isArray && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        (isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
      )
        fail("JSON字段不能包含访问器、隐藏属性或符号");
      if (count++) charge(1);
      if (!isArray) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      const child = copy(descriptor.value, depth + 1);
      if (isArray) out.push(child);
      else set(out, key, child);
    }
    active.delete(value);
    return out;
  }
  return copy;
}
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;
function parseSelection(input) {
  const selection = copier({
    maxBytes: 2 * 1024 * 1024,
    maxNodes: 50000,
    maxDepth: 8,
  })(input);
  if (!isObject(selection)) fail("选择须为对象");
  if (selection.mode === "all") {
    if (Object.keys(selection).some((key) => key !== "mode"))
      fail("all范围不接受额外字段");
    return { mode: "all", resources: [], exclude: [] };
  }
  if (
    selection.mode !== "explicit" ||
    Object.keys(selection).some(
      (key) => !["mode", "resources", "exclude"].includes(key),
    ) ||
    !Array.isArray(selection.resources)
  )
    fail("选择字段无效");
  if (!selection.resources.length) fail("未选择任何资源");
  const parse = (values) => {
    if (!Array.isArray(values) || values.length > MAX_RESOURCES)
      fail("选择资源数量超限");
    const seen = new Set();
    return values
      .map((value) => {
        if (
          !isObject(value) ||
          Object.keys(value).length !== 2 ||
          !Object.hasOwn(value, "kind") ||
          !Object.hasOwn(value, "id") ||
          !kinds.has(value.kind)
        )
          fail("选择资源种类或字段无效");
        if (value.kind === "folder") folderPath(value.id);
        else identifier(value.id);
        if (
          Object.hasOwn(bundleIds, value.kind) &&
          value.id !== bundleIds[value.kind]
        )
          fail("选择bundle标识无效");
        const key = resourceKey(value.kind, value.id);
        if (seen.has(key)) fail("选择资源重复");
        seen.add(key);
        return value;
      })
      .sort(compare);
  };
  return {
    mode: "explicit",
    resources: parse(selection.resources),
    exclude: parse(selection.exclude ?? []),
  };
}

export function prepareDefinitionExportScope(source, input) {
  const selection = parseSelection(input);
  ordinary(source);
  const rootKeys = fields(source);
  const root = (key) => read(source, key);
  const settings = root("settings") ?? {};
  const components = root("openapiComponents") ?? {};
  ordinary(settings);
  ordinary(components);
  const schemas = read(components, "schemas") ?? {};
  ordinary(schemas);
  const nodes = new Map(),
    identities = new Map(),
    lists = new Map(),
    folders = new Map();
  let inventoryCount = 0;
  const count = () => {
    if (++inventoryCount > MAX_RESOURCES) fail("资源inventory数量超限");
  };
  const add = (kind, id, paths = [], info = {}) => {
    const key = resourceKey(kind, id);
    if (nodes.has(key)) fail("资源身份重复");
    count();
    const node = { kind, id, key, paths, ...info };
    nodes.set(key, node);
    return node;
  };
  const identity = (kind, id, owner) => {
    identifier(id);
    const key = resourceKey(kind, id);
    if (identities.has(key)) fail("资源身份重复");
    count();
    identities.set(key, owner);
  };
  const live = (row) => !read(row, "deletedAt");
  const addFolder = (path) => {
    if (path === undefined || path === "") return;
    folderPath(path);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const id = parts.slice(0, i).join("/");
      if (!folders.has(id)) folders.set(id, add("folder", id));
    }
  };
  const rawFolders = array(root("folders"));
  const seenFolders = new Set();
  for (const path of rawFolders) {
    folderPath(path);
    if (seenFolders.has(path)) fail("目录身份重复");
    seenFolders.add(path);
    addFolder(path);
  }
  for (const [field, kind] of Object.entries(primaryFields)) {
    const values = array(root(field));
    lists.set(field, values);
    const seen = new Set();
    for (const [index, value] of values.entries()) {
      ordinary(value);
      const id = identifier(read(value, "id"));
      if (seen.has(id)) fail("资源身份重复");
      seen.add(id);
      if (!live(value)) {
        count();
        continue;
      }
      const node = add(kind, id, [[field, index]], { source: value });
      if (["api", "document"].includes(kind)) {
        node.folder = read(value, "folder") ?? "";
        addFolder(node.folder);
      }
      if (["case", "case-folder"].includes(kind))
        node.sourceRequestId = read(value, "sourceRequestId");
      if (["model-folder", "case-folder"].includes(kind))
        node.parentId = read(value, "parentId") ?? "";
    }
  }
  const dictionary = array(root("dictionary"));
  lists.set("dictionary", dictionary);
  const modelIds = new Set();
  for (const [index, value] of dictionary.entries()) {
    ordinary(value);
    const id = identifier(read(value, "id"));
    if (modelIds.has(id)) fail("模型身份重复");
    modelIds.add(id);
    if (!live(value)) {
      count();
      continue;
    }
    add(
      "model",
      id,
      [
        ["dictionary", index],
        ...(Object.hasOwn(schemas, id)
          ? [["openapiComponents", "schemas", id]]
          : []),
      ],
      { source: value, folderId: read(value, "folderId") ?? "" },
    );
  }
  for (const id of fields(schemas)) {
    identifier(id);
    if (!modelIds.has(id))
      add("model", id, [["openapiComponents", "schemas", id]]);
  }
  const globalPaths = [];
  const partitioned = new Set([
    ...Object.keys(primaryFields),
    "dictionary",
    "folders",
    "openapiComponents",
    "settings",
    "protocols",
    "postmanCollections",
  ]);
  for (const key of rootKeys) {
    if (
      !transientRoots.has(key) &&
      !metadataFields.has(key) &&
      !partitioned.has(key)
    )
      globalPaths.push([key]);
  }
  for (const key of fields(settings))
    if (!protocolSettings.has(key) && key !== "apipostDirectoryArtifacts")
      globalPaths.push(["settings", key]);
  for (const key of fields(components))
    if (key !== "schemas") globalPaths.push(["openapiComponents", key]);
  const globals = add("globals", "configuration", globalPaths);
  const getPath = (path) =>
    path.reduce(
      (value, key) => (value === undefined ? undefined : read(value, key)),
      source,
    );
  for (const [path, kind, idField] of [
    [["servers"], "server", "id"],
    [["settings", "statuses"], "status", "id"],
    [["settings", "attributes"], "attribute", "key"],
    [["settings", "apipostDatabases"], "database", "id"],
  ]) {
    for (const value of array(getPath(path)))
      identity(kind, read(value, idField), globals);
  }
  const protocolPaths = [];
  const protocolItems = [];
  for (const [path, kind] of [
    [["protocols"], "protocol"],
    [["settings", "socketioDefinitions"], "socketio"],
    [["settings", "grpcDefinitions"], "grpc"],
    [["settings", "apipostProtocolSources"], "protocol-source"],
  ]) {
    const values = array(getPath(path));
    if (values.length) protocolPaths.push(path);
    const ids = new Set();
    for (const value of values) {
      const id = identifier(read(value, "id"));
      if (ids.has(id)) fail("协议身份重复");
      ids.add(id);
      count();
      if (!live(value)) continue;
      if (kind !== "protocol-source") {
        const folder = read(value, "folder") ?? "";
        addFolder(folder);
        protocolItems.push({ value, folder, kind });
      }
    }
  }
  const protocols = protocolPaths.length
    ? add("protocol-bundle", "definitions", protocolPaths)
    : null;
  const registry = root("postmanCollections");
  let collections;
  if (registry !== undefined) {
    ordinary(registry);
    collections = add("collection-bundle", "registry", [
      ["postmanCollections"],
    ]);
    for (const value of array(read(registry, "items")))
      identity("collection", read(value, "id"), collections);
  }
  const requested =
    selection.mode === "all"
      ? [...nodes.values()].map(entry).sort(compare)
      : selection.resources;
  const excludedInput = new Set(
    selection.exclude.map((item) => resourceKey(item.kind, item.id)),
  );
  for (const item of [...requested, ...selection.exclude])
    if (!nodes.has(resourceKey(item.kind, item.id)))
      fail("选择资源不存在或不是live定义");
  const selected = new Map(),
    reasons = new Map(),
    queue = [],
    edges = new Set(),
    copies = new Map();
  const copy = copier();
  const addSelected = (node, reason) => {
    if (!node) fail("引用目标不存在或类型不匹配");
    if (excludedInput.has(node.key)) fail("显式排除与必需资源依赖冲突");
    if (!selected.has(node.key)) {
      selected.set(node.key, node);
      reasons.set(node.key, new Set());
      queue.push(node);
    }
    reasons.get(node.key).add(reason);
  };
  const depend = (owner, target, reason) => {
    if (!target) fail("引用目标不存在或类型不匹配");
    if (owner.key !== target.key) {
      const key = JSON.stringify([owner.key, target.key, reason]);
      edges.add(key);
      if (edges.size > MAX_EDGES) fail("引用图edges数量超限");
    }
    addSelected(target, `dependency:${owner.kind}:${owner.id}:${reason}`);
  };
  const ref = (owner, kind, id, required = false) => {
    if (!required && (id === undefined || id === "")) return;
    if (kind === "folder") folderPath(id);
    else identifier(id, "引用资源标识无效");
    depend(
      owner,
      nodes.get(resourceKey(kind, id)) ?? identities.get(resourceKey(kind, id)),
      `${kind}-reference`,
    );
  };
  const values = (node) => {
    if (!copies.has(node.key))
      copies.set(
        node.key,
        node.paths.map((path) => ({ path, value: copy(getPath(path)) })),
      );
    return copies.get(node.key);
  };
  const within = (path, parent) =>
    path === parent || path.startsWith(parent + "/");
  const descendant = (node, ancestor, kind) => {
    const seen = new Set([node.id]);
    let id = node.parentId;
    while (id) {
      if (seen.has(id) || seen.size > 30) fail("目录父引用循环或过深");
      seen.add(id);
      if (id === ancestor) return true;
      const parent = nodes.get(resourceKey(kind, id));
      if (!parent) fail("目录父引用不存在");
      id = parent.parentId;
    }
    return false;
  };
  for (const item of requested) {
    const node = nodes.get(resourceKey(item.kind, item.id));
    addSelected(node, selection.mode === "all" ? "all" : "requested");
    if (selection.mode === "all") continue;
    // Workbench explicit contract: selecting a directory includes its live
    // subtree. A directory added as a dependency only supplies ancestry.
    if (node.kind === "folder") {
      for (const candidate of nodes.values())
        if (
          (candidate.kind === "folder" && within(candidate.id, node.id)) ||
          (["api", "document"].includes(candidate.kind) &&
            within(candidate.folder, node.id))
        )
          addSelected(candidate, `workbench-subtree:folder:${node.id}`);
      if (
        protocols &&
        protocolItems.some((item) => within(item.folder, node.id))
      )
        addSelected(protocols, `workbench-subtree:folder:${node.id}`);
    }
    if (["case-folder", "model-folder"].includes(node.kind)) {
      const descendants = new Set([node.id]);
      for (const candidate of nodes.values())
        if (
          candidate.kind === node.kind &&
          descendant(candidate, node.id, node.kind)
        ) {
          descendants.add(candidate.id);
          addSelected(candidate, `workbench-subtree:${node.kind}:${node.id}`);
        }
      for (const candidate of nodes.values())
        if (
          (node.kind === "model-folder" &&
            candidate.kind === "model" &&
            descendants.has(candidate.folderId)) ||
          (node.kind === "case-folder" &&
            candidate.kind === "case" &&
            descendants.has(read(candidate.source, "folderId")))
        )
          addSelected(candidate, `workbench-subtree:${node.kind}:${node.id}`);
    }
  }
  let schemaVisits = 0;
  const pointerParts = (value) => {
    if (typeof value !== "string" || !value.startsWith("#"))
      fail("仅支持可定位的本地引用");
    if (
      value.length > MAX_REFERENCE_BYTES ||
      Buffer.byteLength(value) > MAX_REFERENCE_BYTES
    )
      fail("引用文本字节超限");
    let fragment;
    try {
      fragment = decodeURIComponent(value.slice(1));
    } catch {
      fail("引用编码无效");
    }
    if (!fragment) return [];
    if (!fragment.startsWith("/")) fail("引用anchor尚未支持");
    let segments = 0;
    for (const character of fragment)
      if (character === "/" && ++segments > MAX_DEPTH) fail("引用路径段数超限");
    return fragment
      .slice(1)
      .split("/")
      .map((part) => {
        if (/~(?:[^01]|$)/.test(part)) fail("引用转义无效");
        return part.replaceAll("~1", "/").replaceAll("~0", "~");
      });
  };
  const locate = (value, segments, mode) => {
    for (const segment of segments) {
      if (!value || typeof value !== "object") fail("引用目标不存在");
      // Lazy inventory targets have not necessarily passed the selected copier.
      // Check for proxies before own-property/prototype inspection can trap.
      if (types.isProxy(value)) fail("引用目标不能包含JSON代理");
      ordinary(value, Array.isArray(value));
      if (!Object.hasOwn(value, segment)) fail("引用目标不存在");
      value = read(value, segment);
      mode = referenceChildMode(mode, segment, value);
    }
    if (types.isProxy(value)) fail("引用目标不能包含JSON代理");
    if (
      !referenceModeIsAllowed(mode) ||
      (mode === "schema"
        ? typeof value !== "boolean" && !isObject(value)
        : !isObject(value))
    )
      fail("引用目标不是合法声明位置");
    return { mode, value };
  };
  const scanSchema = (owner, rootValue, rootMode = "schema") => {
    if (rootValue === undefined) return;
    const visit = (value, mode, depth = 0) => {
      if (mode === "literal") return;
      if (++schemaVisits > MAX_NODES || depth > MAX_DEPTH)
        fail("引用图结构超限");
      if (!value || typeof value !== "object") return;
      if (mode === "schema") {
        if (
          [
            "$id",
            "$anchor",
            "$dynamicAnchor",
            "$dynamicRef",
            "$recursiveRef",
            "$recursiveAnchor",
            "APIPOST_REFS",
            "ECHOAPI_REFS",
            "ref",
          ].some((key) => Object.hasOwn(value, key))
        )
          fail("尚不支持改变Schema引用作用域或动态引用");
        if (populated(value.discriminator))
          fail("尚不支持Schema discriminator引用");
      }
      if (
        mode === "link" &&
        ["operationId", "operationRef"].some((key) => populated(value[key]))
      )
        fail("尚不支持OpenAPI Link操作引用");
      if (referenceModeIsAllowed(mode) && Object.hasOwn(value, "$ref")) {
        const segments = pointerParts(value.$ref);
        if (segments[0] === "components") {
          const located = locate({ components }, segments, "document");
          if (located.mode !== mode) fail("引用目标声明类型不匹配");
          if (segments.length < 3) fail("引用缺少组件拥有者");
          const target =
            segments[1] === "schemas"
              ? nodes.get(resourceKey("model", segments[2]))
              : globals;
          depend(owner, target, "openapi-reference");
        } else if (locate(rootValue, segments, rootMode).mode !== mode)
          fail("引用目标声明类型不匹配");
      }
      for (const [key, child] of Object.entries(value))
        visit(child, referenceChildMode(mode, key, child), depth + 1);
    };
    visit(rootValue, rootMode);
  };
  const schemaRequest = (owner, request) => {
    scanSchema(owner, request.schema);
    for (const group of ["query", "headers", "path", "cookies", "form"])
      for (const row of array(request[group], MAX_NODES))
        scanSchema(owner, row, "parameter");
    for (const response of array(request.responses, MAX_NODES))
      scanSchema(owner, response, "response");
    for (const example of array(request.examples, MAX_NODES))
      scanSchema(owner, example.schema);
    scanSchema(owner, request.openapiOperation, "operation");
    scanSchema(owner, request.nativeMock?.fallback?.schema);
    for (const rule of array(request.nativeMock?.rules, MAX_NODES))
      scanSchema(owner, rule.response?.schema);
  };
  const environments = [...nodes.values()].filter(
    (node) => node.kind === "environment",
  );
  const requireEnvironments = (owner) => {
    for (const env of environments) depend(owner, env, "dynamic-environment");
  };
  const hasTemplates = (value) => JSON.stringify(value).includes("{{");
  const hasScripts = (value) =>
    [
      "beforeScript",
      "afterScript",
      "sharedBeforeScripts",
      "sharedAfterScripts",
      "before",
      "after",
      "nativeTasks",
      "importedScriptTasks",
      "functions",
    ].some((key) => populated(value[key]));
  const typed = (owner, value) => {
    ref(owner, "server", value.serviceId);
    ref(owner, "status", value.statusId);
    ref(owner, "collection", value.postmanCollectionId);
    for (const key of Object.keys(value.attributes ?? {}))
      ref(owner, "attribute", key, true);
  };
  const request = (owner, value) => {
    if (!isObject(value)) fail("请求快照定义无效");
    typed(owner, value);
    ref(owner, "folder", value.folder);
    if (
      value.nativeInheritance !== undefined &&
      read(settings, "nativeInheritance") === undefined
    )
      fail("原生继承绑定缺少完整图");
    for (const phase of ["before", "after"])
      for (const task of array(value.nativeTasks?.[phase], MAX_NODES))
        if (task.type === "database")
          ref(owner, "database", task.data?.connectionId, true);
    schemaRequest(owner, value);
    depend(owner, globals, "global-configuration");
    if (hasTemplates(value) || hasScripts(value)) requireEnvironments(owner);
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor];
    const copied = values(node);
    const value = copied[0]?.value;
    switch (node.kind) {
      case "api":
        request(node, value);
        break;
      case "document":
        typed(node, value);
        ref(node, "folder", value.folder);
        if (value.statusId || Object.keys(value.attributes ?? {}).length)
          depend(node, globals, "document-configuration");
        break;
      case "folder": {
        const end = node.id.lastIndexOf("/");
        if (end >= 0) ref(node, "folder", node.id.slice(0, end), true);
        // Empty API folders still inherit project auth/parameters/Mock policy.
        // Keeping the atomic configuration lets exporters reject unsupported
        // policy instead of accidentally succeeding after it was removed.
        depend(
          node,
          globals,
          read(settings, "nativeInheritance") === undefined
            ? "folder-configuration"
            : "native-inheritance",
        );
        break;
      }
      case "model": {
        const dictionaryValue = copied.find(
          ({ path }) => path[0] === "dictionary",
        )?.value;
        const schemaValue = copied.find(
          ({ path }) => path[0] === "openapiComponents",
        )?.value;
        if (
          dictionaryValue &&
          (schemaValue === undefined ||
            !isDeepStrictEqual(dictionaryValue.schema, schemaValue))
        )
          fail("模型与Schema定义不一致");
        if (dictionaryValue)
          ref(node, "model-folder", dictionaryValue.folderId);
        scanSchema(node, schemaValue);
        break;
      }
      case "model-folder":
      case "case-folder": {
        descendant(node, "", node.kind); // Validate the complete parent chain.
        ref(node, node.kind, value.parentId);
        if (node.kind === "case-folder") {
          ref(node, "api", value.sourceRequestId, true);
          if (
            value.parentId &&
            nodes.get(resourceKey("case-folder", value.parentId))
              ?.sourceRequestId !== value.sourceRequestId
          )
            fail("目录父引用跨接口");
        }
        break;
      }
      case "case": {
        ref(node, "api", value.sourceRequestId, true);
        ref(node, "case-folder", value.folderId);
        if (
          value.folderId &&
          nodes.get(resourceKey("case-folder", value.folderId))
            ?.sourceRequestId !== value.sourceRequestId
        )
          fail("用例目录引用跨接口");
        request(node, value.request);
        if (populated(value.functions)) requireEnvironments(node);
        break;
      }
      case "environment": {
        for (const id of Object.keys(value.serverUrls ?? {}))
          ref(node, "server", id, true);
        if (hasTemplates(value)) {
          depend(node, globals, "environment-configuration");
          requireEnvironments(node);
        }
        break;
      }
      case "globals": {
        for (const { path, value: current } of copied) {
          if (path[0] === "openapiComponents")
            scanSchema(
              node,
              current,
              referenceChildMode("components", path[1], current),
            );
          if (
            path[0] === "settings" &&
            [
              "folderAuth",
              "folderScripts",
              "folderParameters",
              "folderServices",
            ].includes(path[1])
          ) {
            if (!isObject(current)) fail("目录配置须为对象");
            for (const [folder, config] of Object.entries(current)) {
              ref(node, "folder", folder, true);
              if (path[1] === "folderServices")
                ref(node, "server", config, true);
              if (path[1] === "folderParameters")
                for (const rows of Object.values(config))
                  for (const row of array(rows, MAX_NODES))
                    scanSchema(node, row, "parameter");
            }
          }
          if (path[0] === "settings" && path[1] === "globalParameters")
            for (const rows of Object.values(current))
              for (const row of array(rows, MAX_NODES))
                scanSchema(node, row, "parameter");
          if (
            hasTemplates(current) ||
            (path[0] === "settings" &&
              ["functions", "globalScripts", "folderScripts"].includes(
                path[1],
              ) &&
              populated(current))
          )
            requireEnvironments(node);
        }
        break;
      }
      case "protocol-bundle": {
        depend(node, globals, "global-configuration");
        for (const item of protocolItems) ref(node, "folder", item.folder);
        for (const { path, value: current } of copied) {
          if (current.some((item) => item.deletedAt))
            fail("协议bundle包含非live定义，不能拆分来源图");
          if (path.at(-1) !== "apipostProtocolSources")
            for (const protocol of current) {
              typed(node, protocol);
              schemaRequest(node, protocol);
              if (hasScripts(protocol)) requireEnvironments(node);
            }
          if (hasTemplates(current)) requireEnvironments(node);
        }
        break;
      }
      case "collection-bundle": {
        if (value.version !== 1 || !Array.isArray(value.items))
          fail("collection registry定义无效");
        if (hasTemplates(value) || value.items.some(hasScripts)) {
          depend(node, globals, "collection-configuration");
          requireEnvironments(node);
        }
        break;
      }
    }
  }
  // Native inheritance identity is an indivisible graph. Preserve it or reject;
  // never delete the graph to evade the exporters' identity/snapshot guards.
  if (
    read(settings, "nativeInheritance") !== undefined &&
    selected.has(globals.key) &&
    selected.size !== nodes.size
  )
    fail("原生继承图不可拆分，请选择全部live定义资源");
  const projected = {
    requests: [],
    documents: [],
    folders: [],
    cases: [],
    caseFolders: [],
    dictionary: [],
    modelFolders: [],
    environments: [],
    protocols: [],
    settings: {},
    openapiComponents: { schemas: {} },
  };
  for (const key of metadataFields) {
    const value = root(key);
    if (value !== undefined) set(projected, key, copy(value));
  }
  for (const [field, kind] of Object.entries(primaryFields))
    projected[field] = lists
      .get(field)
      .filter(
        (value) =>
          selected.has(resourceKey(kind, read(value, "id"))) && live(value),
      )
      .map(
        (value) => copies.get(resourceKey(kind, read(value, "id")))[0].value,
      );
  projected.dictionary = dictionary
    .filter(
      (value) =>
        selected.has(resourceKey("model", read(value, "id"))) && live(value),
    )
    .map(
      (value) =>
        copies
          .get(resourceKey("model", read(value, "id")))
          .find(({ path }) => path[0] === "dictionary").value,
    );
  projected.folders = [...folders.keys()].filter((id) =>
    selected.has(resourceKey("folder", id)),
  );
  for (const node of selected.values())
    for (const { path, value } of copies.get(node.key)) {
      if (Object.hasOwn(primaryFields, path[0]) || path[0] === "dictionary")
        continue;
      let parent = projected;
      for (const segment of path.slice(0, -1)) {
        if (!Object.hasOwn(parent, segment)) set(parent, segment, {});
        parent = parent[segment];
      }
      set(parent, path.at(-1), value);
    }
  projected.openapiComponents.schemas = Object.fromEntries(
    fields(schemas)
      .filter((id) => Object.hasOwn(projected.openapiComponents.schemas, id))
      .map((id) => [id, projected.openapiComponents.schemas[id]]),
  );
  // Account for shells and metadata as well as values, and detach every alias.
  const resultProject = copier()(projected);
  const requestedKeys = new Set(
    requested.map(({ kind, id }) => resourceKey(kind, id)),
  );
  const included = [...selected.values()].sort(compare).map((node) => ({
    ...entry(node),
    reasons: [...reasons.get(node.key)].sort(),
  }));
  const dependencies = included
    .filter(({ kind, id }) => !requestedKeys.has(resourceKey(kind, id)))
    .map(({ kind, id }) => ({ kind, id }));
  const excluded = [...nodes.values()]
    .filter((node) => !selected.has(node.key))
    .sort(compare)
    .map(entry);
  const digestProject = { ...resultProject };
  delete digestProject.updatedAt;
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        sorted({
          project: digestProject,
          selection,
          requested,
          included,
          dependencies,
        }),
      ),
    )
    .digest("hex");
  return {
    project: resultProject,
    scope: {
      version: 1,
      mode: selection.mode,
      requested,
      included,
      dependencies,
      excluded,
      omitted: [...omitted],
      digest,
    },
  };
}
