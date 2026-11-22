export function formFileRepresentation(field) {
  return Boolean(
    field &&
      (String(field.type || "").toLowerCase() === "file" ||
        field.requiresFile === true ||
        (typeof field.filename === "string" && field.filename !== "")),
  );
}

const hasPartMedia = (field) =>
  ["contentType", "content_type"].some((key) => Object.hasOwn(field, key));

export function unsupportedURLencodedForm(rows) {
  return rows.some(
    (field) => formFileRepresentation(field) || hasPartMedia(field),
  );
}

export function prepareFormTypeChange(field, nextType, bodyType) {
  if (!field || !["text", "file"].includes(nextType))
    throw Error("无效的表单字段类型");
  if (nextType === "file" && bodyType !== "form-data")
    throw Error("只有 multipart 表单可以选择文件");
  const wasFile = formFileRepresentation(field);
  const isFile = nextType === "file";
  if (wasFile === isFile) return null;
  const schema = field.schema;
  if (
    hasPartMedia(field) ||
    field.dynamic ||
    schema?.format === "binary" ||
    schema?.contentEncoding ||
    schema?.contentMediaType ||
    (isFile && schema?.type && schema.type !== "string")
  )
    throw Error(
      "字段含不兼容的结构、动态值或分项内容类型。请先移除相关配置，或保留原字段并新增所需字段。",
    );
  const confirm = Boolean(
    (field.value != null && field.value !== "") ||
      (typeof field.filename === "string" && field.filename !== ""),
  );
  const row = { ...field, type: nextType, value: "" };
  delete row.filename;
  delete row.requiresFile;
  if (isFile) row.requiresFile = true;
  return { row, confirm };
}

export const formTextExample = (field) =>
  formFileRepresentation(field) ? "" : field.value;
