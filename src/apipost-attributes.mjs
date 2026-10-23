import {
  validateAttributeDefinitions,
  validateAttributeValues,
} from "../public/attribute-model.js";
const types = {
  1: "string",
  2: "number",
  3: "select",
  4: "multiselect",
  5: "date",
  6: "url",
  7: "email",
};
function plain(value, allowed) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("Apipost属性须为普通对象");
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value))
    if (
      typeof key !== "string" ||
      (allowed && !allowed.includes(key)) ||
      !fields[key].enumerable ||
      !Object.hasOwn(fields[key], "value")
    )
      throw Error("Apipost属性包含未知字段或访问器");
}
function list(value, max) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw Error("Apipost属性数组格式或数量无效");
  const fields = Object.getOwnPropertyDescriptors(value);
  for (let i = 0; i < value.length; i++)
    if (!fields[i]?.enumerable || !Object.hasOwn(fields[i], "value"))
      throw Error("Apipost属性数组不能包含空洞或访问器");
  return value;
}
export function prepareApipostAttributes(rows, resource, projectId) {
  const ids = new Map();
  const fields = list(rows, 100)
    .map((row, index) => {
      plain(row, [
        "attribute_id",
        "project_id",
        "field_name",
        "field_type",
        "enable",
        "tooltip",
        "sort",
        "extra",
        "open_api_field",
      ]);
      const id = row.attribute_id;
      if (
        typeof id !== "string" ||
        !id.trim() ||
        id.length > 200 ||
        ["__proto__", "constructor", "prototype"].includes(id) ||
        ids.has(id)
      )
        throw Error("Apipost属性标识无效或重复");
      if (row.project_id !== undefined && row.project_id !== projectId)
        throw Error("Apipost属性项目来源不匹配");
      if (row.open_api_field !== undefined && row.open_api_field !== "")
        throw Error("Apipost属性的自定义OpenAPI字段映射暂不支持");
      const typeId = row.field_type === undefined ? 1 : row.field_type,
        type = types[typeId],
        enabled = row.enable === undefined ? 1 : row.enable,
        description = row.tooltip === undefined ? "" : row.tooltip,
        sort = row.sort === undefined ? index : row.sort;
      if (
        !Number.isInteger(typeId) ||
        !type ||
        ![1, 0, -1].includes(enabled) ||
        !Number.isSafeInteger(sort)
      )
        throw Error("Apipost属性类型、启停或排序无效");
      const options = list(row.extra === undefined ? [] : row.extra, 200).map(
        (option) => {
          plain(option, ["key", "value"]);
          return { value: option.key, label: option.value };
        },
      );
      if (!["select", "multiselect"].includes(type) && options.length)
        throw Error("Apipost非选择属性包含未支持的选项");
      const field = {
        key: resource("attribute", id),
        label: row.field_name,
        type,
        enabled: enabled === 1,
        description,
        ...(["select", "multiselect"].includes(type) ? { options } : {}),
        apipostSource: { projectId, attributeId: id, sort },
      };
      ids.set(id, field);
      return field;
    })
    .sort((a, b) => a.apipostSource.sort - b.apipostSource.sort);
  validateAttributeDefinitions(fields);
  return {
    fields,
    values(info) {
      if (info === undefined || info === null) return {};
      plain(info);
      const result = {};
      for (const [id, value] of Object.entries(info)) {
        const field = ids.get(id);
        if (!field) throw Error("Apipost接口属性引用不存在");
        result[field.key] = structuredClone(value);
      }
      validateAttributeValues(result, fields);
      return result;
    },
  };
}
export function mergeApipostAttributes(existing = [], incoming = []) {
  validateAttributeDefinitions(existing);
  const result = structuredClone(existing);
  for (const field of incoming) {
    const previous = result.find((item) => item.key === field.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(field))
      throw Error("Apipost属性定义冲突，请导入新项目");
    if (!previous) result.push(field);
  }
  validateAttributeDefinitions(result);
  return result;
}
