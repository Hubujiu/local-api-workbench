import { isDeepStrictEqual } from "node:util";
import {
  activeAPIFolders,
  apiResourceTargets,
  assertAPIFolderIsolation,
  folderSettingKeys,
  validateAPIResourceTrash,
} from "./api-resource-lifecycle.mjs";

const fail = (reason) => {
  throw Error("资源批次恢复冲突：" + reason);
};
const within = (path, root) =>
  typeof path === "string" && (path === root || path.startsWith(root + "/"));
const storeMetadata = new Set([
  "revision",
  "configRevision",
  "updatedAt",
  "_diskFingerprint",
]);

// Persistence-equivalent comparison without JSON.stringify/toJSON/getter calls.
// Undefined object values are omitted on disk; undefined array entries are not
// silently converted to null. Unknown real fields remain part of the evidence.
function projection(value, omitMetadata = false) {
  const ancestors = new Set();
  function visit(item, depth) {
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item) || depth > 100)
      fail("项目必须为无环JSON数据");
    const array = Array.isArray(item);
    if (
      !(array ? [Array.prototype] : [Object.prototype, null]).includes(
        Object.getPrototypeOf(item),
      )
    )
      fail("项目对象原型无效");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    // Null-prototype objects safely retain literal JSON Schema/data keys such
    // as constructor or __proto__; the trash codec keeps its own stricter rules.
    const output = array ? [] : Object.create(null);
    ancestors.add(item);
    const length = array ? descriptors.length?.value : 0;
    if (
      array &&
      (!Number.isSafeInteger(length) ||
        length < 0 ||
        Reflect.ownKeys(descriptors).length !== length + 1)
    )
      fail("数组稀疏或含附加字段");
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (
        typeof key !== "string" ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable
      )
        fail("项目含访问器或不可序列化字段");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
        fail("数组含附加字段");
      // Check descriptors even for ignored Store-owned fields.
      if (depth === 0 && omitMetadata && storeMetadata.has(key)) continue;
      if (!array && descriptor.value === undefined) continue;
      output[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return output;
  }
  return visit(value, 0);
}

export function restoreAPIResources(project, batchId, { restoredAt } = {}) {
  projection(project); // Validate descriptors before any reads or cloning.
  validateAPIResourceTrash(project);
  if (project.archived) fail("归档项目不可恢复资源");
  if (project.settings?.nativeInheritance !== undefined)
    fail("原生继承项目必须使用专用图恢复操作");
  if (
    typeof restoredAt !== "string" ||
    !Number.isFinite(Date.parse(restoredAt)) ||
    new Date(restoredAt).toISOString() !== restoredAt
  )
    fail("必须提供服务端ISO恢复时间");
  const batches = project.apiResourceTrash?.batches || [];
  const index = batches.findIndex((item) => item.id === batchId);
  if (index < 0) fail("批次不存在");
  const batch = batches[index];
  if (batch.restoredAt !== undefined) fail("批次已恢复");
  apiResourceTargets(project); // Also reject global/reserved entity ID ambiguity.
  const selected = new Set(batch.selectedTargetIds);
  const roots = batch.selectedTargetIds
    .filter((id) => id.startsWith("folder:"))
    .map((id) => id.slice(7));
  const affected = (path) => roots.some((root) => within(path, root));
  if (batch.folderPaths.some((path) => !affected(path)))
    fail("批次目录超出选中根目录");
  assertAPIFolderIsolation(project, roots);
  const requests = batch.requestIds.map((id) => {
    const matches = (project.requests || []).filter((item) => item.id === id);
    if (
      matches.length !== 1 ||
      matches[0].deletedAt !== batch.deletedAt ||
      batches.slice(index + 1).some((item) => item.requestIds.includes(id))
    )
      fail("HTTP成员缺失、已单独恢复或再次回收：" + id);
    return matches[0];
  });
  const occupied = new Set(
    [
      ...(project.requests || []),
      ...(project.documents || []),
      ...(project.protocols || []),
      ...(project.settings?.grpcDefinitions || []),
      ...(project.settings?.socketioDefinitions || []),
    ].map((item) => item.id),
  );
  for (const document of batch.documents) {
    if (occupied.has(document.id)) fail("文档ID已占用：" + document.id);
    if (document.deletedAt) fail("批次文档快照不是活动定义：" + document.id);
  }
  const members = [...requests, ...batch.documents];
  if (members.some((item) => !selected.has(item.id) && !affected(item.folder)))
    fail("批次成员已移出选中目录");
  const active = activeAPIFolders(project);
  if (active.some(affected)) fail("待恢复目录范围已被占用");
  const available = new Set([...active, ...batch.folderPaths]);
  const requireFolder = (path) => {
    if (path && !available.has(path)) fail("原父目录已不存在：" + path);
  };
  for (const item of members) requireFolder(item.folder);
  for (const path of batch.folderPaths) {
    const slash = path.lastIndexOf("/");
    requireFolder(slash < 0 ? "" : path.slice(0, slash));
  }
  for (const [kind, map] of Object.entries(batch.folderSettings))
    for (const path of Object.keys(map))
      if (Object.hasOwn(project.settings?.[kind] || {}, path))
        fail("目录设置槽位已占用：" + kind + ":" + path);

  // No mutation occurs until every member and directory has been checked.
  const draft = structuredClone(project);
  const ids = new Set(batch.requestIds);
  for (const item of draft.requests || [])
    if (ids.has(item.id)) delete item.deletedAt;
  if (batch.documents.length)
    draft.documents = [
      ...(draft.documents || []),
      ...structuredClone(batch.documents),
    ];
  if (batch.explicitFolders.length)
    draft.folders = [...(draft.folders || []), ...batch.explicitFolders];
  for (const kind of folderSettingKeys) {
    const map = batch.folderSettings[kind];
    if (!map || !Object.keys(map).length) continue;
    draft.settings ||= {};
    draft.settings[kind] = {
      ...(draft.settings[kind] || {}),
      ...structuredClone(map),
    };
  }
  draft.apiResourceTrash.batches[index].restoredAt = restoredAt;
  validateAPIResourceTrash(draft);
  return { project: draft, restoredTargetIds: [...batch.selectedTargetIds] };
}

export function assertAPIResourceTrashIdentity(previous, next, restoreContext) {
  validateAPIResourceTrash(next);
  if (previous === undefined) {
    if (restoreContext !== undefined) fail("恢复必须存在锁内原项目");
    return; // A new/imported project has no prior server history to freeze.
  }
  validateAPIResourceTrash(previous);
  if (restoreContext !== undefined) {
    const after = projection(next, true);
    const context = projection(restoreContext);
    if (
      Object.keys(context).some(
        (key) => !["batchId", "restoredAt"].includes(key),
      )
    )
      fail("恢复上下文字段无效");
    const expected = restoreAPIResources(
      previous,
      context.batchId,
      context,
    ).project;
    if (!isDeepStrictEqual(projection(expected, true), after))
      fail("恢复结果与锁内完整重算不一致");
    return;
  }
  // Ordinary/activity saves only freeze trash; do not impose new projection
  // restrictions on unrelated, legitimately serializable project values.
  // The codec above checked the own descriptor before reading either value.
  const trashBatches = (project) => {
    const value = Object.getOwnPropertyDescriptor(
      project,
      "apiResourceTrash",
    )?.value;
    return value === undefined ? [] : projection(value).batches;
  };
  const oldBatches = trashBatches(previous);
  const newBatches = trashBatches(next);
  if (
    newBatches.length < oldBatches.length ||
    oldBatches.some(
      (batch, index) => !isDeepStrictEqual(batch, newBatches[index]),
    )
  )
    fail("既有回收历史不可修改、删除或重排");
  if (
    newBatches
      .slice(oldBatches.length)
      .some((batch) => batch.restoredAt !== undefined)
  )
    fail("新增批次不能自行标记恢复完成");
}
