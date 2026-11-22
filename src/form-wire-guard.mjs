// Admission for outbound bytes and executable representations only. Stored
// definitions (including imported legacy rows) must remain readable and intact.
export function assertActiveFormFileEncoding({ bodyType, form }) {
  if (bodyType !== "urlencoded" && bodyType !== "form-data") return;
  for (const row of form || []) {
    if (row.enabled === false) continue;
    const file = row.type === "file";
    const marked = Boolean(row.filename) || row.requiresFile === true;
    if (bodyType === "urlencoded" && (file || marked))
      throw Error(
        "URLencoded 表单仅支持文本。请移除文件字段，或切换到 multipart/form-data 并重新选择文件。",
      );
    if (bodyType === "form-data" && !file && marked)
      throw Error(
        "multipart 文本字段仍带有文件标记。请重新创建文本字段，或改为文件并重新选择。",
      );
  }
}
