import {
  compileGrpcSchema as compile,
  normalizeGrpcSource,
  grpcSource,
} from "./grpc-schema.mjs";
export { inspectGrpcSchema } from "./grpc-schema.mjs";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const MAX_BYTES = 1024 * 1024;
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("gRPC地址无效");
  }
  if (
    !["grpc:", "grpcs:"].includes(url.protocol) ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw Error("gRPC地址必须为无凭据和路径的grpc(s)://主机:端口");
  return { target: url.host, secure: url.protocol === "grpcs:" };
}
export function normalizeGrpcDefinition(input) {
  if (!plain(input)) throw Error("gRPC定义无效");
  for (const key of Object.keys(input))
    if (
      ![
        "id",
        "name",
        "target",
        "proto",
        "files",
        "protoName",
        "schema",
        "service",
        "method",
        "timeoutMs",
      ].includes(key)
    )
      throw Error("gRPC定义不保存额外字段或凭据");
  const id = input.id || randomUUID();
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(id))
    throw Error("gRPC定义ID无效");
  endpoint(input.target);
  const source = normalizeGrpcSource(grpcSource(input));
  const schema = compile(source);
  const service = input.service || "",
    method = input.method || "";
  if (
    typeof service !== "string" ||
    typeof method !== "string" ||
    service.length > 256 ||
    method.length > 256 ||
    (method && !service) ||
    (service && !schema.services.some((x) => x.name === service)) ||
    (method && !schema.methods.has(service + "/" + method))
  )
    throw Error("gRPC服务或方法不存在");
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000)
    throw Error("gRPC超时须为50至30000毫秒");
  return {
    id,
    name: String(input.name || "gRPC").slice(0, 200),
    target: input.target,
    ...source,
    service,
    method,
    timeoutMs,
  };
}
export function normalizeGrpcDefinitions(values = []) {
  if (!Array.isArray(values) || values.length > 100)
    throw Error("gRPC定义最多100个");
  const result = values.map(normalizeGrpcDefinition);
  if (new Set(result.map((x) => x.id)).size !== result.length)
    throw Error("gRPC定义ID重复");
  return result;
}
function checkLong(value, unsigned) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw Error("gRPC 64位整数必须使用精确十进制字符串");
    value = String(value);
  }
  if (
    typeof value !== "string" ||
    !/^(-?(?:0|[1-9]\d*))$/.test(value) ||
    value.length > 21
  )
    throw Error("gRPC整数格式无效");
  const n = BigInt(value);
  if (
    n < (unsigned ? 0n : -(1n << 63n)) ||
    n > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n)
  )
    throw Error("gRPC整数超出范围");
}
function validateMessage(type, value, state = { nodes: 0 }, depth = 0) {
  if (!plain(value) || depth > 32 || ++state.nodes > 10000)
    throw Error("gRPC消息必须是有界JSON对象");
  for (const field of type.fieldsArray)
    if (field.required && !Object.hasOwn(value, field.name))
      throw Error("gRPC必填字段缺失：" + field.name);
  for (const [name, item] of Object.entries(value)) {
    if (unsafe.has(name)) throw Error("gRPC消息含保留字段");
    const field = Object.hasOwn(type.fields, name)
      ? type.fields[name]
      : undefined;
    if (!field) {
      const oneof =
        type.oneofs && Object.hasOwn(type.oneofs, name)
          ? type.oneofs[name]
          : undefined;
      if (
        oneof &&
        typeof item === "string" &&
        oneof.oneof.includes(item) &&
        Object.hasOwn(value, item)
      )
        continue;
      throw Error("gRPC消息包含未知字段：" + name);
    }
    const scalar = (input) => {
      if (++state.nodes > 10000) throw Error("gRPC消息字段过多");
      if (field.resolvedType instanceof protobuf.Type)
        return validateMessage(field.resolvedType, input, state, depth + 1);
      if (field.resolvedType instanceof protobuf.Enum) {
        if (
          (typeof input === "string" &&
            Object.hasOwn(field.resolvedType.values, input)) ||
          (Number.isInteger(input) &&
            Object.hasOwn(field.resolvedType.valuesById, input))
        )
          return;
        throw Error("gRPC枚举值无效");
      }
      if (
        ["int64", "sint64", "sfixed64", "uint64", "fixed64"].includes(
          field.type,
        )
      )
        return checkLong(input, ["uint64", "fixed64"].includes(field.type));
      if (field.type === "string") {
        if (typeof input !== "string") throw Error("gRPC字符串类型无效");
        if (/[\uD800-\uDFFF]/u.test(input))
          throw Error("gRPC字符串包含无效Unicode");
        return;
      }
      if (field.type === "bool") {
        if (typeof input !== "boolean") throw Error("gRPC布尔类型无效");
        return;
      }
      if (field.type === "bytes") {
        if (
          typeof input !== "string" ||
          Buffer.from(input, "base64").toString("base64") !== input
        )
          throw Error("gRPC字节字段须为规范base64");
        return;
      }
      if (typeof input !== "number" || !Number.isFinite(input))
        throw Error("gRPC数值类型无效");
      if (!["double", "float"].includes(field.type)) {
        const unsigned = ["uint32", "fixed32"].includes(field.type);
        if (
          !Number.isInteger(input) ||
          input < (unsigned ? 0 : -2147483648) ||
          input > (unsigned ? 4294967295 : 2147483647)
        )
          throw Error("gRPC数值超出范围");
      }
    };
    if (field.map) {
      if (!plain(item) || Object.keys(item).length > 1000)
        throw Error("gRPC map无效");
      for (const [key, mapValue] of Object.entries(item)) {
        if (unsafe.has(key)) throw Error("gRPC map含保留键");
        if (field.keyType === "bool" && !["true", "false"].includes(key))
          throw Error("gRPC map布尔键无效");
        if (field.keyType !== "string" && field.keyType !== "bool") {
          checkLong(
            key,
            ["uint32", "fixed32", "uint64", "fixed64"].includes(field.keyType),
          );
          if (!field.keyType.includes("64")) {
            const n = Number(key),
              u = ["uint32", "fixed32"].includes(field.keyType);
            if (n < (u ? 0 : -2147483648) || n > (u ? 4294967295 : 2147483647))
              throw Error("gRPC map键超出范围");
          }
        }
        scalar(mapValue);
      }
    } else if (field.repeated) {
      if (!Array.isArray(item) || item.length > 1000)
        throw Error("gRPC重复字段须为有界数组");
      for (const entry of item) scalar(entry);
    } else scalar(item);
  }
  const converted = type.fromObject(value),
    error = type.verify(converted);
  if (error) throw Error("gRPC消息不符合proto：" + error);
}
function inputMetadata(values = []) {
  if (!Array.isArray(values) || values.length > 100)
    throw Error("gRPC metadata须为至多100项数组");
  const metadata = new grpc.Metadata();
  let bytes = 0;
  for (const row of values) {
    if (
      !plain(row) ||
      typeof row.key !== "string" ||
      !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(row.key) ||
      row.key.toLowerCase().startsWith("grpc-") ||
      typeof row.value !== "string"
    )
      throw Error("gRPC metadata无效");
    let value = row.value;
    if (row.key.toLowerCase().endsWith("-bin")) {
      value = Buffer.from(value, "base64");
      if (value.toString("base64") !== row.value)
        throw Error("gRPC metadata二进制编码无效");
    } else if (/[^\x20-\x7e]/.test(value))
      throw Error("gRPC metadata文本仅支持可打印ASCII");
    bytes += Buffer.byteLength(row.key) + Buffer.byteLength(value);
    if (bytes > 8192) throw Error("gRPC metadata超过8KiB");
    metadata.add(row.key, value);
  }
  return metadata;
}
function outputMetadata(metadata) {
  const result = [];
  let bytes = 0;
  for (const key of Object.keys(metadata?.getMap() || {}))
    for (const value of metadata.get(key)) {
      const binary = Buffer.isBuffer(value),
        text = binary ? value.toString("base64") : String(value);
      bytes += Buffer.byteLength(key) + Buffer.byteLength(text);
      if (bytes > 16384) throw Error("gRPC响应metadata超过16KiB");
      result.push({ key, value: text, binary });
    }
  return result;
}
export function grpcTransport(target, input = {}) {
  const metadata = inputMetadata(input.metadata),
    address = endpoint(target);
  const tls = input.tls ?? {};
  if (
    !plain(tls) ||
    Object.keys(tls).some((k) => !["ca", "key", "cert"].includes(k))
  )
    throw Error("gRPC TLS配置无效");
  if (!address.secure && Object.keys(tls).length)
    throw Error("明文gRPC不能携带TLS配置");
  for (const value of Object.values(tls))
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 65536)
      throw Error("gRPC证书须为有界PEM文本");
  if (Boolean(tls.key) !== Boolean(tls.cert))
    throw Error("gRPC双向TLS须同时提供证书和私钥");
  const credentials = address.secure
    ? grpc.credentials.createSsl(
        tls.ca ? Buffer.from(tls.ca) : undefined,
        tls.key ? Buffer.from(tls.key) : undefined,
        tls.cert ? Buffer.from(tls.cert) : undefined,
      )
    : grpc.credentials.createInsecure();
  return { metadata, address, credentials };
}
export async function executeGrpc(input, signal) {
  if (
    !plain(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "target",
          "proto",
          "files",
          "protoName",
          "schema",
          "service",
          "method",
          "timeoutMs",
          "messages",
          "metadata",
          "tls",
        ].includes(key),
    )
  )
    throw Error("gRPC调用字段无效");
  const definition = normalizeGrpcDefinition(
    Object.fromEntries(
      [
        "target",
        "proto",
        "files",
        "protoName",
        "schema",
        "service",
        "method",
        "timeoutMs",
      ]
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    ),
  );
  const selected = compile(grpcSource(definition)).methods.get(
    definition.service + "/" + definition.method,
  );
  if (!selected) throw Error("gRPC执行必须指定服务和方法");
  const { desc, type } = selected,
    messages = input.messages ?? [{}];
  if (
    !Array.isArray(messages) ||
    messages.length > 100 ||
    (!desc.requestStream && messages.length !== 1)
  )
    throw Error("非客户端流式gRPC须有且仅有一个请求消息；流式请求最多100条");
  const text = JSON.stringify(messages);
  if (!text || Buffer.byteLength(text) > MAX_BYTES)
    throw Error("gRPC请求消息超过1MiB");
  for (const message of messages) {
    validateMessage(type, message);
    if (desc.requestSerialize(message).length > MAX_BYTES)
      throw Error("gRPC请求编码超过1MiB");
  }
  const { metadata, address, credentials } = grpcTransport(
    definition.target,
    input,
  );
  const start = performance.now(),
    result = {
      id: randomUUID(),
      service: definition.service,
      method: definition.method,
      path: desc.path,
      streaming: { request: desc.requestStream, response: desc.responseStream },
      messages: [],
      metadata: [],
      trailers: [],
      status: null,
      truncated: false,
      bytes: 0,
    };
  if (signal?.aborted)
    return {
      ...result,
      status: { code: grpc.status.CANCELLED, details: "已取消" },
      durationMs: 0,
    };
  const client = new grpc.Client(address.target, credentials, {
    "grpc.enable_retries": 0,
    "grpc.enable_http_proxy": 0,
    "grpc.max_send_message_length": MAX_BYTES,
    "grpc.max_receive_message_length": MAX_BYTES,
    "grpc.max_metadata_size": 16384,
  });
  return new Promise((resolve) => {
    let call,
      settled = false,
      timer;
    const finish = (code, details, trailers) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        if (trailers) result.trailers = outputMetadata(trailers);
      } catch (error) {
        code = grpc.status.RESOURCE_EXHAUSTED;
        details = error.message;
      }
      result.status = { code, details: String(details || "").slice(0, 2000) };
      result.durationMs = performance.now() - start;
      if (code !== 0) call?.cancel();
      client.close();
      resolve(result);
    };
    const abort = () => finish(grpc.status.CANCELLED, "已取消");
    const receive = (value) => {
      if (settled) return;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (result.messages.length >= 100 || result.bytes + bytes > MAX_BYTES) {
        result.truncated = true;
        finish(grpc.status.RESOURCE_EXHAUSTED, "gRPC响应超过100条或1MiB");
        return;
      }
      result.bytes += bytes;
      result.messages.push(value);
    };
    const callback = (error, value) => {
      if (error) {
        finish(
          error.code ?? grpc.status.UNKNOWN,
          error.details || error.message,
          error.metadata,
        );
        return;
      }
      if (value !== undefined) receive(value);
    };
    const options = { deadline: new Date(Date.now() + definition.timeoutMs) };
    try {
      if (!desc.requestStream && !desc.responseStream)
        call = client.makeUnaryRequest(
          desc.path,
          desc.requestSerialize,
          desc.responseDeserialize,
          messages[0],
          metadata,
          options,
          callback,
        );
      else if (!desc.requestStream)
        call = client.makeServerStreamRequest(
          desc.path,
          desc.requestSerialize,
          desc.responseDeserialize,
          messages[0],
          metadata,
          options,
        );
      else if (!desc.responseStream)
        call = client.makeClientStreamRequest(
          desc.path,
          desc.requestSerialize,
          desc.responseDeserialize,
          metadata,
          options,
          callback,
        );
      else
        call = client.makeBidiStreamRequest(
          desc.path,
          desc.requestSerialize,
          desc.responseDeserialize,
          metadata,
          options,
        );
      call.on("metadata", (value) => {
        if (settled) return;
        try {
          result.metadata = outputMetadata(value);
        } catch (error) {
          finish(grpc.status.RESOURCE_EXHAUSTED, error.message);
        }
      });
      call.on("status", (value) =>
        finish(value.code, value.details, value.metadata),
      );
      call.on("error", (error) =>
        finish(
          error.code ?? grpc.status.UNKNOWN,
          error.details || error.message,
          error.metadata,
        ),
      );
      if (desc.responseStream) call.on("data", receive);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => finish(grpc.status.DEADLINE_EXCEEDED, "gRPC调用超时"),
        definition.timeoutMs,
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      if (desc.requestStream) {
        for (const message of messages) call.write(message);
        call.end();
      }
    } catch (error) {
      finish(grpc.status.UNKNOWN, error.message);
    }
  });
}

export function validateProtocolRuns(values = []) {
  if (!Array.isArray(values) || values.length > 50)
    throw Error("协议执行记录最多50条");
  const ids = new Set();
  for (const record of values) {
    if (
      !plain(record) ||
      record.type !== "grpc" ||
      typeof record.id !== "string" ||
      record.id.length > 200 ||
      !record.id ||
      ids.has(record.id) ||
      !plain(record.result) ||
      !plain(record.result.status) ||
      !Number.isInteger(record.result.status.code) ||
      record.result.status.code < 0 ||
      record.result.status.code > 16 ||
      !Array.isArray(record.result.messages) ||
      record.result.messages.length > 100 ||
      !Array.isArray(record.requestMessages) ||
      record.requestMessages.length > 100
    )
      throw Error("协议执行记录格式无效");
    ids.add(record.id);
    normalizeGrpcDefinition(record.definition);
    if (Buffer.byteLength(JSON.stringify(record)) > 3 * MAX_BYTES)
      throw Error("协议执行记录超过3MiB");
  }
}
