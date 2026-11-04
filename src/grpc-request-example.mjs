import protobuf from "protobufjs";
import { compileGrpcSchema } from "./grpc-schema.mjs";

// Deterministic, bounded, editable examples. This never invokes a business RPC.
export function generateGrpcRequestExample(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("gRPC请求示例参数无效");
  const { service, method, ...source } = input;
  if (
    typeof service !== "string" ||
    typeof method !== "string" ||
    !service ||
    !method ||
    service.length > 256 ||
    method.length > 256
  )
    throw Error("gRPC服务和方法无效");
  const compiled = compileGrpcSchema(source);
  const selected = compiled.methods.get(service + "/" + method);
  if (!selected) throw Error("gRPC方法不存在");
  let count = 0;
  const skippedRecursiveFields = [];
  const unsafe = new Set(["__proto__", "prototype", "constructor"]);
  function message(type, ancestry, depth, location) {
    if (depth > 32 || ++count > 10000) throw Error("gRPC请求示例结构过大");
    const result = Object.create(null);
    const oneofs = new Set();
    for (const field of type.fieldsArray) {
      if (unsafe.has(field.name)) throw Error("gRPC请求字段名不安全");
      if (field.partOf && oneofs.has(field.partOf.name)) continue;
      const nextPath = location ? location + "." + field.name : field.name;
      const target = field.resolvedType;
      if (target instanceof protobuf.Type && ancestry.has(target)) {
        if (field.required) throw Error("gRPC必填消息递归无法生成有限示例");
        skippedRecursiveFields.push(nextPath);
        continue;
      }
      if (++count > 10000) throw Error("gRPC请求示例结构过大");
      let value;
      if (target instanceof protobuf.Type) {
        const next = new Set(ancestry);
        next.add(target);
        value = message(target, next, depth + 1, nextPath);
      } else if (target instanceof protobuf.Enum) {
        const values = Object.keys(target.values);
        if (!values.length) throw Error("gRPC枚举没有值");
        value = values[0];
      } else if (field.type === "string" || field.type === "bytes") value = "";
      else if (field.type === "bool") value = false;
      else if (/^(?:s?fixed|s?int|u?int)64$/.test(field.type)) value = "0";
      else value = 0;
      if (field.map)
        result[field.name] = {
          [field.keyType === "bool"
            ? "false"
            : field.keyType === "string"
              ? "key"
              : "0"]: value,
        };
      else if (field.repeated) result[field.name] = [value];
      else result[field.name] = value;
      if (field.partOf) oneofs.add(field.partOf.name);
    }
    return result;
  }
  const example = message(selected.type, new Set([selected.type]), 0, "");
  const bytes = JSON.stringify(example);
  if (Buffer.byteLength(bytes) > 262144) throw Error("gRPC请求示例超过256KiB");
  const converted = selected.type.fromObject(example);
  const error = selected.type.verify(converted);
  if (error) throw Error("gRPC请求示例无法编码：" + error);
  selected.desc.requestSerialize(example);
  return {
    service,
    method,
    requestType: selected.type.fullName.slice(1),
    example: JSON.parse(bytes),
    skippedRecursiveFields,
    sha256: compiled.sha256,
  };
}
