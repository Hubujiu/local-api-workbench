import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import path from "node:path";
import { createHash } from "node:crypto";
const cache = new Map(),
  unsafe = new Set(["__proto__", "prototype", "constructor"]);
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const common = {
  ...protobuf.common,
  "google/protobuf/descriptor.proto": descriptor.root.toJSON(),
};
export const grpcSource = (input) =>
  Object.fromEntries(
    ["proto", "files", "protoName", "schema"]
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
function jsonTree(value) {
  let count = 0;
  const walk = (node, depth = 0) => {
    if (depth > 32 || ++count > 10000) throw Error("gRPC schema结构过大");
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw Error("gRPC schema数值无效");
      return node;
    }
    if (typeof node === "string") {
      if (/[\uD800-\uDFFF]/u.test(node))
        throw Error("gRPC schema包含无效Unicode");
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (!plain(node)) throw Error("gRPC schema必须是JSON对象");
    return Object.fromEntries(
      Object.keys(node)
        .sort()
        .map((key) => {
          if (unsafe.has(key)) throw Error("gRPC schema含保留标识");
          return [key, walk(node[key], depth + 1)];
        }),
    );
  };
  return walk(value);
}
function filename(name) {
  if (
    typeof name !== "string" ||
    name.length > 240 ||
    !name.endsWith(".proto") ||
    !/^[-A-Za-z0-9_.]+(?:\/[-A-Za-z0-9_.]+)*$/.test(name) ||
    name.split("/").some((part) => part === "." || part === "..")
  )
    throw Error("gRPC虚拟proto文件名无效");
  return name;
}
function sourceText(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > 65536 ||
    value.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    throw Error("gRPC proto须为不超过64KiB的有效Unicode文本");
  return value;
}
export function normalizeGrpcSource(input) {
  if (typeof input === "string") input = { proto: input };
  if (
    !plain(input) ||
    Object.keys(input).some(
      (key) => !["proto", "files", "protoName", "schema"].includes(key),
    )
  )
    throw Error("gRPC schema来源无效");
  if (input.schema !== undefined) {
    if (
      input.proto !== undefined ||
      input.files !== undefined ||
      input.protoName !== undefined ||
      !plain(input.schema)
    )
      throw Error("gRPC schema与proto文件包不能混用");
    const schema = jsonTree(input.schema);
    if (Buffer.byteLength(JSON.stringify(schema)) > 262144)
      throw Error("gRPC schema超过256KiB");
    return { schema };
  }
  const proto = sourceText(input.proto),
    name = filename(
      input.protoName === undefined ? "main.proto" : input.protoName,
    ),
    files = input.files ?? {};
  if (!plain(files) || Object.keys(files).length > 32)
    throw Error("gRPC proto文件包最多32个附加文件");
  let bytes = Buffer.byteLength(proto);
  const normalized = {};
  for (const key of Object.keys(files).sort()) {
    filename(key);
    if (key === name || Object.hasOwn(common, key))
      throw Error("gRPC文件包不能覆盖入口或内置proto");
    normalized[key] = sourceText(files[key]);
    bytes += Buffer.byteLength(normalized[key]);
    if (bytes > 262144) throw Error("gRPC proto文件包超过256KiB");
  }
  return {
    proto,
    ...(Object.keys(normalized).length ? { files: normalized } : {}),
    ...(input.protoName !== undefined ? { protoName: name } : {}),
  };
}
export function compileGrpcSchema(input) {
  const source = normalizeGrpcSource(input),
    key = JSON.stringify(source);
  if (cache.has(key)) return cache.get(key);
  let root;
  const loaded = [],
    unused = [];
  if (source.schema)
    root = protobuf.Root.fromJSON(structuredClone(source.schema));
  else {
    root = new protobuf.Root();
    const entry = source.protoName || "main.proto",
      files = source.files || {},
      visited = new Set();
    const resolve = (origin, target) => {
      if (
        typeof target !== "string" ||
        !target ||
        target.startsWith("/") ||
        target.includes("\\") ||
        target.includes(":") ||
        target.includes("\0")
      )
        throw Error("gRPC proto导入路径无效");
      const candidates = [
        path.posix.normalize(target),
        path.posix.normalize(
          path.posix.join(path.posix.dirname(origin), target),
        ),
      ];
      for (const candidate of [...new Set(candidates)]) {
        try {
          filename(candidate);
        } catch {
          continue;
        }
        if (
          candidate === entry ||
          Object.hasOwn(files, candidate) ||
          Object.hasOwn(common, candidate)
        )
          return candidate;
      }
      throw Error("gRPC文件包缺少导入：" + target.slice(0, 240));
    };
    const visit = (name, depth = 0) => {
      if (visited.has(name)) return;
      if (depth > 32 || visited.size >= 64)
        throw Error("gRPC proto导入层级或数量过多");
      visited.add(name);
      loaded.push(name);
      if (Object.hasOwn(common, name)) {
        root.addJSON(structuredClone(common[name].nested));
        return;
      }
      const text = name === entry ? source.proto : files[name];
      if (text === undefined) throw Error("gRPC文件包缺少导入：" + name);
      const parsed = protobuf.parse(text, root, { keepCase: true });
      for (const imported of [
        ...(parsed.imports || []),
        ...(parsed.weakImports || []),
      ])
        visit(resolve(name, imported), depth + 1);
    };
    visit(entry);
    for (const name of Object.keys(files))
      if (!visited.has(name)) unused.push(name);
  }
  root.resolveAll();
  const json = jsonTree(root.toJSON());
  const definition = protoLoader.fromJSON(json, {
    keepCase: true,
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
    oneofs: true,
    json: true,
  });
  const methods = new Map(),
    services = [];
  const visit = (node) => {
    if (node instanceof protobuf.Service) {
      const name = node.fullName.slice(1),
        rows = [];
      for (const method of node.methodsArray) {
        const desc = definition[name]?.[method.name];
        if (!desc) throw Error("gRPC方法描述不可用");
        methods.set(name + "/" + method.name, {
          desc,
          type: method.resolvedRequestType,
        });
        rows.push({
          name: method.name,
          path: desc.path,
          requestStream: desc.requestStream,
          responseStream: desc.responseStream,
          requestType: method.resolvedRequestType.fullName.slice(1),
          responseType: method.resolvedResponseType.fullName.slice(1),
        });
      }
      services.push({ name, methods: rows });
    }
    for (const child of node.nestedArray || []) visit(child);
  };
  visit(root);
  if (!services.length || methods.size > 1000)
    throw Error("gRPC schema须含1至1000个方法");
  const result = {
    methods,
    services,
    sha256: createHash("sha256").update(key).digest("hex"),
    loaded,
    unused,
    source,
  };
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
export function inspectGrpcSchema(input) {
  const value = compileGrpcSchema(input);
  return {
    sha256: value.sha256,
    services: structuredClone(value.services),
    files: { loaded: value.loaded.slice(), unused: value.unused.slice() },
    externalImports: false,
  };
}
