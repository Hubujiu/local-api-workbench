import { isDeepStrictEqual } from "node:util";
import { validateResourceJSON } from "./api-resource-lifecycle.mjs";
import { apipostResourceFactory } from "./apipost-modern.mjs";
import { prepareNativeProtocols } from "./apipost-native-protocols.mjs";

const same = (a, b) =>
  isDeepStrictEqual(
    JSON.parse(JSON.stringify(a)),
    JSON.parse(JSON.stringify(b)),
  );
const fail = (reason) => {
  throw Error("原生协议导出不能无损保留" + reason + "；请使用项目备份");
};

// A source archive is inert provenance, never authority to resurrect a deleted
// definition or to reconstruct stripped handshake credentials. This first slice
// deliberately requires an exact, complete TCP/SSE source-backed graph.
export function prepareProtocolExport(project, { projectId, id }) {
  const definitions = project.protocols ?? [],
    sources = project.settings?.apipostProtocolSources ?? [];
  if (
    !Array.isArray(definitions) ||
    !Array.isArray(sources) ||
    definitions.length > 1000 ||
    sources.length > 1000
  )
    fail("资源列表");
  // normalizeProtocol intentionally leaves port:undefined on non-TCP values
  // before persistence; omit only own undefined data fields, never invoke getters.
  const cleanDefinitions = definitions.map((definition) => {
    if (
      !definition ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(definition))
    )
      fail("定义对象");
    const clean = {};
    for (const key of Reflect.ownKeys(definition)) {
      const field = Object.getOwnPropertyDescriptor(definition, key);
      if (typeof key !== "string" || !field.enumerable || !("value" in field))
        fail("定义属性");
      if (field.value === undefined && key !== "port") fail("未定义的额外字段");
      if (field.value !== undefined)
        Object.defineProperty(clean, key, {
          value: field.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return clean;
  });
  validateResourceJSON(cleanDefinitions);
  validateResourceJSON(sources);
  if (
    !Array.isArray(definitions) ||
    !Array.isArray(sources) ||
    definitions.length > 1000 ||
    sources.length > 1000
  )
    fail("资源列表");
  if (!definitions.length && !sources.length)
    return { folders: new Map(), emit: () => [] };
  const byId = new Map();
  for (const d of cleanDefinitions) {
    if (!d?.id || byId.has(d.id)) fail("重复定义身份");
    byId.set(d.id, d);
  }
  const groups = new Map(),
    covered = new Set(),
    containers = new Map(),
    output = [];
  for (const entry of sources) {
    if (
      !entry ||
      Object.keys(entry).some(
        (k) =>
          ![
            "id",
            "sourceProjectId",
            "sourceTargetId",
            "source",
            "notes",
          ].includes(k),
      ) ||
      typeof entry.sourceProjectId !== "string" ||
      typeof entry.sourceTargetId !== "string"
    )
      fail("来源身份");
    const resource = apipostResourceFactory(entry.sourceProjectId);
    if (
      entry.id !== resource("protocol-source", entry.sourceTargetId) ||
      entry.source?.target_id !== entry.sourceTargetId ||
      (entry.source.project_id !== undefined &&
        entry.source.project_id !== entry.sourceProjectId)
    )
      fail("来源身份");
    if (!["socket", "socket_method", "sse"].includes(entry.source.target_type))
      fail("WS/扩展协议尚未证明的反向配置");
    if (entry.source.mark_id) fail("协议状态引用");
    const group = groups.get(entry.sourceProjectId) ?? new Map();
    if (group.has(entry.sourceTargetId)) fail("重复来源");
    group.set(entry.sourceTargetId, entry);
    groups.set(entry.sourceProjectId, group);
  }
  for (const [sourceProjectId, entries] of groups) {
    const resource = apipostResourceFactory(sourceProjectId),
      nodes = [...entries.values()].map((e) => structuredClone(e.source)),
      paths = new Map(),
      parents = new Map();
    for (const node of nodes) {
      if (node.target_type === "socket") continue;
      const defId = resource("protocol", node.target_id),
        definition = byId.get(defId);
      if (!definition || covered.has(defId)) fail("缺失/重用的活动定义");
      covered.add(defId);
      if (definition.handshake?.requiredHeaders?.length)
        fail("已移除的运行时握手凭据");
      for (const kind of ["header", "cookie"])
        for (const row of node.request?.[kind]?.parameter ?? [])
          if (!Object.hasOwn(row, "value")) fail("已移除的握手来源值");
      if (node.target_type === "sse")
        paths.set(node.target_id, definition.folder || "");
      else {
        const parent = entries.get(node.parent_id)?.source;
        if (
          parent?.target_type !== "socket" ||
          !parent.name ||
          parent.name.includes("/")
        )
          fail("TCP父容器");
        const folder = definition.folder || "",
          suffix = "/" + parent.name;
        if (folder !== parent.name && !folder.endsWith(suffix))
          fail("TCP容器目录关系");
        const parentFolder =
          folder === parent.name ? "" : folder.slice(0, -suffix.length);
        if (
          paths.has(parent.target_id) &&
          paths.get(parent.target_id) !== parentFolder
        )
          fail("TCP容器拆组");
        paths.set(parent.target_id, parentFolder);
        paths.set(node.target_id, folder);
      }
    }
    for (const node of nodes) {
      if (!paths.has(node.target_id)) fail("孤立TCP容器");
      const folder = paths.get(node.target_id),
        parent = node.parent_id;
      if (folder && !(project.folders || []).includes(folder))
        fail("当前父目录缺失");
      if (!parent || parent === "0") {
        if (folder) fail("来源根目录已移动");
      } else if (entries.has(parent)) {
        const p = entries.get(parent).source;
        if (
          p.target_type !== "socket" ||
          folder !== [paths.get(parent), p.name].filter(Boolean).join("/")
        )
          fail("父容器关联");
      } else {
        if (!folder || (parents.has(parent) && parents.get(parent) !== folder))
          fail("来源父目录关联");
        parents.set(parent, folder);
      }
    }
    // Normal source folders are not archived. Rebuild only their already-known
    // canonical paths, anchored to the exact recorded parent ID, never namesplit
    // from a protocol display name. Reimport is the final graph oracle.
    const folders = [],
      occupied = new Set(entries.keys()),
      folderIds = new Map();
    for (const [parent, folder] of parents) {
      if (folderIds.has(folder) && folderIds.get(folder) !== parent)
        fail("歧义父目录身份");
      folderIds.set(folder, parent);
    }
    for (const [parent, folder] of parents) {
      const parts = folder.split("/");
      let ancestor = "0",
        current = "";
      for (let i = 0; i < parts.length; i++) {
        current = [current, parts[i]].filter(Boolean).join("/");
        const folderId =
          folderIds.get(current) ??
          (i === parts.length - 1
            ? parent
            : "export-folder-" + id("f", current));
        if (occupied.has(folderId)) fail("父目录ID冲突");
        if (folderIds.has(current) && folderIds.get(current) !== folderId)
          fail("歧义父目录身份");
        if (!folders.some((f) => f.target_id === folderId))
          folders.push({
            target_id: folderId,
            target_type: "folder",
            name: parts[i],
            parent_id: ancestor,
            request: {},
          });
        folderIds.set(current, folderId);
        ancestor = folderId;
      }
    }
    const converted = prepareNativeProtocols(
      {
        project_id: sourceProjectId,
        apis: [...folders, ...nodes],
        global: { global_param: {} },
      },
      resource,
    );
    for (const d of converted.protocols)
      if (!same(d, byId.get(d.id))) fail("修改后的定义/模板/时限/名称");
    for (const entry of converted.sources)
      if (!same(entry, entries.get(entry.sourceTargetId)))
        fail("来源说明或惰性元数据");
    for (const node of nodes) {
      const full = [paths.get(node.target_id), node.name]
        .filter(Boolean)
        .join("/");
      const targetId = id("p", sourceProjectId + "\0" + node.target_id);
      if (node.target_type === "socket") {
        if (containers.has(full) || !(project.folders || []).includes(full))
          fail("TCP目录碰撞或删除");
        containers.set(full, targetId);
      }
      output.push({
        node,
        targetId,
        folder: paths.get(node.target_id),
        sourceProjectId,
      });
    }
  }
  if (covered.size !== definitions.length) fail("无来源或额外的活动协议");
  return {
    folders: containers,
    emit(folder) {
      return output.map(({ node, targetId, folder: parentPath }) => ({
        ...node,
        project_id: projectId,
        target_id: targetId,
        parent_id: folder(parentPath),
      }));
    },
  };
}

export function verifyProtocolDefinitions(before, after) {
  // Compare complete nested JSON data, not a replacer list that could hide
  // nested handshake fields.
  const remaining = [...(after ?? [])];
  for (const original of before ?? []) {
    const { id, ...left } = original;
    const index = remaining.findIndex(({ id: otherId, ...right }) =>
      same(left, right),
    );
    if (index < 0) fail("定义回读差异");
    remaining.splice(index, 1);
  }
  if (remaining.length) fail("额外回读定义");
}
export function verifyProtocolDocument(project, document) {
  const converted = prepareNativeProtocols(
    document,
    apipostResourceFactory(document.project_id),
  );
  verifyProtocolDefinitions(project.protocols, converted.protocols);
}
