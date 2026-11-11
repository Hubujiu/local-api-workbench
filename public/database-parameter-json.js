// Reject numeric values JSON.stringify would erase or cannot represent exactly.
// Finite decimal rounding and underflow have already happened during JSON.parse.
export function parseDatabaseParameterJSON(source) {
  return JSON.parse(source, (_key, value) => {
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)))
    )
      throw Error("数据库参数数字须有限且整数须安全；精确数字请使用字符串");
    return value;
  });
}
