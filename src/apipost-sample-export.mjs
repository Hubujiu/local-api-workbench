import { isDeepStrictEqual } from "node:util";
import { normalizeRequest } from "./core.mjs";
import { validateCaseFolders } from "../public/case-folders.js";
import { validateResourceJSON } from "./api-resource-lifecycle.mjs";

const fail = (reason) => {
  throw Error("原生样例导出不能无损保留" + reason + "；请使用项目备份");
};
const populated = (value) =>
  value != null &&
  value !== "" &&
  value !== false &&
  (typeof value !== "object" || Object.keys(value).length > 0);
const sortedCases = (project) =>
  (project.cases || [])
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.sort ?? a.index) - (b.item.sort ?? b.index) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
const known = (object, keys, label) => {
  if (Object.keys(object).some((key) => !keys.includes(key)))
    fail(label + "未知字段");
};

export function prepareSampleExport(project, { projectId, id, encodeRequest }) {
  const cases = project.cases || [],
    groups = project.caseFolders || [];
  validateResourceJSON(cases);
  validateResourceJSON(groups);
  validateCaseFolders(project);
  if (cases.length + groups.length > 1000) fail("超过1000项的完整样例图");
  const requests = new Map(
    project.requests.filter((r) => !r.deletedAt).map((r) => [r.id, r]),
  );
  const seen = new Set();
  for (const group of groups) {
    known(group, ["id", "name", "parentId", "sourceRequestId", "sort"], "分组");
    if (!requests.has(group.sourceRequestId)) fail("分组关联的已删除接口");
  }
  const rows = groups.map((group, index) => ({
    sample_id: id("sample-group", group.id),
    parent_id: group.parentId ? id("sample-group", group.parentId) : "0",
    target_id: id("a", group.sourceRequestId),
    project_id: projectId,
    name: group.name,
    type: "sample_group",
    method: "",
    url: "",
    sort: group.sort ?? index,
  }));
  for (const [index, item] of sortedCases(project).entries()) {
    known(
      item,
      [
        "id",
        "name",
        "sourceRequestId",
        "folderId",
        "request",
        "functions",
        "createdAt",
        "sort",
      ],
      "用例",
    );
    if (
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 200 ||
      seen.has(item.id)
    )
      fail("重复或缺失用例身份");
    seen.add(item.id);
    const origin = requests.get(item.sourceRequestId);
    if (!origin) fail("已删除或缺失接口归属");
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name !== item.name.trim() ||
      item.name.length > 200
    )
      fail("用例名称");
    if (
      item.sort !== undefined &&
      (!Number.isFinite(item.sort) || Math.abs(item.sort) > 1e9)
    )
      fail("用例排序");
    if (populated(item.functions)) fail("共享函数快照");
    const request = item.request;
    if (!request || typeof request !== "object" || Array.isArray(request))
      fail("完整请求快照");
    const normalized = normalizeRequest(request);
    known(request, Object.keys(normalized), "请求快照");
    for (const flag of [
      "serviceSnapshot",
      "parametersSnapshot",
      "authSnapshot",
      "sharedScriptsSnapshot",
    ])
      if (request[flag] !== true) fail("未冻结的继承配置");
    if (
      normalized.name !== item.name ||
      normalized.folder !== (origin.folder || "")
    )
      fail("请求名称或当前API目录关联");
    for (const key of [
      "beforeScript",
      "afterScript",
      "importedScriptTasks",
      "nativeTasks",
      "importedNativeTaskSource",
      "nativeMock",
      "schema",
      "responses",
      "examples",
      "statusId",
      "openapiExampleBindingsVersion",
      "openapiExampleSources",
      "deletedAt",
    ])
      if (populated(request[key])) fail("暂不支持的快照字段 " + key);
    const node = encodeRequest({
      ...request,
      id: id("sample-request", item.id),
    });
    rows.push({
      sample_id: id("sample", item.id),
      parent_id: item.folderId ? id("sample-group", item.folderId) : "0",
      target_id: id("a", item.sourceRequestId),
      project_id: projectId,
      type: "sample",
      name: item.name,
      sort: index,
      method: node.method,
      url: node.url,
      description: node.description,
      protocol: node.protocol,
      request: node.request,
      response: { example: node.response.example },
    });
  }
  return rows;
}

// Compare execution definitions, not regenerated IDs/import notes. The complete
// forward import is also the oracle for grouped samples' implicit API ancestry.
function semanticRequest(input, project) {
  const r = normalizeRequest(input);
  const server = r.serviceId
    ? project.servers?.find((s) => s.id === r.serviceId)
    : null;
  if (r.serviceId && !server) fail("服务身份");
  const result = { ...r, serviceId: server ? "default-service" : "" };
  for (const key of [
    "id",
    "sourceOperationId",
    "importNotes",
    "nativeMockRoute",
    "inheritAuth",
    "inheritSharedScripts",
    "inheritGlobalParameters",
  ])
    delete result[key];
  if (!r.beforeScript && !r.afterScript) delete result.scriptDialect;
  if (!r.cookies.length) delete result.cookieEncoding;
  for (const key of ["headers", "query", "path", "cookies", "form"])
    result[key] = r[key].map((row) => {
      known(
        row,
        [
          "key",
          "value",
          "enabled",
          "required",
          "description",
          "schema",
          "type",
        ],
        "参数",
      );
      if (row.type !== undefined && row.type !== "text") fail("参数类型");
      return {
        key: row.key,
        value: row.value,
        enabled: row.enabled !== false,
        required: row.required === true,
        description: row.description || "",
        schema: Object.keys(row.schema || {}).length
          ? row.schema
          : { type: "string" },
      };
    });
  // URL-only literal query rows are promoted by the existing API encoder.
  const at = result.url.indexOf("?");
  if (at >= 0) {
    const literal = [...new URLSearchParams(result.url.slice(at + 1))].map(
      ([key, value]) => ({
        key,
        value,
        enabled: true,
        required: false,
        description: "",
        schema: { type: "string" },
      }),
    );
    result.url = result.url.slice(0, at);
    result.query = [...literal, ...result.query];
  }
  return result;
}

export function verifySampleDefinitions(project, check, targetId) {
  const expected = sortedCases(project),
    actual = check.cases || [],
    groups = project.caseFolders || [],
    actualGroups = check.caseFolders || [];
  if (
    expected.length !== actual.length ||
    groups.length !== actualGroups.length
  )
    fail("完整样例图数量");
  const api = new Map(check.requests.map((r) => [r.sourceOperationId, r.id]));
  const actualGroupIds = new Map(
    groups.map((g, i) => [g.id, actualGroups[i]?.id]),
  );
  for (const [i, group] of groups.entries()) {
    const found = actualGroups[i];
    if (
      found.name !== group.name ||
      found.sourceRequestId !==
        api.get("apipost:" + targetId(group.sourceRequestId)) ||
      (found.parentId || "") !==
        (group.parentId ? actualGroupIds.get(group.parentId) : "") ||
      found.sort !== (group.sort ?? i)
    )
      fail("分组名称/排序/归属/父关系");
  }
  for (const [i, item] of expected.entries()) {
    const found = actual[i];
    if (
      found.name !== item.name ||
      found.sourceRequestId !==
        api.get("apipost:" + targetId(item.sourceRequestId)) ||
      (found.folderId || "") !==
        (item.folderId ? actualGroupIds.get(item.folderId) : "")
    )
      fail("用例名称/归属/父关系/顺序");
    if (
      !isDeepStrictEqual(
        semanticRequest(item.request, project),
        semanticRequest(found.request, check),
      )
    )
      fail("冻结请求语义（可能被活动API继承配置重新注入）");
  }
}
