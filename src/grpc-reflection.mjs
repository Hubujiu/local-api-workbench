import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import { executeGrpc } from "./grpc.mjs";
import { inspectGrpcSchema, normalizeGrpcSource } from "./grpc-schema.mjs";
// Internal elapsed deadlines are independent of civil-clock adjustments.
const monotonicNow = performance.now.bind(performance);
const protocols = Object.fromEntries(
  await Promise.all(
    ["v1", "v1alpha"].map(async (version) => [
      version,
      await readFile(
        new URL(
          "./vendor/grpc-reflection-" + version + ".proto",
          import.meta.url,
        ),
        "utf8",
      ),
    ]),
  ),
);
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const symbol = (value) =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value) &&
  !value.split(".").some((x) => unsafe.has(x));
function fileName(value) {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[-A-Za-z0-9_.]+(?:\/[-A-Za-z0-9_.]+)*\.proto$/.test(value) ||
    value.split("/").some((x) => x === "." || x === "..")
  )
    throw Error("反射返回了不安全的proto文件名");
  return value;
}
function validateDeclaredNames(file) {
  if (file.package && !symbol(file.package)) throw Error("反射包名无效");
  if (file.syntax && !["proto2", "proto3"].includes(file.syntax))
    throw Error("反射proto语法暂不支持");
  let count = 0;
  const visit = (node, depth = 0) => {
    if (depth > 32 || ++count > 10000) throw Error("反射描述符结构过大");
    if (
      node.name !== undefined &&
      (!symbol(node.name) || node.name.includes("."))
    )
      throw Error("反射声明名称无效");
    for (const key of [
      "messageType",
      "nestedType",
      "enumType",
      "field",
      "extension",
      "oneofDecl",
      "service",
      "method",
      "value",
    ])
      for (const child of node[key] || []) visit(child, depth + 1);
  };
  for (const key of ["messageType", "enumType", "service", "extension"])
    for (const child of file[key] || []) visit(child);
}
export async function reflectGrpc(input, signal) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        !["target", "service", "metadata", "tls", "timeoutMs"].includes(key),
    )
  )
    throw Error("gRPC反射参数无效");
  if (
    input.service !== undefined &&
    input.service !== "" &&
    !symbol(input.service)
  )
    throw Error("gRPC反射服务名无效");
  const timeout = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 30000)
    throw Error("gRPC反射超时须为50至30000毫秒");
  const started = monotonicNow(),
    end = started + timeout,
    files = new Map();
  let version = "v1",
    queries = 0,
    totalBytes = 0,
    lastCallStatus = null;
  const result = (code, details, extra = {}) => ({
    status: { code, details: String(details || "").slice(0, 2000) },
    version,
    mode: input.service ? "service-schema" : "service-list",
    queries,
    lastCallStatus,
    failureStage: code === 0 ? null : "exchange",
    durationMs: Math.max(0, Math.round(monotonicNow() - started)),
    complete: code === 0,
    files: [...files.keys()],
    ...extra,
  });
  const exchange = async (request) => {
    if (signal?.aborted) return { status: { code: 1, details: "已取消" } };
    // Never round a transport allowance above the aggregate remainder.
    const remaining = Math.floor(end - monotonicNow());
    if (remaining < 50)
      return { status: { code: 4, details: "gRPC反射总时限已到" } };
    if (queries >= 32)
      return { status: { code: 8, details: "gRPC反射查询超过32次" } };
    queries++;
    const call = await executeGrpc(
      {
        target: input.target,
        proto: protocols[version],
        service: "grpc.reflection." + version + ".ServerReflection",
        method: "ServerReflectionInfo",
        messages: [request],
        metadata: input.metadata,
        tls: input.tls,
        timeoutMs: remaining,
      },
      signal,
    );
    lastCallStatus = { ...call.status };
    return call;
  };
  const first = input.service
    ? { file_containing_symbol: input.service }
    : { list_services: "" };
  let reply = await exchange(first);
  // Only negotiate protocol version after an explicit UNIMPLEMENTED status.
  if (reply.status.code === 12) {
    version = "v1alpha";
    reply = await exchange(first);
  }
  if (reply.status.code !== 0)
    return result(reply.status.code, reply.status.details);
  const reflectionFailure = (error) => {
    if (
      !Number.isInteger(error.error_code) ||
      error.error_code < 1 ||
      error.error_code > 16
    )
      return result(15, "反射错误响应使用了无效状态码", {
        failureStage: "response-validation",
        reflectionErrorCode: error.error_code,
      });
    return result(error.error_code, error.error_message, {
      failureStage: "reflection-response",
    });
  };
  const response = () => {
    if (reply.messages?.length !== 1) throw Error("gRPC反射响应数量无效");
    const value = reply.messages[0];
    if (value.error_response) return { error: value.error_response };
    return { value };
  };
  try {
    let parsed = response();
    if (parsed.error) return reflectionFailure(parsed.error);
    if (!input.service) {
      const list = parsed.value.list_services_response?.service;
      if (
        !Array.isArray(list) ||
        list.length > 1000 ||
        list.some((x) => !symbol(x.name))
      )
        throw Error("gRPC反射服务列表无效");
      return result(0, "", {
        services: [...new Set(list.map((x) => x.name))].map((name) => ({
          name,
        })),
        schema: null,
      });
    }
    const admit = (value) => {
      const payloads = value.file_descriptor_response?.file_descriptor_proto;
      if (!Array.isArray(payloads) || !payloads.length || payloads.length > 32)
        throw Error("gRPC反射缺少文件描述符");
      for (const encoded of payloads) {
        if (typeof encoded !== "string") throw Error("gRPC反射描述符编码无效");
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded)
          throw Error("gRPC反射描述符编码无效");
        totalBytes += bytes.length;
        if (totalBytes > 262144) throw Error("gRPC反射描述符超过256KiB");
        const file = descriptor.FileDescriptorProto.decode(bytes),
          name = fileName(file.name),
          hash = createHash("sha256").update(bytes).digest("hex");
        validateDeclaredNames(file);
        for (const dependency of file.dependency || []) fileName(dependency);
        if (files.has(name) && files.get(name).hash !== hash)
          throw Error("gRPC反射返回冲突文件");
        files.set(name, { file, hash });
        if (files.size > 32) throw Error("gRPC反射文件超过32个");
      }
    };
    admit(parsed.value);
    while (true) {
      const missing = [...files.values()]
        .flatMap((x) => x.file.dependency || [])
        .find((name) => !files.has(name));
      if (!missing) break;
      reply = await exchange({ file_by_filename: missing });
      if (reply.status.code !== 0)
        return result(reply.status.code, reply.status.details);
      parsed = response();
      if (parsed.error) return reflectionFailure(parsed.error);
      admit(parsed.value);
      if (!files.has(missing)) throw Error("gRPC反射没有返回请求的依赖文件");
    }
    const root = protobuf.Root.fromDescriptor({
      file: [...files.values()].map((x) => x.file),
    });
    const { schema } = normalizeGrpcSource({ schema: root.toJSON() });
    const inspected = inspectGrpcSchema({ schema });
    if (!inspected.services.some((x) => x.name === input.service))
      return result(5, "反射描述符中不存在指定服务", {
        failureStage: "response-validation",
      });
    if (monotonicNow() > end)
      return result(4, "gRPC反射总时限已到", { failureStage: "budget" });
    return result(0, "", {
      schema,
      sha256: inspected.sha256,
      services: inspected.services,
    });
  } catch (error) {
    return result(
      /超过|过大/.test(error.message)
        ? 8
        : /暂不支持/.test(error.message)
          ? 12
          : 15,
      error.message,
      { schema: null, failureStage: "response-validation" },
    );
  }
}
