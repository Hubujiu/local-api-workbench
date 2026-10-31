import { isDeepStrictEqual } from "node:util";
import {
  deleteAPIResources,
  validateAPIResourceTrash,
  folderSettingKeys,
} from "./api-resource-lifecycle.mjs";
const fail = (message) => {
  throw Error("原生继承图：目录回收" + message);
};
const within = (path, root) =>
  typeof path === "string" && (path === root || path.startsWith(root + "/"));
const equalSet = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
function fields(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    fail("记录字段无效");
}
function id(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    fail("标识无效");
}
function subtree(state, sourceId) {
  return [...state.folders.values()].filter((folder) =>
    state
      .ancestry(folder.sourceId)
      .some((parent) => parent.sourceId === sourceId),
  );
}
function requestsIn(state, folders) {
  const ids = new Set(folders.map((folder) => folder.sourceId));
  return [...state.bound.values()]
    .filter((binding) => ids.has(binding.parentId))
    .map((binding) => binding.requestId);
}
function refuseOtherResources(project, path) {
  if ((project.documents || []).some((item) => within(item.folder, path)))
    fail("首片不支持子树文档");
  if ((project.protocols || []).some((item) => within(item.folder, path)))
    fail("不支持子树协议资源");
  const sources = project.settings?.apipostProtocolSources;
  if (sources !== undefined && (!Array.isArray(sources) || sources.length))
    fail("不能定位协议来源");
  for (const key of ["grpcDefinitions", "socketioDefinitions"])
    if (
      (project.settings?.[key] || []).some(
        (item) => !item.folder || within(item.folder, path),
      )
    )
      fail("不能定位扩展协议资源");
  for (const [key, value] of Object.entries(project.settings || {}))
    if (
      /^folder/i.test(key) &&
      !folderSettingKeys.includes(key) &&
      value != null &&
      (typeof value !== "object" || Object.keys(value).length)
    )
      fail("不支持额外目录设置");
}
// State geometry has already passed the unchanged graph identity/ancestry checks.
export function readNativeFolderLifecycle(project, state) {
  const value = state.graph.folderLifecycle,
    inactiveFolders = new Set(),
    recycled = [],
    records = [];
  if (value === undefined)
    return { inactiveFolders, recycled, folderLifecycleRecords: records };
  fields(value, ["version", "records"]);
  if (
    value.version !== 1 ||
    !Array.isArray(value.records) ||
    !value.records.length ||
    value.records.length > 100
  )
    fail("版本或数量无效");
  validateAPIResourceTrash(project);
  const seen = new Set();
  for (const entry of value.records) {
    fields(entry, ["sourceId", "batchId", "state"]);
    id(entry.sourceId);
    id(entry.batchId);
    if (
      !state.folders.has(entry.sourceId) ||
      seen.has(entry.batchId) ||
      !["recycled", "restored"].includes(entry.state)
    )
      fail("身份或状态无效");
    seen.add(entry.batchId);
    const batch = project.apiResourceTrash?.batches.find(
      (item) => item.id === entry.batchId,
    );
    if (
      !batch ||
      batch.selectedTargetIds.length !== 1 ||
      !batch.selectedTargetIds[0].startsWith("folder:") ||
      batch.documents.length ||
      Object.values(batch.folderSettings).some(
        (map) => Object.keys(map).length,
      ) ||
      batch.requestIds.some((requestId) => !state.bound.has(requestId))
    )
      fail("批次不属于本图的HTTP目录");
    const oldPath = batch.selectedTargetIds[0].slice(7);
    if (
      !batch.folderPaths.includes(oldPath) ||
      batch.folderPaths.some((path) => !within(path, oldPath)) ||
      !equalSet(batch.explicitFolders, batch.folderPaths)
    )
      fail("历史目录范围无效");
    records.push(entry);
    if (entry.state === "restored") continue;
    const root = state.folders.get(entry.sourceId),
      folders = subtree(state, entry.sourceId),
      requestIds = requestsIn(state, folders);
    if (
      root.path !== oldPath ||
      !equalSet(
        batch.folderPaths,
        folders.map((folder) => folder.path),
      ) ||
      !equalSet(batch.requestIds, requestIds)
    )
      fail("活动批次与完整子树不一致");
    for (const folder of folders) {
      if (inactiveFolders.has(folder.sourceId)) fail("子树重叠");
      inactiveFolders.add(folder.sourceId);
    }
    for (const requestId of requestIds)
      if (
        project.requests.find((request) => request.id === requestId)
          ?.deletedAt !== batch.deletedAt
      )
        fail("接口必须与目录批次同时回收");
    refuseOtherResources(project, root.path);
    recycled.push({ entry, batch, folders, requestIds });
  }
  return { inactiveFolders, recycled, folderLifecycleRecords: records };
}
export function editNativeFolderLifecycle(project, state, operation, context) {
  if (operation.type === "recycle-folder") {
    id(operation.sourceId);
    const root = state.folders.get(operation.sourceId);
    if (!root || state.inactiveFolders.has(root.sourceId))
      fail("目标目录不存在或已回收");
    const folders = subtree(state, root.sourceId),
      requestIds = requestsIn(state, folders);
    if (
      folders.some((folder) => state.inactiveFolders.has(folder.sourceId)) ||
      requestIds.some(
        (requestId) =>
          project.requests.find((request) => request.id === requestId)
            .deletedAt,
      )
    )
      fail("子树已有回收内容，不能部分覆盖");
    refuseOtherResources(project, root.path);
    id(context.batchId);
    if (
      typeof context.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(context.deletedAt)) ||
      new Date(context.deletedAt).toISOString() !== context.deletedAt
    )
      fail("缺少后端生成日期");
    // Original project and all existing generic deletion guards remain intact.
    const next = deleteAPIResources(project, ["folder:" + root.path], {
      deletedAt: context.deletedAt,
      batchId: context.batchId,
    }).project;
    next.settings.nativeInheritance.folderLifecycle = {
      version: 1,
      records: [
        ...structuredClone(state.folderLifecycleRecords),
        {
          sourceId: root.sourceId,
          batchId: context.batchId,
          state: "recycled",
        },
      ],
    };
    return next;
  }
  if (operation.type !== "restore-folder") fail("操作类型无效");
  id(operation.batchId);
  const selected = state.recycled.find(
    ({ entry }) => entry.batchId === operation.batchId,
  );
  if (!selected) fail("只能整批恢复当前回收目录");
  const root = state.folders.get(selected.entry.sourceId);
  if (root.parentId !== "0" && state.inactiveFolders.has(root.parentId))
    fail("父目录尚未恢复");
  if (
    (project.folders || []).some((path) =>
      selected.batch.folderPaths.includes(path),
    )
  )
    fail("恢复路径已被占用");
  const next = structuredClone(project);
  const entry = next.settings.nativeInheritance.folderLifecycle.records.find(
    (item) => item.batchId === operation.batchId,
  );
  entry.state = "restored";
  const restoredIds = new Set(
    selected.folders.map((folder) => folder.sourceId),
  );
  next.folders = next.settings.nativeInheritance.folders
    .filter(
      (folder) =>
        !state.inactiveFolders.has(folder.sourceId) ||
        restoredIds.has(folder.sourceId),
    )
    .map((folder) => folder.path);
  for (const request of next.requests)
    if (selected.requestIds.includes(request.id)) delete request.deletedAt;
  return next;
}
export function assertNativeFolderLifecycleUnchanged(previous, next, prior) {
  if (
    !isDeepStrictEqual(
      prior.graph.folderLifecycle,
      next.settings.nativeInheritance.folderLifecycle,
    )
  )
    fail("普通保存不能修改生命周期记录");
  for (const entry of prior.folderLifecycleRecords) {
    const before = previous.apiResourceTrash?.batches.find(
        (batch) => batch.id === entry.batchId,
      ),
      after = next.apiResourceTrash?.batches.find(
        (batch) => batch.id === entry.batchId,
      );
    if (!isDeepStrictEqual(before, after)) fail("普通保存不能修改关联历史批次");
  }
  for (const { folders, requestIds } of prior.recycled) {
    for (const folder of folders)
      if (
        !isDeepStrictEqual(
          folder,
          next.settings.nativeInheritance.folders.find(
            (item) => item.sourceId === folder.sourceId,
          ),
        )
      )
        fail("普通保存不能修改回收目录层");
    for (const requestId of requestIds)
      if (
        !isDeepStrictEqual(
          previous.requests.find((item) => item.id === requestId),
          next.requests.find((item) => item.id === requestId),
        )
      )
        fail("普通保存不能修改回收接口定义");
  }
}
export function assertNativeFolderMove(state, operation) {
  if (state.inactiveFolders.has(operation.parentId)) fail("不能移入回收目录");
  if (
    operation.type === "move-folder" &&
    (state.inactiveFolders.has(operation.sourceId) ||
      state.recycled.some(({ entry }) =>
        state
          .ancestry(entry.sourceId)
          .some((folder) => folder.sourceId === operation.sourceId),
      ))
  )
    fail("不能移动回收子树或其活动祖先");
}
