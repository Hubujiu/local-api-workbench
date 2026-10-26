import { randomUUID } from "node:crypto";
import { validateFolderParameters } from "../public/global-parameters.js";
import { validateSharedAuthSettings } from "../public/shared-auth.js";
import { validateSharedScriptSettings } from "../public/shared-scripts.js";

export const folderSettingKeys = [
  "folderParameters",
  "folderAuth",
  "folderScripts",
  "folderServices",
];
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const within = (path, root) => path === root || path.startsWith(root + "/");
const fail = (label) => {
  throw Error("资源回收批次无效：" + label);
};
function keys(value, allowed, label) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(label);
}
function text(value, label, max = 200, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max ||
    !value.isWellFormed() ||
    /\0/.test(value)
  )
    fail(label);
}
// Check descriptors before reading values, cloning or JSON serialization.
export function validateResourceJSON(value, maxBytes = 4 * 1024 * 1024) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 100000 || depth > 40) fail("结构超限");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      if (!item.isWellFormed() || item.length > maxBytes) fail("文本超限");
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item))
      fail("仅接受有限JSON数据");
    if (
      !(
        Array.isArray(item) ? [Array.prototype] : [Object.prototype, null]
      ).includes(Object.getPrototypeOf(item))
    )
      fail("对象原型");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"))
      fail("符号字段");
    if (Array.isArray(item)) {
      if (
        item.length > 10000 ||
        Object.keys(item).length !== item.length ||
        Object.keys(item).some(
          (key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length,
        )
      )
        fail("数组超限、稀疏或含附加属性");
      for (let index = 0; index < item.length; index++)
        if (!own(item, index)) fail("稀疏数组");
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        !own(descriptor, "value") ||
        !descriptor.enumerable
      )
        fail("不安全字段或访问器");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail("总计最多4MiB");
}
export function validateResourceFolder(path) {
  text(path, "目录路径", 500);
  if (
    /[\r\n]/.test(path) ||
    path.split("/").length > 30 ||
    path
      .split("/")
      .some(
        (part) =>
          !part.trim() ||
          [".", "..", "__proto__", "prototype", "constructor"].includes(part),
      )
  )
    fail("目录路径");
}
export function validateResourceDocument(document) {
  keys(
    document,
    [
      "id",
      "title",
      "content",
      "folder",
      "statusId",
      "attributes",
      "importNotes",
      "apipostSource",
      "deletedAt",
    ],
    "文档字段",
  );
  text(document.id, "文档ID");
  if (document.id === "0" || document.id.startsWith("folder:"))
    fail("文档ID占用保留命名空间");
  text(document.title, "文档标题", 500, true);
  text(document.content, "文档正文", 1024 * 1024, true);
  if (document.folder) validateResourceFolder(document.folder);
  else if (document.folder !== undefined && document.folder !== "")
    fail("文档目录");
  if (document.statusId !== undefined)
    text(document.statusId, "文档状态", 200, true);
  if (document.attributes !== undefined && !object(document.attributes))
    fail("文档属性");
  if (
    document.importNotes !== undefined &&
    (!Array.isArray(document.importNotes) ||
      document.importNotes.some((note) => typeof note !== "string"))
  )
    fail("文档说明");
  if (document.apipostSource !== undefined && !object(document.apipostSource))
    fail("文档来源");
}
function uniqueStrings(values, label, max = 5000, length = 700) {
  if (
    !Array.isArray(values) ||
    values.length > max ||
    new Set(values).size !== values.length
  )
    fail(label);
  for (const value of values) text(value, label, length);
}
function validateFolderSettings(settings, paths) {
  keys(settings, folderSettingKeys, "目录设置");
  validateFolderParameters(settings.folderParameters);
  validateSharedAuthSettings(settings);
  validateSharedScriptSettings(settings);
  for (const [kind, map] of Object.entries(settings)) {
    if (!object(map) || Object.keys(map).length > 1000) fail("目录设置映射");
    for (const [path, value] of Object.entries(map)) {
      validateResourceFolder(path);
      if (!paths.has(path)) fail("目录设置不属于删除范围");
      if (kind === "folderServices") text(value, "目录服务ID");
    }
  }
}
export function validateAPIResourceTrash(project) {
  const descriptor = Object.getOwnPropertyDescriptor(
    project,
    "apiResourceTrash",
  );
  if (descriptor && !own(descriptor, "value")) fail("回收字段访问器");
  const trash = descriptor?.value;
  if (trash === undefined) return;
  validateResourceJSON(trash);
  keys(trash, ["version", "batches"], "顶层字段");
  if (
    trash.version !== 1 ||
    !Array.isArray(trash.batches) ||
    trash.batches.length > 100
  )
    fail("版本或容量（最多100批）");
  const batchIds = new Set(),
    documentIds = new Set();
  let total = 0;
  for (const batch of trash.batches) {
    keys(
      batch,
      [
        "id",
        "deletedAt",
        "selectedTargetIds",
        "folderPaths",
        "explicitFolders",
        "requestIds",
        "documents",
        "folderSettings",
      ],
      "批次字段",
    );
    text(batch.id, "批次ID");
    if (batchIds.has(batch.id)) fail("重复批次");
    batchIds.add(batch.id);
    if (
      typeof batch.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(batch.deletedAt)) ||
      new Date(batch.deletedAt).toISOString() !== batch.deletedAt
    )
      fail("删除时间");
    uniqueStrings(batch.selectedTargetIds, "选中ID", 1000);
    if (!batch.selectedTargetIds.length) fail("空批次");
    uniqueStrings(batch.folderPaths, "目录");
    uniqueStrings(batch.explicitFolders, "显式目录");
    const paths = new Set(batch.folderPaths);
    for (const path of paths) validateResourceFolder(path);
    if (batch.explicitFolders.some((path) => !paths.has(path)))
      fail("显式目录不属于批次");
    uniqueStrings(batch.requestIds, "HTTP接口ID", 5000, 200);
    for (const id of batch.requestIds) {
      const matches = (project.requests || []).filter(
        (request) => request.id === id,
      );
      // A historical association, not a lock on the existing HTTP trash UI.
      // HTTP resources may be restored and deleted again without losing the
      // document bodies or folder declarations retained in earlier batches.
      if (
        id === "0" ||
        id.startsWith("folder:") ||
        matches.length > 1 ||
        [...(project.documents || []), ...(project.protocols || [])].some(
          (item) => item.id === id,
        )
      )
        fail("HTTP历史引用ID冲突");
    }
    if (!Array.isArray(batch.documents) || batch.documents.length > 5000)
      fail("文档数量");
    for (const document of batch.documents) {
      validateResourceDocument(document);
      if (
        documentIds.has(document.id) ||
        [
          ...(project.documents || []),
          ...(project.requests || []),
          ...(project.protocols || []),
        ].some((item) => item.id === document.id)
      )
        fail("文档墓碑ID冲突");
      documentIds.add(document.id);
    }
    const targets = new Set([
      ...batch.requestIds,
      ...batch.documents.map((document) => document.id),
      ...batch.folderPaths.map((path) => "folder:" + path),
    ]);
    if (batch.selectedTargetIds.some((id) => !targets.has(id)))
      fail("选中ID不属于批次");
    validateFolderSettings(batch.folderSettings, paths);
    total +=
      batch.requestIds.length +
      batch.documents.length +
      batch.folderPaths.length;
  }
  if (total > 10000) fail("回收资源总数最多10000项；请先备份，不会自动淘汰");
}
export function activeAPIFolders(project) {
  const paths = [
    ...(project.folders || []),
    ...(project.requests || [])
      .filter((item) => !item.deletedAt)
      .map((item) => item.folder),
    ...(project.documents || [])
      .filter((item) => !item.deletedAt)
      .map((item) => item.folder),
    ...(project.protocols || []).map((item) => item.folder),
    ...folderSettingKeys.flatMap((key) =>
      Object.keys(project.settings?.[key] || {}),
    ),
  ].filter(Boolean);
  const result = new Set();
  for (const path of paths) {
    if (typeof path !== "string") fail("目录必须为文本");
    const parts = path.split("/");
    parts.forEach((_, index) =>
      result.add(parts.slice(0, index + 1).join("/")),
    );
  }
  return [...result];
}
export function apiResourceTargets(project) {
  const targets = new Map();
  const entityIds = new Set();
  for (const item of [
    ...(project.requests || []),
    ...(project.documents || []),
    ...(project.protocols || []),
    ...(project.settings?.socketioDefinitions || []),
    ...(project.settings?.grpcDefinitions || []),
  ]) {
    text(item.id, "资源ID");
    if (
      item.id === "0" ||
      item.id.startsWith("folder:") ||
      entityIds.has(item.id)
    )
      fail("资源ID冲突或占用保留命名空间（含已删除HTTP资源）");
    entityIds.add(item.id);
  }
  const add = (id, value) => {
    text(id, "资源ID", 700);
    if (targets.has(id)) fail("资源ID冲突");
    targets.set(id, value);
  };
  for (const path of activeAPIFolders(project))
    add("folder:" + path, { type: "folder", path });
  for (const request of project.requests || [])
    if (!request.deletedAt) add(request.id, { type: "api", value: request });
  for (const document of project.documents || [])
    if (!document.deletedAt) add(document.id, { type: "doc", value: document });
  return targets;
}
export function deleteAPIResources(project, selectedTargetIds) {
  validateAPIResourceTrash(project);
  uniqueStrings(selectedTargetIds, "选中ID", 1000);
  if (!selectedTargetIds.length) fail("请选择资源");
  if ((project.apiResourceTrash?.batches.length || 0) >= 100)
    fail("回收容量已满；请先备份，不会自动淘汰");
  const targets = apiResourceTargets(project);
  for (const id of selectedTargetIds)
    if (id === "0" || !targets.has(id)) fail("资源不存在或不属于当前项目");
  const roots = selectedTargetIds
    .map((id) => targets.get(id))
    .filter((item) => item.type === "folder")
    .map((item) => item.path);
  for (const root of roots) validateResourceFolder(root);
  const affected = (path) =>
    typeof path === "string" && roots.some((root) => within(path, root));
  if (roots.length) {
    if ((project.protocols || []).some((item) => affected(item.folder)))
      fail("目录包含尚未支持删除的协议资源");
    for (const key of ["socketioDefinitions", "grpcDefinitions"])
      if (
        (project.settings?.[key] || []).some(
          (item) => !item.folder || affected(item.folder),
        )
      )
        fail("存在未明确隔离的扩展协议资源");
    for (const [key, value] of Object.entries(project.settings || {}))
      if (
        /^folder/i.test(key) &&
        !folderSettingKeys.includes(key) &&
        value != null &&
        (typeof value !== "object" || Object.keys(value).length)
      )
        fail("尚未支持的目录设置：" + key);
  }
  const chosen = new Set(selectedTargetIds);
  const requests = (project.requests || []).filter(
    (item) => !item.deletedAt && (chosen.has(item.id) || affected(item.folder)),
  );
  const documents = (project.documents || []).filter(
    (item) => !item.deletedAt && (chosen.has(item.id) || affected(item.folder)),
  );
  const folderPaths = activeAPIFolders(project).filter(affected);
  const folderSettings = Object.fromEntries(
    folderSettingKeys
      .filter((key) => project.settings?.[key] !== undefined)
      .map((key) => [
        key,
        Object.fromEntries(
          Object.entries(project.settings[key]).filter(([path]) =>
            affected(path),
          ),
        ),
      ]),
  );
  const batch = {
    id: randomUUID(),
    deletedAt: new Date().toISOString(),
    selectedTargetIds: [...selectedTargetIds],
    folderPaths,
    explicitFolders: (project.folders || []).filter(affected),
    requestIds: requests.map((item) => item.id),
    documents,
    folderSettings,
  };
  validateResourceJSON(batch);
  const draft = structuredClone(project);
  for (const item of draft.requests)
    if (batch.requestIds.includes(item.id)) item.deletedAt = batch.deletedAt;
  draft.documents = (draft.documents || []).filter(
    (item) => !documents.some((removed) => removed.id === item.id),
  );
  draft.folders = (draft.folders || []).filter((path) => !affected(path));
  for (const key of folderSettingKeys)
    if (draft.settings?.[key] !== undefined)
      draft.settings[key] = Object.fromEntries(
        Object.entries(draft.settings[key]).filter(([path]) => !affected(path)),
      );
  draft.apiResourceTrash = {
    version: 1,
    batches: [
      ...(draft.apiResourceTrash?.batches || []),
      structuredClone(batch),
    ],
  };
  validateAPIResourceTrash(draft);
  return { project: draft, selectedTargetIds: [...selectedTargetIds] };
}
