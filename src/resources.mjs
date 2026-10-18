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
  const attributes = list("attributes");
  unique(attributes, "key");
  for (const field of attributes)
    if (
      typeof field.label !== "string" ||
      !["string", "number", "boolean"].includes(field.type)
    )
      throw Error("属性类型无效");
  const codes = list("statusCodes", 600);
  const seenCodes = new Set();
  for (const item of codes) {
    if (
      !Number.isInteger(item.code) ||
      item.code < 100 ||
      item.code > 599 ||
      typeof item.label !== "string" ||
      seenCodes.has(item.code)
    )
      throw Error("状态码字典无效或重复");
    seenCodes.add(item.code);
  }
  const functions = list("functions");
  unique(functions, "name");
  let bytes = 0;
  for (const fn of functions) {
    if (!/^[A-Za-z_$][\w$]*$/.test(fn.name) || typeof fn.body !== "string")
      throw Error("函数定义无效");
    bytes += Buffer.byteLength(fn.body);
  }
  if (bytes > 256000) throw Error("共享函数总大小超过256KB");
  return settings;
}
