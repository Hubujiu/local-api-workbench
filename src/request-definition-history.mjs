import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";

export const REQUEST_DEFINITION_HISTORY_LIMIT = 100;
export const REQUEST_DEFINITION_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
// Owner IDs are 1..200 ASCII characters. Their spelling never changes the
// content quota, but the actual serialized envelope must include their bytes.
export const REQUEST_DEFINITION_HISTORY_ENVELOPE_MAX_BYTES =
  REQUEST_DEFINITION_HISTORY_MAX_BYTES + 199;
// The per-version quota includes the entire encoded record, not only definition.
export const REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const PROJECT_MAX_BYTES = 12 * 1024 * 1024;
const TRACKER_LIMIT = 10000;
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason) => {
  throw Error("接口定义历史无效：" + reason);
};

class HistoryProjectionByteLimitError extends Error {
  constructor(maxBytes) {
    super("接口定义历史无效：JSON体积超过" + maxBytes + "字节限制");
  }
}
function validateHistoryQuota(value, maxBytes, projectId, single = false) {
  try {
    projectHistoryProjection(value, { maxBytes });
  } catch (error) {
    if (!(error instanceof HistoryProjectionByteLimitError)) throw error;
    const base = "/api/projects/" + encodeURIComponent(projectId);
    const scope = single ? "单条历史" : "项目历史总";
    const capacity = new Error(
      "接口定义历史无效：" +
        scope +
        "容量超过 " +
        maxBytes / (1024 * 1024) +
        " MiB（完整记录的 UTF-8 编码 JSON）；本次修改未保存。请先通过 GET " +
        base +
        "/export 导出完整项目；再通过 POST " +
        base +
        '/definition-history（kind: "clear", confirm: true，携带 requestId、lineageId、configRevision）或 localapi_clear_api_definition_history 显式清理已有历史。' +
        (single ? "清理不会提高单条历史上限。" : ""),
    );
    capacity.code = "REQUEST_DEFINITION_HISTORY_CAPACITY";
    capacity.limitBytes = maxBytes;
    throw capacity;
  }
}

// Inspect descriptors before reading data. In particular, neither Proxy traps,
// getters nor toJSON methods are part of this persistence projection.
export function projectHistoryProjection(
  value,
  {
    maxBytes = REQUEST_DEFINITION_HISTORY_MAX_BYTES,
    maxDepth = 64,
    maxNodes = 300000,
  } = {},
) {
  if (
    ![maxBytes, maxDepth, maxNodes].every(
      (limit) => Number.isSafeInteger(limit) && limit > 0,
    )
  )
    fail("JSON预算参数无效");
  const ancestors = new Set();
  let bytes = 0;
  let nodes = 0;
  function charge(count) {
    bytes += count;
    if (bytes > maxBytes) throw new HistoryProjectionByteLimitError(maxBytes);
  }
  function visit(item, depth, root = false) {
    if (++nodes > maxNodes || depth > maxDepth) fail("JSON结构超限");
    if (item === undefined && root) return undefined;
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "string"
    ) {
      charge(Buffer.byteLength(JSON.stringify(item)));
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      charge(JSON.stringify(item).length);
      return Object.is(item, -0) ? 0 : item;
    }
    if (
      !item ||
      typeof item !== "object" ||
      types.isProxy(item) ||
      ancestors.has(item)
    )
      fail("仅接受无代理、无环的有限JSON数据");
    const array = Array.isArray(item);
    if (
      !(array ? [Array.prototype] : [Object.prototype, null]).includes(
        Object.getPrototypeOf(item),
      )
    )
      fail("JSON对象原型无效");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    const length = array ? descriptors.length?.value : 0;
    if (
      array &&
      (!Number.isSafeInteger(length) ||
        length < 0 ||
        length > 100000 ||
        keys.length !== length + 1)
    )
      fail("JSON数组超限、稀疏或含附加属性");
    const result = array ? [] : {};
    ancestors.add(item);
    charge(2);
    let fields = 0;
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (
        typeof key !== "string" ||
        !own(descriptor, "value") ||
        !descriptor.enumerable
      )
        fail("JSON含访问器、符号或不可序列化字段");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
        fail("JSON数组含附加属性");
      if (!array && descriptor.value === undefined) {
        if (++nodes > maxNodes) fail("JSON结构超限");
        continue;
      }
      if (fields++) charge(1);
      if (!array) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      // defineProperty, rather than assignment, preserves literal __proto__ keys.
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0, true);
}

// Optional backup-size utility, independent of definition-history save quotas.
// Walk iteratively without invoking user methods or applying history structure
// limits to unrelated, already-persisted project collections.
export function assertRequestDefinitionProjectBudget(project) {
  inspectProject(project);
  let bytes = 0;
  const ancestors = new Set();
  const frames = [{ value: { document: project } }];
  const charge = (amount) => {
    bytes += amount;
    if (bytes > PROJECT_MAX_BYTES)
      fail("JSON体积超过" + PROJECT_MAX_BYTES + "字节限制");
  };
  while (frames.length) {
    const frame = frames.at(-1);
    if (!frame.descriptors) {
      const item = frame.value;
      if (
        item === null ||
        typeof item === "boolean" ||
        typeof item === "string"
      ) {
        charge(Buffer.byteLength(JSON.stringify(item)));
        frames.pop();
        continue;
      }
      if (typeof item === "number" && Number.isFinite(item)) {
        charge(JSON.stringify(item).length);
        frames.pop();
        continue;
      }
      if (
        !item ||
        typeof item !== "object" ||
        types.isProxy(item) ||
        ancestors.has(item)
      )
        fail("仅接受无代理、无环的有限JSON数据");
      const array = Array.isArray(item);
      if (
        !(array ? [Array.prototype] : [Object.prototype, null]).includes(
          Object.getPrototypeOf(item),
        )
      )
        fail("JSON对象原型无效");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      const length = array ? descriptors.length?.value : 0;
      if (
        array &&
        (!Number.isSafeInteger(length) ||
          length < 0 ||
          keys.length !== length + 1)
      )
        fail("JSON数组稀疏或含附加属性");
      ancestors.add(item);
      charge(2);
      Object.assign(frame, {
        descriptors,
        keys,
        array,
        length,
        index: 0,
        fields: 0,
      });
    }
    if (frame.index === frame.keys.length) {
      ancestors.delete(frame.value);
      frames.pop();
      continue;
    }
    const key = frame.keys[frame.index++];
    if (frame.array && key === "length") continue;
    const descriptor = frame.descriptors[key];
    if (
      typeof key !== "string" ||
      !own(descriptor, "value") ||
      !descriptor.enumerable
    )
      fail("JSON含访问器、符号或不可序列化字段");
    if (
      frame.array &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= frame.length)
    )
      fail("JSON数组含附加属性");
    if (!frame.array && descriptor.value === undefined) continue;
    if (frame.fields++) charge(1);
    if (!frame.array) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
    frames.push({ value: descriptor.value });
  }
  return bytes;
}

export function sameHistoryJSON(a, b, projectionOptions) {
  return isDeepStrictEqual(
    projectHistoryProjection(a, projectionOptions),
    projectHistoryProjection(b, projectionOptions),
  );
}
function exactKeys(value, required, optional = []) {
  if (
    !object(value) ||
    required.some((key) => !own(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    fail("字段缺失或含未知字段");
}
function identifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(value))
    fail(label + "无效");
}
function requestIdentifier(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    !value.isWellFormed() ||
    value === "0" ||
    value.startsWith("folder:")
  )
    fail("接口ID无效或占用保留名称");
}
function recordId(value, label) {
  identifier(value, label);
  if (value === "current") fail(label + "占用当前版本保留名称");
}
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("时间必须为ISO时间字符串");
}
function tag(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !value.isWellFormed() ||
    value.includes("\0")
  )
    fail("标签必须为最多200字符的文本");
}
function requestMap(project) {
  if (!object(project)) fail("项目必须为对象");
  identifier(project.id, "项目ID");
  if (!Array.isArray(project.requests) || project.requests.length > 5000)
    fail("接口数组无效");
  const result = new Map();
  for (const request of project.requests) {
    if (!object(request)) fail("接口定义必须为对象");
    requestIdentifier(request.id);
    if (request.id === "0" || result.has(request.id))
      fail("接口ID重复或占用保留名称");
    result.set(request.id, request);
  }
  return result;
}
function validateHistory(project, { checkTargets = true } = {}) {
  const requests = requestMap(project);
  const history = project.requestDefinitionHistory;
  if (history === undefined) return;
  exactKeys(history, ["version", "projectId", "entries"]);
  identifier(history.projectId, "历史项目ID");
  if (
    history.version !== 1 ||
    history.projectId !== project.id ||
    !Array.isArray(history.entries) ||
    history.entries.length > TRACKER_LIMIT
  )
    fail("版本、项目归属或历史容量无效");
  // history is already descriptor-safe projected data. Validate the real owner
  // before normalizing this accounting-only view. Charging one ASCII character
  // keeps identity rebinding quota-neutral; the validated 200-character limit
  // also guarantees the real envelope is at most MAX_BYTES + 199 bytes.
  validateHistoryQuota(
    { ...history, projectId: "a" },
    REQUEST_DEFINITION_HISTORY_MAX_BYTES,
    project.id,
  );
  const lineages = new Set();
  const versionIds = new Set();
  const active = new Set();
  for (const entry of history.entries) {
    exactKeys(entry, [
      "requestId",
      "lineageId",
      "currentVersion",
      "currentCreatedAt",
      "currentTag",
      "retired",
      "versions",
    ]);
    requestIdentifier(entry.requestId);
    if (entry.requestId === "0") fail("接口ID占用保留名称");
    recordId(entry.lineageId, "血缘ID");
    if (lineages.has(entry.lineageId)) fail("血缘ID重复");
    lineages.add(entry.lineageId);
    if (
      !Number.isSafeInteger(entry.currentVersion) ||
      entry.currentVersion < 1 ||
      typeof entry.retired !== "boolean" ||
      !Array.isArray(entry.versions) ||
      entry.versions.length > REQUEST_DEFINITION_HISTORY_LIMIT
    )
      fail("序号、退役状态或版本容量无效");
    timestamp(entry.currentCreatedAt);
    tag(entry.currentTag);
    if (!entry.retired) {
      if (
        active.has(entry.requestId) ||
        (checkTargets && !requests.has(entry.requestId))
      )
        fail("活动血缘重复或接口不存在");
      active.add(entry.requestId);
    }
    let previousVersion = 0;
    for (const version of entry.versions) {
      exactKeys(version, ["id", "version", "createdAt", "tag", "definition"]);
      recordId(version.id, "历史ID");
      if (versionIds.has(version.id)) fail("历史ID重复");
      versionIds.add(version.id);
      if (
        !Number.isSafeInteger(version.version) ||
        version.version <= previousVersion ||
        version.version > entry.currentVersion ||
        (!entry.retired && version.version === entry.currentVersion)
      )
        fail("历史序号顺序或高水位无效");
      previousVersion = version.version;
      timestamp(version.createdAt);
      tag(version.tag);
      if (
        !object(version.definition) ||
        version.definition.id !== entry.requestId
      )
        fail("历史快照接口归属不一致");
      validateHistoryQuota(
        version,
        REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES,
        project.id,
        true,
      );
    }
  }
}
function projectField(project, key, { required = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(project, key);
  if (
    (!descriptor && required) ||
    (descriptor && (!own(descriptor, "value") || !descriptor.enumerable))
  )
    fail("项目字段缺失、含访问器或不可序列化：" + key);
  return descriptor?.value;
}
function inspectProject(project) {
  if (
    types.isProxy(project) ||
    !object(project) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(project))
  )
    fail("项目必须为无代理普通对象");
}
function historyProjectProjection(project) {
  inspectProject(project);
  // Reads and activity comparisons do not inspect execution evidence. Its
  // independent retention can legitimately grow a project beyond backup size.
  return projectHistoryProjection(
    {
      id: projectField(project, "id", { required: true }),
      requests: projectField(project, "requests", { required: true }),
      requestDefinitionHistory: projectField(
        project,
        "requestDefinitionHistory",
      ),
    },
    { maxBytes: Number.MAX_SAFE_INTEGER },
  );
}
export function validateRequestDefinitionHistory(project) {
  inspectProject(project);
  // Legacy reads neither acquire history nor impose new feature budgets.
  if (projectField(project, "requestDefinitionHistory") === undefined) return;
  validateHistory(historyProjectProjection(project));
}
function definition(request) {
  const result = projectHistoryProjection(request, {
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  delete result.deletedAt;
  // Equality has no snapshot admission budget: an unchanged preexisting large
  // definition must not prevent reads, activity or metadata-only saves.
  return result;
}
function sameDefinition(a, b) {
  return isDeepStrictEqual(definition(a), definition(b));
}
function makeHistory(project) {
  return { version: 1, projectId: project.id, entries: [] };
}
function allocateId(makeId, used) {
  const id = makeId();
  recordId(id, "生成ID");
  if (used.has(id)) fail("生成ID重复");
  used.add(id);
  return id;
}
function saveSnapshot(entry, request, makeId, used, projectId) {
  const version = {
    id: allocateId(makeId, used),
    version: entry.currentVersion,
    createdAt: entry.currentCreatedAt,
    tag: entry.currentTag,
    definition: definition(request),
  };
  validateHistoryQuota(
    version,
    REQUEST_DEFINITION_SNAPSHOT_MAX_BYTES,
    projectId,
    true,
  );
  entry.versions.push(version);
  // Inputs were validated in full before retention is applied.
  if (entry.versions.length > REQUEST_DEFINITION_HISTORY_LIMIT)
    entry.versions.shift();
}

export function reconcileRequestDefinitionHistory(
  previous,
  next,
  {
    now = new Date().toISOString(),
    makeId = randomUUID,
    activity = false,
    restoredRequestId,
  } = {},
) {
  const before =
    previous === undefined ? undefined : historyProjectProjection(previous);
  const after = activity
    ? historyProjectProjection(next)
    : historyOperationProject(next);
  if (before !== undefined) validateHistory(before);
  validateHistory(after, { checkTargets: before === undefined });
  const nextRequests = requestMap(after);
  const previousRequests =
    before === undefined ? new Map() : requestMap(before);
  if (before !== undefined && before.id !== after.id) fail("项目归属不能改变");
  if (restoredRequestId !== undefined) {
    requestIdentifier(restoredRequestId);
    const oldRequest = previousRequests.get(restoredRequestId);
    const currentRequest = nextRequests.get(restoredRequestId);
    const priorEntry = before?.requestDefinitionHistory?.entries.find(
      (entry) => entry.requestId === restoredRequestId && !entry.retired,
    );
    const nextEntry = (
      after.requestDefinitionHistory ?? before?.requestDefinitionHistory
    )?.entries.find(
      (entry) => entry.requestId === restoredRequestId && !entry.retired,
    );
    if (
      activity ||
      !oldRequest ||
      !currentRequest ||
      !priorEntry ||
      !nextEntry ||
      priorEntry.lineageId !== nextEntry.lineageId ||
      oldRequest.deletedAt ||
      currentRequest.deletedAt ||
      projectField(previous, "archived") ||
      after.archived
    )
      fail("显式恢复必须属于同一活动项目、接口和当前血缘，不能创建或复活资源");
  }
  if (activity) {
    if (
      before === undefined ||
      !isDeepStrictEqual(before.requests, after.requests) ||
      !isDeepStrictEqual(
        before.requestDefinitionHistory,
        after.requestDefinitionHistory,
      )
    )
      fail("运行活动不能修改接口定义或定义历史");
    return previous.requestDefinitionHistory;
  }
  timestamp(now);
  if (typeof makeId !== "function") fail("ID生成器无效");
  const changedRequestIds = new Set();
  for (const [requestId, request] of nextRequests) {
    const oldRequest = previousRequests.get(requestId);
    if (!oldRequest || !sameDefinition(oldRequest, request)) {
      changedRequestIds.add(requestId);
    }
  }
  // The Store, under its project lock, enforces owner equality or authorizes
  // an explicit tag/clear operation before providing a replacement history.
  const history =
    after.requestDefinitionHistory ??
    before?.requestDefinitionHistory ??
    makeHistory(after);
  const used = new Set(
    history.entries.flatMap((entry) => [
      entry.lineageId,
      ...entry.versions.map((version) => version.id),
    ]),
  );
  const active = new Map(
    history.entries
      .filter((entry) => !entry.retired)
      .map((entry) => [entry.requestId, entry]),
  );
  // Legacy projects acquire a current record on their first configuration save.
  // Their existing definition becomes history only if this save changes/removes it.
  for (const [requestId] of previousRequests) {
    if (active.has(requestId)) continue;
    const entry = {
      requestId,
      lineageId: allocateId(makeId, used),
      currentVersion: 1,
      currentCreatedAt: now,
      currentTag: "",
      retired: false,
      versions: [],
    };
    history.entries.push(entry);
    active.set(requestId, entry);
  }
  for (const [requestId, entry] of active) {
    const oldRequest = previousRequests.get(requestId);
    const newRequest = nextRequests.get(requestId);
    if (!newRequest) {
      if (oldRequest) saveSnapshot(entry, oldRequest, makeId, used, after.id);
      entry.retired = true;
    } else if (
      oldRequest &&
      (requestId === restoredRequestId || changedRequestIds.has(requestId))
    ) {
      if (entry.currentVersion === Number.MAX_SAFE_INTEGER)
        fail("版本序号已耗尽");
      saveSnapshot(entry, oldRequest, makeId, used, after.id);
      entry.currentVersion++;
      entry.currentCreatedAt = now;
      entry.currentTag = "";
    }
  }
  for (const [requestId] of nextRequests) {
    if (active.has(requestId)) continue;
    history.entries.push({
      requestId,
      lineageId: allocateId(makeId, used),
      currentVersion: 1,
      currentCreatedAt: now,
      currentTag: "",
      retired: false,
      versions: [],
    });
  }
  after.requestDefinitionHistory = history;
  validateHistory(after);
  return history;
}

function findTarget(
  project,
  requestId,
  lineageId,
  { allowUnselected = false } = {},
) {
  requestIdentifier(requestId);
  if (lineageId !== undefined) recordId(lineageId, "血缘ID");
  const request = project.requests.find((item) => item.id === requestId);
  const candidates = (project.requestDefinitionHistory?.entries || []).filter(
    (entry) => entry.requestId === requestId,
  );
  let entry;
  if (lineageId !== undefined) {
    entry = candidates.find((item) => item.lineageId === lineageId);
    if (!entry) fail("指定接口血缘不存在");
  } else {
    entry = candidates.find((item) => !item.retired);
    if (!entry && candidates.length === 1 && !request) entry = candidates[0];
    if (!entry && candidates.length && !request && !allowUnselected)
      fail("必须指定退役接口血缘");
  }
  if (!entry && !request && !candidates.length) fail("接口不存在");
  return { entry, request, candidates, selectionRequired: !entry && !request };
}
function metadata(entry, version, current = false) {
  return {
    id: current ? "current" : version.id,
    version: current ? (entry?.currentVersion ?? null) : version.version,
    createdAt: current ? (entry?.currentCreatedAt ?? null) : version.createdAt,
    tag: current ? (entry?.currentTag ?? "") : version.tag,
    current,
  };
}
export function listRequestDefinitionHistory(project, input) {
  const copy = historyProjectProjection(project);
  validateHistory(copy);
  const options = projectHistoryProjection(input);
  exactKeys(
    options,
    ["requestId"],
    ["lineageId", "offset", "limit", "lineageOffset", "lineageLimit"],
  );
  const {
    requestId,
    lineageId,
    offset = 0,
    limit = 20,
    lineageOffset = 0,
    lineageLimit = 20,
  } = options;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(lineageOffset) ||
    lineageOffset < 0 ||
    lineageOffset > 10000 ||
    !Number.isSafeInteger(lineageLimit) ||
    lineageLimit < 1 ||
    lineageLimit > 100
  )
    fail("分页参数无效");
  const { entry, request, candidates, selectionRequired } = findTarget(
    copy,
    requestId,
    lineageId,
    { allowUnselected: true },
  );
  const versions = entry?.versions || [];
  return {
    requestId,
    lineageId: entry?.lineageId ?? null,
    tracked: Boolean(entry),
    selectionRequired,
    lineages: {
      total: candidates.length,
      offset: lineageOffset,
      limit: lineageLimit,
      items: candidates
        .toReversed()
        .slice(lineageOffset, lineageOffset + lineageLimit)
        .map((lineage) => ({
          lineageId: lineage.lineageId,
          retired: lineage.retired,
          currentVersion: lineage.currentVersion,
          total: lineage.versions.length,
        })),
    },
    retired: entry?.retired ?? false,
    current:
      request && !entry?.retired ? metadata(entry, undefined, true) : null,
    total: versions.length,
    offset,
    limit,
    versions: [...versions]
      .reverse()
      .slice(offset, offset + limit)
      .map((version) => metadata(entry, version)),
  };
}
export function getRequestDefinitionVersion(project, input) {
  const copy = historyProjectProjection(project);
  validateHistory(copy);
  const options = projectHistoryProjection(input);
  exactKeys(options, ["requestId", "historyId"], ["lineageId"]);
  const { requestId, lineageId, historyId } = options;
  identifier(historyId, "历史ID");
  const { entry, request } = findTarget(copy, requestId, lineageId);
  if (historyId === "current") {
    if (!request || entry?.retired) fail("退役血缘没有当前版本");
    return {
      requestId,
      lineageId: entry?.lineageId ?? null,
      ...metadata(entry, undefined, true),
      definition: request,
    };
  }
  const version = entry?.versions.find((item) => item.id === historyId);
  if (!version) fail("指定接口历史版本不存在");
  return {
    requestId,
    lineageId: entry.lineageId,
    ...metadata(entry, version),
    definition: version.definition,
  };
}
function historyOperationProject(project) {
  inspectProject(project);
  const descriptors = Object.getOwnPropertyDescriptors(project);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !own(descriptor, "value") ||
      !descriptor.enumerable
    )
      fail("项目顶层含访问器、符号或不可序列化字段");
  }
  const feature = historyProjectProjection(project);
  const result = {};
  // Called with the Store's committed JSON project. Unrelated data is borrowed
  // unchanged, not recursively validated or cloned. This is not an untrusted
  // full-project sanitizer; the caller must not mutate the borrowed fields.
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const value = own(feature, key)
      ? feature[key]
      : key === "archived"
        ? projectHistoryProjection(descriptor.value)
        : descriptor.value;
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
export function applyRequestDefinitionHistoryOperation(
  project,
  input,
  { now } = {},
) {
  const copy = historyOperationProject(project);
  validateHistory(copy);
  const options = projectHistoryProjection(input);
  if (!object(options)) fail("操作必须为对象");
  if (options.kind === "clear")
    exactKeys(
      options,
      ["kind", "requestId", "lineageId"],
      ["historyIds", "all"],
    );
  else if (options.kind === "tag")
    exactKeys(options, ["kind", "requestId", "lineageId", "historyId", "tag"]);
  else if (options.kind === "restore")
    exactKeys(options, ["kind", "requestId", "lineageId", "historyId"]);
  else fail("操作类型无效");
  if (now !== undefined) timestamp(now);
  const { entry, request } = findTarget(
    copy,
    options.requestId,
    options.lineageId,
  );
  if (!entry) fail("接口尚未建立历史血缘");
  if (options.kind === "clear") {
    if (own(options, "all") === own(options, "historyIds"))
      fail("清理必须选择全部或指定历史ID");
    if (own(options, "all")) {
      if (options.all !== true) fail("全部清理标志必须为true");
      if (entry.retired)
        copy.requestDefinitionHistory.entries =
          copy.requestDefinitionHistory.entries.filter(
            (item) => item !== entry,
          );
      else entry.versions = [];
    } else {
      if (
        !Array.isArray(options.historyIds) ||
        options.historyIds.length < 1 ||
        options.historyIds.length > 100 ||
        new Set(options.historyIds).size !== options.historyIds.length
      )
        fail("清理历史ID数组无效");
      for (const id of options.historyIds) {
        recordId(id, "清理历史ID");
        if (!entry.versions.some((version) => version.id === id))
          fail("清理版本不属于指定接口血缘");
      }
      const ids = new Set(options.historyIds);
      entry.versions = entry.versions.filter((version) => !ids.has(version.id));
    }
  } else {
    identifier(options.historyId, "历史ID");
    const current = options.historyId === "current";
    const version = current
      ? undefined
      : entry.versions.find((item) => item.id === options.historyId);
    if ((current && (entry.retired || !request)) || (!current && !version))
      fail("指定接口历史版本不存在");
    if (options.kind === "tag") {
      tag(options.tag);
      if (current) entry.currentTag = options.tag;
      else version.tag = options.tag;
    } else {
      if (current) fail("当前版本不能作为恢复来源");
      if (copy.archived || entry.retired || !request || request.deletedAt)
        fail("仅活动项目的当前活动血缘可恢复定义");
      const restored = projectHistoryProjection(version.definition);
      restored.id = request.id;
      delete restored.deletedAt;
      if (own(request, "deletedAt")) restored.deletedAt = request.deletedAt;
      copy.requests[copy.requests.findIndex((item) => item.id === request.id)] =
        restored;
    }
  }
  validateHistory(copy);
  return copy;
}
