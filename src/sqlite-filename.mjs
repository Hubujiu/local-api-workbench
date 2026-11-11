// Reject before UTF-8 encoding can select a different on-disk file.
export function validateSQLiteFilename(filename) {
  if (typeof filename !== "string" || !filename.trim())
    throw Error("数据库路径为空");
  if (!filename.isWellFormed()) throw Error("SQLite数据库路径Unicode无效");
}
