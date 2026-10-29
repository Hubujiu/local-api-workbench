import contentType from "content-type";

// Literal per-part media only. Do not normalize persisted bytes or add a default.
export function validateMultipartPartMedia(request) {
  for (const row of request.form || []) {
    if (!Object.hasOwn(row, "contentType")) continue;
    const value = row.contentType;
    if (
      request.bodyType !== "form-data" ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 1024 ||
      value.trim() !== value ||
      /[^\x20-\x7e]/.test(value) ||
      value.includes("{{") ||
      value.includes("}}")
    )
      throw Error("multipart分项Content-Type须为1–1024字节的静态ASCII媒体类型");
    let parsed;
    try {
      parsed = contentType.parse(value);
    } catch {
      throw Error("multipart分项Content-Type媒体类型无效");
    }
    if (parsed.type.includes("*"))
      throw Error("multipart分项Content-Type不支持通配符");
  }
}

export function assertMultipartMediaExportable(request, format) {
  if ((request.form || []).some((row) => Object.hasOwn(row, "contentType")))
    throw Error(format + "不能保留multipart分项Content-Type；请使用项目备份");
}

export function postmanPartMedia(row) {
  return Object.hasOwn(row, "contentType")
    ? { contentType: row.contentType }
    : {};
}
