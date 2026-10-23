import { validateParameterDescriptions } from "../public/parameter-descriptions.js";
import { validateAttributeDefinitions } from "../public/attribute-model.js";
import { validateErrorCodes } from "./error-codes.mjs";
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
export function validateResources(settings = {}) {
  const list = (key, max = 100) => {
    const value = settings[key] || [];
    if (!Array.isArray(value) || value.length > max)
      throw Error(key + " 数量或格式无效");
    return value;
  };
  const unique = (values, key) => {
    const seen = new Set();
    for (const item of values) {
      if (!item || typeof item !== "object") throw Error("资源定义无效");
      const id = item[key];
      if (typeof id !== "string" || !id || unsafe.has(id) || seen.has(id))
        throw Error("资源标识无效或重复");
      seen.add(id);
    }
  };
  const statuses = list("statuses");
  unique(statuses, "id");
  for (const status of statuses)
    if (
      typeof status.name !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(status.color)
    )
      throw Error("状态名称或颜色无效");
  validateAttributeDefinitions(settings.attributes || []);
  validateErrorCodes(settings.statusCodes || []);
  validateParameterDescriptions(settings.parameterDescriptions || []);
  const functions = list("functions");
  unique(functions, "name");
  let bytes = 0;
  for (const fn of functions) {
    if (
      !(
        fn.kind === "transform" ? /^[A-Za-z0-9_]+$/ : /^[A-Za-z_$][\w$]*$/
      ).test(fn.name) ||
      typeof fn.body !== "string" ||
      (fn.kind !== undefined && !["transform", "script"].includes(fn.kind))
    )
      throw Error("函数定义无效");
    if (fn.apipostSource !== undefined) {
      const origin = fn.apipostSource;
      if (
        fn.kind !== "transform" ||
        !/^fn_[A-Za-z0-9_]+$/.test(fn.name) ||
        fn.name.length > 200 ||
        !origin ||
        typeof origin !== "object" ||
        Array.isArray(origin) ||
        Object.keys(origin).some(
          (k) => !["projectId", "id", "description"].includes(k),
        ) ||
        typeof origin.projectId !== "string" ||
        !origin.projectId ||
        origin.projectId.length > 200 ||
        (origin.id !== undefined &&
          (typeof origin.id !== "string" ||
            !origin.id ||
            origin.id.length > 200)) ||
        typeof origin.description !== "string" ||
        origin.description.length > 8000
      )
        throw Error("Apipost共享函数来源或名称无效");
    }
    bytes += Buffer.byteLength(fn.body);
  }
  if (bytes > 256000) throw Error("共享函数总大小超过256KB");
  return settings;
}
