const reserved = new Set([
  "user-agent",
  "content-type",
  "te",
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "proxy-authorization",
  "accept-encoding",
]);
export function grpcMetadataName(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value) ||
    value.toLowerCase().startsWith("grpc-") ||
    reserved.has(value.toLowerCase())
  )
    throw Error("gRPC metadata名称无效或属于受控字段");
  return value.toLowerCase();
}
export function normalizeRequiredMetadata(value) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 8192
  )
    throw Error("gRPC所需metadata无效或超限");
  const keys = value.map(grpcMetadataName);
  if (new Set(keys).size !== keys.length)
    throw Error("gRPC所需metadata名称重复");
  return keys.sort();
}
export function assertRequiredMetadata(required, metadata) {
  for (const key of normalizeRequiredMetadata(required) || [])
    if (!metadata.get(key).length)
      throw Error("缺少gRPC运行时metadata: " + key);
}
