export const attributeTypes = [
  "string",
  "number",
  "select",
  "multiselect",
  "date",
  "url",
  "email",
  "boolean",
];
export function attributeOptions(field) {
  return (Array.isArray(field.options) ? field.options : []).map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option?.value, label: option?.label ?? option?.value },
  );
}
export function validateAttributeDefinitions(fields = []) {
  if (!Array.isArray(fields) || fields.length > 100)
    throw Error("属性定义最多100项");
  const seen = new Set();
  for (const field of fields) {
    if (
      !field ||
      typeof field.key !== "string" ||
      !field.key.trim() ||
      field.key !== field.key.trim() ||
      field.key.length > 200 ||
      ["__proto__", "prototype", "constructor"].includes(field.key) ||
      seen.has(field.key)
    )
      throw Error("属性标识无效或重复");
    seen.add(field.key);
    if (
      typeof field.label !== "string" ||
      !field.label.trim() ||
      field.label.length > 200 ||
      !attributeTypes.includes(field.type)
    )
      throw Error("属性类型或名称无效");
    if (field.enabled !== undefined && typeof field.enabled !== "boolean")
      throw Error("属性启停须为布尔值");
    if (
      field.description !== undefined &&
      (typeof field.description !== "string" || field.description.length > 2000)
    )
      throw Error("属性提示须为最多2000字符的文本");
    if (["select", "multiselect"].includes(field.type)) {
      const options = attributeOptions(field),
        values = new Set();
      if (!options.length || options.length > 200)
        throw Error("选择属性须有1–200个选项");
      for (const option of options) {
        if (
          typeof option.value !== "string" ||
          !option.value.trim() ||
          option.value.length > 200 ||
          typeof option.label !== "string" ||
          !option.label.trim() ||
          option.label.length > 200 ||
          values.has(option.value)
        )
          throw Error("属性选项无效或重复");
        values.add(option.value);
      }
    }
  }
}
export function validateAttributeValues(values = {}, fields = []) {
  if (values === null) return;
  if (typeof values !== "object" || Array.isArray(values))
    throw Error("属性值必须是对象");
  for (const [key, value] of Object.entries(values)) {
    if (
      ["__proto__", "prototype", "constructor"].includes(key) ||
      key.length > 200
    )
      throw Error("属性标识无效");
    const field = fields.find((item) => item.key === key);
    if (!field || value === undefined || value === null || value === "")
      continue;
    const invalid = () => {
      throw Error("属性 " + field.label + " 的" + field.type + "值无效");
    };
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) invalid();
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") invalid();
    } else if (["select", "multiselect"].includes(field.type)) {
      const selected = field.type === "multiselect" ? value : [value],
        allowed = new Set(attributeOptions(field).map((item) => item.value));
      if (
        !Array.isArray(selected) ||
        selected.some(
          (item) => typeof item !== "string" || !allowed.has(item),
        ) ||
        new Set(selected).size !== selected.length
      )
        throw Error("属性选项不匹配");
    } else {
      if (typeof value !== "string" || value.length > 4000) invalid();
      if (
        field.type === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          Number.isNaN(Date.parse(value + "T00:00:00Z")) ||
          new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value)
      )
        throw Error("日期属性无效");
      if (field.type === "url") {
        let url;
        try {
          url = new URL(value);
        } catch {
          throw Error("链接属性无效");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error("链接仅支持不含凭据的HTTP/HTTPS");
      }
      if (
        field.type === "email" &&
        !/^[^\s@<>]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)
      )
        throw Error("邮箱属性无效");
    }
  }
}
export function attributeInputValue(element, field) {
  if (field.type === "boolean") return element.checked;
  if (field.type === "multiselect")
    return [...element.selectedOptions].map((option) => option.value);
  if (element.value === "") return undefined;
  return field.type === "number" ? Number(element.value) : element.value;
}
