import { isDeepStrictEqual, types } from "node:util";
import { manualImportDigest, manualImportID } from "./manual-import-token.mjs";
import {
  referenceChildMode,
  referenceModeIsAllowed,
} from "./openapi-reference-context.mjs";

const fail = (reason) => {
  throw Error("手动导入来源无效: " + reason);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const at = (value, path) => path.reduce((item, key) => item?.[key], value);
const pathKey = (path) => JSON.stringify(path);
const pointer = (part) =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const rootFields = new Set([
  "requests",
  "folders",
  "documents",
  "dictionary",
  "modelFolders",
  "cases",
  "caseFolders",
  "environments",
  "servers",
  "globalVariables",
  "globalVariableDefinitions",
  "settings",
  "openapiComponents",
  "protocols",
  "plans",
  "postmanCollections",
]);
const protocolSettings = new Set([
  "socketioDefinitions",
  "grpcDefinitions",
  "apipostProtocolSources",
]);
function sortedCopy(value) {
  if (Array.isArray(value)) return value.map(sortedCopy);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedCopy(value[key])]),
  );
}
function ordinaryCopy(value) {
  manualImportDigest(value); // Reject proxies/accessors/cycles/non-JSON before touching values.
  return sortedCopy(value);
}
// Storage-equivalent projection applies only after conversion. Optional object
// properties may be undefined, but arrays, accessors, toJSON and exotic values
// cannot disappear into JSON.stringify or execute during projection.
function converterCopy(input) {
  const active = new Set();
  let nodes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > 50000 || depth > 50) fail("转换结果结构上限");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      active.has(value)
    )
      fail("转换结果须为普通JSON");
    const array = Array.isArray(value);
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      fail("转换结果原型");
    active.add(value);
    const keys = Reflect.ownKeys(value);
    const entries = [];
    if (array && keys.length !== value.length + 1) fail("转换结果数组不完整");
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        (array && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        fail("转换结果包含访问器或隐藏字段");
      if (descriptor.value === undefined && !array) continue;
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    active.delete(value);
    return array
      ? entries.map(([, child]) => child)
      : Object.fromEntries(
          entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
  };
  const result = visit(input);
  manualImportDigest(result);
  return result;
}

function exact(value, fields) {
  if (!object(value) || Object.keys(value).some((key) => !fields.includes(key)))
    fail("未知字段或对象格式");
}
function identifier(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    forbidden.has(value)
  )
    fail("资源标识");
  return value;
}
function folderPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    value.split("/").length > 30 ||
    value
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || forbidden.has(part),
      )
  )
    fail("目录路径");
  return value;
}
function populated(value) {
  return Array.isArray(value)
    ? value.length > 0
    : object(value)
      ? Object.keys(value).length > 0
      : value !== undefined && value !== null && value !== "";
}

// The pure half takes only detached converter output, not a target project. It
// inventories typed owners and references, never searches arbitrary strings for IDs.
export function buildManualImportSourceGraph(input, context) {
  manualImportID(context, "source-context-validation");
  const instant = new Date(context.issuedAt).toISOString();
  const project = converterCopy(input);
  if (
    !object(project) ||
    Object.keys(project).some((key) => !rootFields.has(key))
  )
    fail("未知项目资源");
  const array = (path) => {
    const value = at(project, path);
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail("资源须为数组");
    return value;
  };
  for (const field of [
    "requests",
    "folders",
    "documents",
    "dictionary",
    "modelFolders",
    "cases",
    "caseFolders",
    "environments",
    "servers",
    "protocols",
    "plans",
  ])
    array([field]);
  if (project.settings !== undefined && !object(project.settings))
    fail("设置须为对象");
  if (
    project.openapiComponents !== undefined &&
    !object(project.openapiComponents)
  )
    fail("组件须为对象");
  if (
    project.openapiComponents?.schemas !== undefined &&
    !object(project.openapiComponents.schemas)
  )
    fail("Schema注册表须为对象");
  const nodes = [],
    byKey = new Map(),
    owners = new Map(),
    identities = new Map();
  const deferred = [],
    schemaRoots = [],
    folders = new Map(),
    dynamicOwners = new Set();
  function add(kind, key, paths) {
    if (byKey.has(key)) fail("来源键重复");
    const node = {
      key,
      kind,
      paths,
      dependencies: [],
      identities: [],
      references: [],
    };
    nodes.push(node);
    byKey.set(key, node);
    for (const path of paths) {
      if (owners.has(pathKey(path))) fail("来源拥有者不唯一");
      owners.set(pathKey(path), node);
    }
    return node;
  }
  function depend(node, target) {
    if (!target) fail("引用目标不存在");
    if (node !== target && !node.dependencies.includes(target.key))
      node.dependencies.push(target.key);
  }
  function identity(
    node,
    kind,
    path,
    { stable = false, key = false, local = false } = {},
  ) {
    const old = identifier(key ? path.at(-1) : at(project, path));
    const id = stable
      ? manualImportID(context, `${node.key}:${kind}:${pathKey(path)}`)
      : old;
    const entry = { kind, id, path: [...path], ...(key ? { key: true } : {}) };
    node.identities.push(entry);
    if (!local) {
      const index = `${kind}\0${old}`;
      if (identities.has(index)) fail("资源标识重复");
      identities.set(index, { node, entry, old });
    }
    if (stable) at(project, path.slice(0, -1))[path.at(-1)] = id;
    return entry;
  }
  function ref(node, kind, path, { key = false, optional = true } = {}) {
    const value = key ? path.at(-1) : at(project, path);
    if (optional && (value === undefined || value === "")) return;
    if (kind === "folder") folderPath(value);
    else identifier(value);
    deferred.push({ node, kind, path: [...path], value, key });
  }
  function schema(node, path, mode = "schema") {
    if (at(project, path) !== undefined) schemaRoots.push({ node, path, mode });
  }
  function request(node, path, snapshot = false) {
    const value = at(project, path);
    if (!object(value)) fail("请求快照");
    if (snapshot)
      identity(node, "request-snapshot", [...path, "id"], {
        stable: true,
        local: true,
      });
    if (
      [
        "beforeScript",
        "afterScript",
        "sharedBeforeScripts",
        "sharedAfterScripts",
        "before",
        "after",
        "nativeTasks",
        "importedScriptTasks",
      ].some((key) => populated(value[key]))
    )
      dynamicOwners.add(node);
    if (value.nativeInheritance !== undefined || value.deletedAt !== undefined)
      fail("不能导入继承图绑定或已删除请求");
    ref(node, "server", [...path, "serviceId"]);
    ref(node, "status", [...path, "statusId"]);
    ref(node, "collection", [...path, "postmanCollectionId"]);
    if (value.folder) ref(node, "folder", [...path, "folder"]);
    for (const key of Object.keys(value.attributes || {}))
      ref(node, "attribute", [...path, "attributes", key], {
        key: true,
        optional: false,
      });
    for (const phase of ["before", "after"])
      for (const [index, task] of (value.nativeTasks?.[phase] || []).entries())
        if (task.type === "database")
          ref(
            node,
            "database",
            [...path, "nativeTasks", phase, index, "data", "connectionId"],
            { optional: false },
          );
    requestSchemaPositions(value, path, (position, mode) =>
      schema(node, position, mode),
    );
  }

  // Materialize implicit ancestor shells, without selecting their descendants.
  const explicitFolders = array(["folders"]);
  if (new Set(explicitFolders).size !== explicitFolders.length)
    fail("目录路径重复");
  const allFolders = new Set(explicitFolders.map(folderPath));
  const addFolder = (path) => {
    if (!path) return;
    folderPath(path);
    const parts = path.split("/");
    for (let count = 1; count <= parts.length; count++)
      allFolders.add(parts.slice(0, count).join("/"));
  };
  for (const path of explicitFolders) addFolder(path);
  for (const group of [
    project.requests,
    project.documents,
    project.protocols,
    project.settings?.socketioDefinitions,
    project.settings?.grpcDefinitions,
  ])
    for (const value of group || []) addFolder(value.folder);
  project.folders = [...allFolders].sort();
  project.folders.forEach((value, index) => {
    const node = add("folder", `folder:${value}`, [["folders", index]]);
    node.id = value;
    folders.set(value, node);
    identities.set(`folder\0${value}`, {
      node,
      entry: { kind: "folder", id: value, path: ["folders", index] },
    });
  });
  for (const [value, node] of folders) {
    const split = value.lastIndexOf("/");
    if (split >= 0) depend(node, folders.get(value.slice(0, split)));
  }

  const primary = (field, kind, stable = false) =>
    array([field]).map((value, index) => {
      if (!object(value)) fail("资源对象");
      const node = add(kind, `${kind}:${field}/${index}`, [[field, index]]);
      node.id = identity(node, kind, [field, index, "id"], {
        stable: typeof stable === "function" ? stable(value) : stable,
      }).id;
      return node;
    });
  const apis = primary("requests", "api", true);
  const operationIds = new Set();
  apis.forEach((node, index) => {
    const operation = project.requests[index].sourceOperationId;
    if (operation) {
      if (operationIds.has(operation)) fail("来源接口标识重复");
      operationIds.add(operation);
    }
    request(node, ["requests", index]);
  });
  primary("documents", "document").forEach((node, index) =>
    ref(node, "folder", ["documents", index, "folder"]),
  );
  primary("modelFolders", "model-folder").forEach((node, index) =>
    ref(node, "model-folder", ["modelFolders", index, "parentId"]),
  );
  const modelByName = new Map(),
    dictionaryIds = new Set();
  const schemas = project.openapiComponents?.schemas || {};
  array(["dictionary"]).forEach((value, index) => {
    const id = identifier(value.id);
    if (dictionaryIds.has(id)) fail("模型标识重复");
    dictionaryIds.add(id);
    if (
      !Object.hasOwn(schemas, id) ||
      !isDeepStrictEqual(value.schema, schemas[id])
    )
      fail("模型与Schema定义不一致");
    const node = add("model", `model:dictionary/${index}`, [
      ["dictionary", index],
      ["openapiComponents", "schemas", id],
    ]);
    node.id = identity(node, "model", ["dictionary", index, "id"]).id;
    node.identities.push({
      kind: "model",
      id,
      path: ["openapiComponents", "schemas", id],
      key: true,
    });
    modelByName.set(id, node);
    ref(node, "model-folder", ["dictionary", index, "folderId"]);
    schema(node, ["dictionary", index, "schema"]);
  });
  for (const name of Object.keys(schemas).sort()) {
    if (forbidden.has(name) || !name) fail("Schema名称无效");
    let node = modelByName.get(name);
    if (!node) {
      node = add("model", `model:components/${pointer(name)}`, [
        ["openapiComponents", "schemas", name],
      ]);
      node.id = identity(
        node,
        "model",
        ["openapiComponents", "schemas", name],
        { key: true },
      ).id;
      modelByName.set(name, node);
    }
    schema(node, ["openapiComponents", "schemas", name]);
  }
  const caseFolders = primary("caseFolders", "case-folder");
  caseFolders.forEach((node, index) => {
    ref(node, "api", ["caseFolders", index, "sourceRequestId"], {
      optional: false,
    });
    ref(node, "case-folder", ["caseFolders", index, "parentId"]);
  });
  const cases = primary("cases", "case");
  cases.forEach((node, index) => {
    const path = ["cases", index];
    ref(node, "api", [...path, "sourceRequestId"], { optional: false });
    ref(node, "case-folder", [...path, "folderId"]);
    request(node, [...path, "request"], true);
    project.cases[index].createdAt = instant;
  });
  const environments = primary(
    "environments",
    "environment",
    (value) => !value.id?.startsWith("apipost-"),
  );
  environments.forEach((node, index) => {
    for (const server of Object.keys(
      project.environments[index].serverUrls || {},
    ))
      ref(node, "server", ["environments", index, "serverUrls", server], {
        key: true,
        optional: false,
      });
  });
  const globalPaths = [];
  for (const field of [
    "servers",
    "globalVariables",
    "globalVariableDefinitions",
  ])
    if (populated(project[field])) globalPaths.push([field]);
  for (const key of Object.keys(project.settings || {}))
    if (
      !protocolSettings.has(key) &&
      key !== "apipostDirectoryArtifacts" &&
      populated(project.settings[key])
    )
      globalPaths.push(["settings", key]);
  for (const key of Object.keys(project.openapiComponents || {}))
    if (key !== "schemas" && populated(project.openapiComponents[key]))
      globalPaths.push(["openapiComponents", key]);
  const globals = globalPaths.length
    ? add("globals", "globals:configuration", globalPaths)
    : null;
  if (globals) {
    for (const field of [
      "folderAuth",
      "folderScripts",
      "folderParameters",
      "folderServices",
    ]) {
      const scoped = project.settings?.[field];
      if (scoped === undefined) continue;
      if (!object(scoped)) fail("目录配置须为对象");
      for (const folder of Object.keys(scoped)) {
        // Value references must be rebound before their owning folder-map key
        // moves. The planner consumes this ordered typed reference inventory.
        if (field === "folderServices")
          ref(globals, "server", ["settings", field, folder], {
            optional: false,
          });
        ref(globals, "folder", ["settings", field, folder], {
          key: true,
          optional: false,
        });
      }
    }
    for (const [field, kind, idField] of [
      ["servers", "server", "id"],
      ["settings.statuses", "status", "id"],
      ["settings.attributes", "attribute", "key"],
      ["settings.apipostDatabases", "database", "id"],
    ])
      array(field.split(".")).forEach((value, index) =>
        identity(globals, kind, [...field.split("."), index, idField]),
      );
    for (const path of globalPaths)
      if (path[0] === "openapiComponents")
        schema(
          globals,
          path,
          referenceChildMode("components", path[1], at(project, path)),
        );
  }
  const protocolPaths = [];
  if (project.protocols?.length) protocolPaths.push(["protocols"]);
  for (const key of protocolSettings)
    if (project.settings?.[key]?.length) protocolPaths.push(["settings", key]);
  const protocols = protocolPaths.length
    ? add("protocol-bundle", "protocol-bundle:definitions", protocolPaths)
    : null;
  if (protocols) {
    for (const [path, kind] of [
      [["protocols"], "protocol"],
      [["settings", "socketioDefinitions"], "socketio"],
      [["settings", "grpcDefinitions"], "grpc"],
      [["settings", "apipostProtocolSources"], "protocol-source"],
    ])
      array(path).forEach((value, index) => {
        identity(protocols, kind, [...path, index, "id"]);
        if (kind !== "protocol-source")
          ref(protocols, "folder", [...path, index, "folder"]);
      });
  }
  const plans = project.plans?.length
    ? add("plan-bundle", "plan-bundle:plans", [["plans"]])
    : null;
  if (plans) {
    const walk = (items, path, seen) =>
      items.forEach((step, index) => {
        const stepPath = [...path, index];
        if (seen.has(step.id)) fail("计划步骤标识重复");
        seen.add(step.id);
        identity(plans, "plan-step", [...stepPath, "id"], { local: true });
        if (step.steps) {
          if (
            !["repeat", "if"].includes(step.type) ||
            !Array.isArray(step.steps)
          )
            fail("计划组类型");
          walk(step.steps, [...stepPath, "steps"], seen);
        } else if (step.request) {
          request(plans, [...stepPath, "request"], true);
          if (step.liveRequestId !== undefined)
            ref(plans, "api", [...stepPath, "liveRequestId"], {
              optional: false,
            });
          if (step.nativeMCP !== undefined)
            fail("手动导入不支持额外live MCP计划绑定");
        } else {
          const kind = {
            protocol: "protocol",
            socketio: "socketio",
            grpc: "grpc",
          }[step.type];
          if (!kind || !object(step[kind]?.definition)) fail("计划步骤类型");
          // Frozen definitions are snapshots, not an authorization to overwrite a live owner.
          identity(
            plans,
            `${kind}-snapshot`,
            [...stepPath, kind, "definition", "id"],
            { local: true },
          );
          if (step[kind].definition.folder)
            ref(plans, "folder", [...stepPath, kind, "definition", "folder"]);
        }
      });
    project.plans.forEach((plan, index) => {
      identity(plans, "plan", ["plans", index, "id"]);
      ref(plans, "environment", ["plans", index, "environmentId"]);
      if (!Array.isArray(plan.steps)) fail("计划步骤数组");
      walk(plan.steps, ["plans", index, "steps"], new Set());
      plan.createdAt = instant;
      plan.updatedAt = instant;
    });
    if (protocols) depend(plans, protocols);
  }
  let collections = null;
  if (project.postmanCollections !== undefined) {
    exact(project.postmanCollections, ["version", "items"]);
    if (project.postmanCollections.version !== 1) fail("collection版本");
    const items = array(["postmanCollections", "items"]);
    if (items.length) {
      collections = add("collection-bundle", "collection-bundle:registry", [
        ["postmanCollections"],
      ]);
      items.forEach((value, index) =>
        identity(
          collections,
          "collection",
          ["postmanCollections", "items", index, "id"],
          { stable: true },
        ),
      );
    }
  }
  if (project.settings?.apipostDirectoryArtifacts?.length)
    add("artifacts", "artifacts:directory", [
      ["settings", "apipostDirectoryArtifacts"],
    ]);

  // Resolve only typed owner fields. Literal IDs, native source evidence, script
  // strings, body/example payloads, and archived flows are deliberately untouched.
  for (const { node, kind, path, value, key } of deferred) {
    const target = identities.get(`${kind}\0${value}`);
    if (!target) fail("引用目标不存在或类型不匹配");
    depend(node, target.node);
    const newPath = [...path];
    if (key && target.entry.id !== value) {
      const container = at(project, path.slice(0, -1));
      if (Object.hasOwn(container, target.entry.id)) fail("引用键重绑冲突");
      container[target.entry.id] = container[value];
      delete container[value];
      newPath[newPath.length - 1] = target.entry.id;
    } else if (!key)
      at(project, path.slice(0, -1))[path.at(-1)] = target.entry.id;
    node.references.push({
      path: newPath,
      targetKey: target.node.key,
      targetId: target.entry.id,
      identityKind: kind,
      kind,
      targetPath: target.entry.path,
      ...(key ? { key: true } : {}),
    });
  }
  // Directory ancestry rejects cycles; schema-reference cycles are intentionally legal.
  for (const [field, ownKind] of [
    ["modelFolders", "model-folder"],
    ["caseFolders", "case-folder"],
  ]) {
    const rows = array([field]),
      byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      const seen = new Set([row.id]);
      let parent = row.parentId;
      while (parent) {
        if (seen.has(parent) || seen.size > 30) fail("目录父引用成环或过深");
        seen.add(parent);
        const previous = byId.get(parent);
        if (
          !previous ||
          (ownKind === "case-folder" &&
            previous.sourceRequestId !== row.sourceRequestId)
        )
          fail("目录父引用不存在或跨接口");
        parent = previous.parentId;
      }
    }
  }
  for (const value of project.cases || []) {
    const group = (project.caseFolders || []).find(
      (entry) => entry.id === value.folderId,
    );
    if (group && group.sourceRequestId !== value.sourceRequestId)
      fail("用例分组跨接口");
  }

  function parts(ref) {
    if (typeof ref !== "string" || !ref.startsWith("#"))
      fail("仅支持可定位的本地Schema引用");
    let decoded;
    try {
      decoded = decodeURIComponent(ref.slice(1));
    } catch {
      fail("Schema引用编码");
    }
    if (decoded === "") return [];
    if (!decoded.startsWith("/")) fail("Schema锚点尚不能定位");
    return decoded
      .slice(1)
      .split("/")
      .map((part) => {
        if (/~(?:[^01]|$)/.test(part)) fail("Schema引用转义");
        const value = part.replaceAll("~1", "/").replaceAll("~0", "~");
        if (forbidden.has(value)) fail("Schema引用路径");
        return value;
      });
  }
  function locate(root, segments, mode) {
    let current = root;
    for (const segment of segments) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
      )
        fail("Schema引用不存在");
      const child = current[segment];
      mode = referenceChildMode(mode, segment, child);
      current = child;
    }
    if (
      !referenceModeIsAllowed(mode) ||
      (mode === "schema"
        ? typeof current !== "boolean" && !object(current)
        : !object(current))
    )
      fail("引用目标不是声明位置");
    return { mode, current };
  }
  let visited = 0;
  for (const root of schemaRoots) {
    const rootValue = at(project, root.path);
    const visit = (value, path, mode, depth = 0) => {
      if (mode === "literal") return;
      if (++visited > 100000 || depth > 50) fail("Schema引用图过大");
      if (!value || typeof value !== "object") return;
      rejectUnprovenSemanticReferences(value, mode);
      if (
        mode === "schema" &&
        [
          "$id",
          "$anchor",
          "$dynamicAnchor",
          "$dynamicRef",
          "$recursiveRef",
          "$recursiveAnchor",
        ].some((key) => populated(value[key]))
      )
        fail("尚不支持改变Schema引用作用域或动态引用");
      if (referenceModeIsAllowed(mode) && Object.hasOwn(value, "$ref")) {
        const segments = parts(value.$ref);
        if (segments[0] === "components") {
          const located = locate(
            { components: project.openapiComponents || {} },
            segments,
            "document",
          );
          if (located.mode !== mode) fail("引用目标声明类型不匹配");
          const target =
            segments[1] === "schemas" ? modelByName.get(segments[2]) : globals;
          if (!target || segments.length < 3) fail("组件引用拥有者不存在");
          depend(root.node, target);
          root.node.references.push({
            path: [...path, "$ref"],
            targetKey: target.key,
            targetId: segments[1] === "schemas" ? target.id : segments[2],
            identityKind: segments[1] === "schemas" ? "model" : "component",
            kind: segments[1] === "schemas" ? "schema" : "component",
            suffix:
              segments.length > 3
                ? "/" + segments.slice(3).map(pointer).join("/")
                : "",
          });
        } else {
          const located = locate(rootValue, segments, root.mode);
          if (located.mode !== mode) fail("引用目标声明类型不匹配");
        }
      }
      for (const [key, child] of Object.entries(value))
        visit(
          child,
          [...path, Array.isArray(value) ? Number(key) : key],
          referenceChildMode(mode, key, child),
          depth + 1,
        );
    };
    visit(rootValue, root.path, root.mode);
  }
  // Dynamic scripts/functions use a bounded conservative configuration dependency.
  const dynamicConfiguration =
    project.settings?.functions?.length ||
    populated(project.settings?.globalScripts) ||
    populated(project.settings?.folderScripts) ||
    globalPaths.some((path) =>
      JSON.stringify(at(project, path)).includes("{{"),
    );
  for (const node of nodes.filter((entry) =>
    ["api", "case", "plan-bundle", "protocol-bundle"].includes(entry.kind),
  )) {
    if (globals) depend(node, globals);
    const values = node.paths.map((path) => at(project, path));
    if (
      JSON.stringify(values).includes("{{") ||
      dynamicOwners.has(node) ||
      dynamicConfiguration ||
      values.some((value) => value?.functions?.length)
    )
      for (const environment of environments) depend(node, environment);
  }
  for (const node of nodes) {
    node.dependencies.sort();
    if (node.kind === "model") {
      const dictionaryPath = node.paths.find(
        (path) => path[0] === "dictionary",
      );
      const schemaPath = node.paths.find(
        (path) => path[0] === "openapiComponents",
      );
      const dictionary = dictionaryPath
        ? at(project, dictionaryPath)
        : undefined;
      node.value = {
        name: dictionary?.name ?? schemaPath.at(-1),
        schemaName: schemaPath.at(-1),
        schema: at(project, schemaPath),
        ...(dictionary ? { dictionary } : {}),
      };
    } else if (
      [
        "globals",
        "protocol-bundle",
        "plan-bundle",
        "collection-bundle",
        "artifacts",
      ].includes(node.kind)
    ) {
      const bundle = {};
      for (const path of node.paths) {
        let owner = bundle;
        path.slice(0, -1).forEach((part) => {
          if (!Object.hasOwn(owner, part))
            Object.defineProperty(owner, part, {
              value: {},
              writable: true,
              configurable: true,
              enumerable: true,
            });
          owner = owner[part];
        });
        Object.defineProperty(owner, path.at(-1), {
          value: at(project, path),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      node.value = bundle;
    } else node.value = at(project, node.paths[0]);
  }
  // The source graph itself is bounded ordinary JSON and does not leak aliases to input.
  manualImportDigest(project);
  return { project, nodes };
}

// These are semantic references, not ordinary JSON Schema $ref fields. Until
// explicit and implicit discriminator/operation-name closure is representable,
// fail closed only at their real declaration positions, never in literal data.
function rejectUnprovenSemanticReferences(value, mode) {
  if (mode === "schema" && populated(value.discriminator))
    fail("尚不支持Schema discriminator身份绑定");
  if (
    mode === "link" &&
    ["operationId", "operationRef"].some((key) => populated(value[key]))
  )
    fail("尚不支持OpenAPI Link操作引用");
}

function requestSchemaPositions(value, path, emit) {
  emit([...path, "schema"], "schema");
  for (const group of ["query", "headers", "path", "cookies", "form"])
    for (const [index] of (value[group] || []).entries())
      emit([...path, group, index], "parameter");
  for (const [index] of (value.responses || []).entries())
    emit([...path, "responses", index], "response");
  for (const [index] of (value.examples || []).entries())
    emit([...path, "examples", index, "schema"], "schema");
  emit([...path, "openapiOperation"], "operation");
  emit([...path, "nativeMock", "fallback", "schema"], "schema");
  for (const [index] of (value.nativeMock?.rules || []).entries())
    emit(
      [...path, "nativeMock", "rules", index, "response", "schema"],
      "schema",
    );
}

// Reverse-reference guard for the planner. Only current definitions are scanned:
// execution runs, trash, definition history and inert source archives are not owners.
export function collectManualImportModelReferences(project) {
  const roots = [],
    result = [];
  const add = (ownerKind, ownerId, path, mode = "schema") => {
    if (at(project, path) !== undefined)
      roots.push({ ownerKind, ownerId, path, mode });
  };
  const request = (value, path, ownerKind, ownerId) =>
    requestSchemaPositions(value, path, (position, mode) =>
      add(ownerKind, ownerId, position, mode),
    );
  for (const [index, value] of (project.requests || []).entries())
    if (!value.deletedAt) request(value, ["requests", index], "api", value.id);
  for (const [index, value] of (project.cases || []).entries())
    request(value.request, ["cases", index, "request"], "case", value.id);
  for (const [index, value] of (project.dictionary || []).entries())
    add("model", value.id, ["dictionary", index, "schema"]);
  for (const [name] of Object.entries(project.openapiComponents?.schemas || {}))
    add("model", name, ["openapiComponents", "schemas", name]);
  for (const [category] of Object.entries(project.openapiComponents || {}))
    if (category !== "schemas")
      add(
        "globals",
        "configuration",
        ["openapiComponents", category],
        referenceChildMode(
          "components",
          category,
          project.openapiComponents[category],
        ),
      );
  for (const [index, plan] of (project.plans || []).entries()) {
    const walk = (steps, path, depth = 0) => {
      if (depth > 32) fail("计划深度");
      for (const [stepIndex, step] of steps.entries()) {
        const stepPath = [...path, stepIndex];
        if (step.request)
          request(step.request, [...stepPath, "request"], "plan", plan.id);
        if (step.nativeMCP?.baseRequest)
          request(
            step.nativeMCP.baseRequest,
            [...stepPath, "nativeMCP", "baseRequest"],
            "plan",
            plan.id,
          );
        if (step.steps) walk(step.steps, [...stepPath, "steps"], depth + 1);
      }
    };
    walk(plan.steps || [], ["plans", index, "steps"]);
  }
  let visited = 0;
  for (const root of roots) {
    const walk = (value, path, mode, depth = 0) => {
      if (mode === "literal") return;
      if (++visited > 100000 || depth > 50) fail("Schema引用图过大");
      if (!value || typeof value !== "object") return;
      rejectUnprovenSemanticReferences(value, mode);
      if (
        mode === "schema" &&
        [
          "$dynamicRef",
          "$recursiveRef",
          "$id",
          "$anchor",
          "$dynamicAnchor",
          "$recursiveAnchor",
        ].some((key) => populated(value[key]))
      )
        fail("目标Schema引用作用域不能证明");
      if (mode === "schema" && Object.hasOwn(value, "$ref")) {
        if (typeof value.$ref !== "string") fail("目标Schema引用格式");
        let decoded;
        try {
          decoded = decodeURIComponent(value.$ref);
        } catch {
          fail("目标Schema引用编码");
        }
        const segments = decoded.split("/");
        if (
          segments[0] === "#" &&
          segments[1] === "components" &&
          segments[2] === "schemas"
        ) {
          if (!segments[3] || /~(?:[^01]|$)/.test(segments[3]))
            fail("目标Schema引用名称");
          const modelId = segments[3]
            .replaceAll("~1", "/")
            .replaceAll("~0", "~");
          if (forbidden.has(modelId)) fail("目标Schema引用名称");
          result.push({
            modelId,
            path: [...path, "$ref"],
            ownerKind: root.ownerKind,
            ownerId: root.ownerId,
          });
        }
      }
      for (const [key, child] of Object.entries(value))
        walk(
          child,
          [...path, Array.isArray(value) ? Number(key) : key],
          referenceChildMode(mode, key, child),
          depth + 1,
        );
    };
    walk(at(project, root.path), root.path, root.mode);
  }
  return result;
}

export async function prepareManualImportSource(input, context) {
  const checked = ordinaryCopy(input);
  exact(checked, ["format", "document", "options"]);
  if (
    !["auto", "apipost", "apipost-directory", "openapi"].includes(
      checked.format,
    ) ||
    !Object.hasOwn(checked, "document")
  )
    fail("format/document");
  const options = checked.options ?? {};
  exact(options, ["modelNameMode", "postmanVariableMode"]);
  if (
    options.modelNameMode !== undefined &&
    !["namespaced", "preserve"].includes(options.modelNameMode)
  )
    fail("modelNameMode");
  if (
    options.postmanVariableMode !== undefined &&
    !["environment", "collection"].includes(options.postmanVariableMode)
  )
    fail("postmanVariableMode");
  manualImportID(context, "source-context-validation");
  let document = checked.document;
  if (typeof document === "string") {
    const { parseImportDocumentText } = await import(
      "./import-document-parser.mjs"
    );
    document = ordinaryCopy(parseImportDocumentText(document));
  }
  if (!object(document)) fail("文档须为JSON/YAML对象");
  const directory = document.format === "apipost-offline-directory-v1";
  const openapi = Boolean(document.openapi || document.swagger);
  const apipost =
    !openapi &&
    !directory &&
    (Array.isArray(document.apis) ||
      (document.status === "success" && Array.isArray(document.data?.apis)));
  if (
    (checked.format === "apipost-directory" && !directory) ||
    (checked.format === "openapi" && !openapi) ||
    (checked.format === "apipost" && !apipost)
  )
    fail("声明格式与文档不一致");
  const payload =
    apipost && document.status === "success" ? document.data : document;
  if (populated(payload.automated_testings))
    fail("不支持非空automated_testings");
  const modern =
    apipost &&
    (object(payload.global) ||
      ["models", "samples", "automated_testings"].some((key) =>
        Object.hasOwn(payload, key),
      ));
  // Modern unknown test_cases remains the converter's fail-closed decision. Do
  // not reinterpret it as samples. Other converters would ignore the field.
  if (!modern && populated(payload.test_cases)) fail("未知非空test_cases");
  if (apipost) {
    if (document !== payload) exact(document, ["status", "message", "data"]);
    exact(
      payload,
      modern
        ? [
            "project_id",
            "name",
            "intro",
            "global",
            "apis",
            "models",
            "samples",
            "automated_testings",
            "test_cases",
          ]
        : ["project_id", "project", "apis", "env", "dataModel", "test_cases"],
    );
  }
  if (
    !directory &&
    !openapi &&
    !apipost &&
    !(document.info && Array.isArray(document.item)) &&
    !Array.isArray(document.requests)
  )
    fail("无法识别文档格式");
  if (Array.isArray(document.requests)) exact(document, ["requests"]);
  const { importIntoProject } = await import("./core.mjs");
  const source = {
    requests: [],
    folders: [],
    documents: [],
    dictionary: [],
    cases: [],
    plans: [],
    environments: [],
    servers: [],
    globalVariables: {},
    settings: {},
  };
  importIntoProject(source, document, options);
  return buildManualImportSourceGraph(source, context);
}
