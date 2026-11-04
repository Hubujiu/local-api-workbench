import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  attributeOptions,
  validateAttributeDefinitions,
  validateAttributeValues,
} from "../public/attribute-model.js";

const typeIds = {
  string: 1,
  number: 2,
  select: 3,
  multiselect: 4,
  date: 5,
  url: 6,
  email: 7,
};
const fail = (reason) => {
  throw Error("原生属性导出不能无损保留" + reason + "；请使用项目备份");
};
function record(value, allowed) {
  if (
    !value ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("普通数据对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors))
    if (
      typeof key !== "string" ||
      (allowed && !allowed.includes(key)) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
      fail("未知字段或访问器");
  return value;
}
function own(value, key) {
  if (
    !value ||
    types.isProxy(value) ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("继承属性或非普通对象原型");
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (d && (!Object.hasOwn(d, "value") || !d.enumerable))
    fail("访问器或非数据字段");
  return d?.value;
}
function list(value, max) {
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    fail("数组数量或类型");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1)
    fail("数组扩展字段");
  for (let i = 0; i < value.length; i++)
    if (!descriptors[i]?.enumerable || !Object.hasOwn(descriptors[i], "value"))
      fail("数组空洞或访问器");
  return value;
}
function definitions(rows) {
  list(rows, 100);
  for (const field of rows) {
    record(field, [
      "key",
      "label",
      "type",
      "enabled",
      "description",
      "options",
      "apipostSource",
    ]);
    if (typeof field.type !== "string" || !Object.hasOwn(typeIds, field.type))
      fail("未支持的类型");
    if (field.options !== undefined) {
      list(field.options, 200);
      for (const option of field.options)
        if (typeof option !== "string") record(option, ["value", "label"]);
      if (
        !["select", "multiselect"].includes(field.type) &&
        field.options.length
      )
        fail("非选择类型的选项");
    }
    if (field.apipostSource !== undefined) {
      const s = record(field.apipostSource, [
        "projectId",
        "attributeId",
        "sort",
      ]);
      if (
        ![s.projectId, s.attributeId].every(
          (v) =>
            typeof v === "string" &&
            v.trim() &&
            v.length <= 200 &&
            !["__proto__", "constructor", "prototype"].includes(v),
        ) ||
        !Number.isSafeInteger(s.sort)
      )
        fail("历史来源");
    }
  }
  validateAttributeDefinitions(rows);
  return rows.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    enabled: f.enabled !== false,
    description: f.description ?? "",
    ...(["select", "multiselect"].includes(f.type)
      ? { options: attributeOptions(f) }
      : {}),
  }));
}
function values(value, fields) {
  if (value === undefined || value === null) return {};
  record(value);
  const keys = new Set(fields.map((f) => f.key));
  if (Object.keys(value).length > 100) fail("值数量");
  for (const [key, v] of Object.entries(value)) {
    if (!keys.has(key)) fail("未定义的属性引用");
    if (v === null || typeof v === "string") continue;
    if (typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0))
      continue;
    if (Array.isArray(v)) {
      list(v, 200);
      if (v.some((item) => typeof item !== "string")) fail("非文本多选值");
    } else fail("非JSON值或负零");
  }
  validateAttributeValues(value, fields);
  return value;
}
function rejectValues(object) {
  const value = own(object, "attributes");
  if (value === undefined || value === null) return;
  record(value);
  if (Object.keys(value).length) fail("样例、计划、文档或协议属性");
}

// Check before cloning, normalizing or enumerating values in the existing adapters.
export function preflightApipostAttributes(project) {
  const settings = own(project, "settings") ?? {};
  const storedFields = own(settings, "attributes");
  const fields = definitions(storedFields === undefined ? [] : storedFields);
  for (const request of list(own(project, "requests") ?? [], 5000))
    if (!own(request, "deletedAt")) values(own(request, "attributes"), fields);
  for (const key of ["documents", "protocols"])
    for (const item of list(own(project, key) ?? [], 5000)) rejectValues(item);
  for (const item of list(own(project, "cases") ?? [], 5000)) {
    const request = own(item, "request");
    if (request !== undefined) rejectValues(request);
  }
  for (const plan of list(own(project, "plans") ?? [], 1000))
    for (const step of list(own(plan, "steps") ?? [], 200)) {
      const request = own(step, "request");
      if (request !== undefined) rejectValues(request);
    }
  return fields;
}
export function prepareApipostAttributeExport(project, projectId) {
  if (
    typeof projectId !== "string" ||
    !projectId.trim() ||
    projectId.length > 200
  )
    fail("目标项目标识");
  const fields = preflightApipostAttributes(project);
  const ids = new Map(
    fields.map((f) => [
      f.key,
      "attr" +
        createHash("sha256")
          .update(JSON.stringify([projectId, f.key]))
          .digest("hex")
          .slice(0, 32),
    ]),
  );
  if (new Set(ids.values()).size !== ids.size) fail("标识冲突");
  return {
    fields,
    ids,
    projectId,
    rows: fields.map((f, index) => ({
      attribute_id: ids.get(f.key),
      project_id: projectId,
      field_name: f.label,
      field_type: typeIds[f.type],
      enable: f.enabled ? 1 : -1,
      tooltip: f.description,
      sort: index,
      extra: (f.options ?? []).map((o) => ({ key: o.value, value: o.label })),
      open_api_field: "",
    })),
    values(input) {
      return Object.fromEntries(
        Object.entries(values(input, fields)).map(([key, value]) => [
          ids.get(key),
          structuredClone(value),
        ]),
      );
    },
  };
}

export function verifyApipostAttributeExport(
  project,
  check,
  prepared,
  nativeRequestId,
) {
  const actual = check.settings?.attributes ?? [];
  const actualDefinitions = definitions(actual);
  if (actual.length !== prepared.fields.length) fail("定义数量回读");
  const byNative = new Map(
    actual.map((f, index) => [
      f.apipostSource?.attributeId,
      { field: f, definition: actualDefinitions[index] },
    ]),
  );
  if (byNative.size !== actual.length) fail("回读身份冲突");
  const keys = new Map();
  for (const [index, expected] of prepared.fields.entries()) {
    const nativeId = prepared.ids.get(expected.key),
      found = byNative.get(nativeId);
    if (
      !found ||
      found.field.apipostSource.projectId !== prepared.projectId ||
      actual[index].apipostSource.attributeId !== nativeId
    )
      fail("定义身份或顺序回读");
    const { key: oldKey, ...wanted } = expected,
      { key: newKey, ...got } = found.definition;
    if (!isDeepStrictEqual(wanted, got)) fail("定义回读");
    keys.set(oldKey, newKey);
  }
  for (const request of project.requests.filter((r) => !r.deletedAt)) {
    const matches = check.requests.filter(
      (r) => r.sourceOperationId === "apipost:" + nativeRequestId(request.id),
    );
    if (matches.length !== 1) fail("接口身份回读");
    const wanted = Object.fromEntries(
      Object.entries(values(request.attributes, prepared.fields)).map(
        ([key, value]) => [keys.get(key), value],
      ),
    );
    if (!isDeepStrictEqual(wanted, matches[0].attributes)) fail("显式值回读");
  }
}
