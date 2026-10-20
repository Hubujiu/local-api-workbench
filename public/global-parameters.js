export const globalParameterKinds = ["headers", "query", "cookies", "form"];
export function validateGlobalParameters(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("全局参数必须是对象");
  if (Object.keys(value).some((key) => !globalParameterKinds.includes(key)))
    throw Error("全局参数仅支持 Header、Query、Cookie 和表单文本");
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
    throw Error("全局参数最多 64 KiB");
  return Object.fromEntries(
    globalParameterKinds.map((kind) => {
      const rows = value[kind] ?? [];
      if (!Array.isArray(rows) || rows.length > 100)
        throw Error("每类全局参数最多 100 条");
      const seen = new Set();
      return [
        kind,
        rows.map((row) => {
          if (
            !row ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            Object.keys(row).some(
              (key) => !["key", "value", "enabled"].includes(key),
            )
          )
            throw Error("全局参数仅接受 key、value、enabled");
          if (
            typeof row.key !== "string" ||
            !row.key.trim() ||
            row.key.length > 200 ||
            /[\r\n\0]/.test(row.key) ||
            typeof row.value !== "string"
          )
            throw Error("全局参数名和值必须为文本，名称不可为空");
          if (row.enabled !== undefined && typeof row.enabled !== "boolean")
            throw Error("参数启用状态必须为布尔值");
          if (
            kind === "headers" &&
            (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.key) ||
              /[\r\n\0]/.test(row.value))
          )
            throw Error("Header 名称或值无效");
          if (
            kind === "cookies" &&
            (/[\s;=,]/.test(row.key) || /[\r\n\0;]/.test(row.value))
          )
            throw Error("Cookie 名称或值无效");
          const key = kind === "headers" ? row.key.toLowerCase() : row.key;
          if (seen.has(key)) throw Error("全局参数名重复：" + row.key);
          seen.add(key);
          return {
            key: row.key,
            value: row.value,
            enabled: row.enabled !== false,
          };
        }),
      ];
    }),
  );
}
