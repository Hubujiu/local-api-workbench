import { normalizeRequiredMetadata } from "./grpc-metadata-requirements.mjs";
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
export function redactNativeGrpcMetadata(source) {
  let count = 0;
  for (const proto of Array.isArray(source.protos) ? source.protos : [])
    for (const service of Array.isArray(proto?.services) ? proto.services : [])
      for (const method of Array.isArray(service?.methods)
        ? service.methods
        : [])
        for (const row of Array.isArray(method?.request?.metadata?.parameter)
          ? method.request.metadata.parameter
          : [])
          if (object(row) && Object.hasOwn(row, "value")) {
            delete row.value;
            count++;
          }
  return count;
}
export function nativeGrpcMetadata(rows = []) {
  if (!Array.isArray(rows) || rows.length > 100)
    throw Error("原版gRPC metadata行无效或超限");
  const required = [];
  for (const row of rows) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (k) =>
          ![
            "param_id",
            "key",
            "value",
            "is_checked",
            "description",
            "field_type",
            "not_null",
            "schema",
          ].includes(k),
      )
    )
      throw Error("原版gRPC metadata字段无效");
    if (
      typeof (row.key ?? "") !== "string" ||
      typeof (row.value ?? "") !== "string" ||
      Buffer.byteLength(row.value ?? "") > 8192
    )
      throw Error("原版gRPC metadata须为有界文本");
    if (
      row.field_type !== undefined &&
      !["string", "String"].includes(row.field_type)
    )
      throw Error("原版gRPC metadata类型尚未支持");
    if (
      row.schema !== undefined &&
      (!object(row.schema) ||
        Object.keys(row.schema).some((k) => k !== "type") ||
        row.schema.type !== "string")
    )
      throw Error("原版gRPC metadata Schema尚未支持");
    if (
      row.is_checked !== undefined &&
      (!Number.isInteger(row.is_checked) ||
        ![-1, 0, 1].includes(row.is_checked))
    )
      throw Error("原版gRPC metadata启用标志无效");
    const key = (row.key ?? "").trim();
    if ((row.is_checked ?? 1) <= 0 || !key) continue;
    if (key.includes("{{") || (row.value ?? "").includes("{{"))
      throw Error("原版gRPC metadata模板尚未支持");
    if (key.toLowerCase().endsWith("-bin"))
      throw Error("原版二进制metadata语义尚未验证；请使用独立运行时配置");
    required.push(key);
  }
  return required.length ? normalizeRequiredMetadata(required) : undefined;
}
