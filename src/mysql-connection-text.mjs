// Guard only text fidelity, not types/defaults or driver authorization. All
// existing provider/entrypoint-specific configuration rules remain in place.
export function validateMySQLConnectionText(input) {
  for (const field of ["user", "password", "database"])
    if (typeof input[field] === "string" && !input[field].isWellFormed())
      throw Error("MySQL连接文本Unicode无效");
}
