import { executionRecords } from "./apipost-execution-files.mjs";
import {
  directoryArtifactPath,
  normalizeDirectoryArtifacts,
} from "./apipost-directory-artifacts.mjs";
import { isDeepStrictEqual } from "node:util";
import {
  allowedDirectoryPath,
  nativeMockTargetId,
  directorySettings as settings,
} from "../public/apipost-directory-input.js";
// Read-only assembly of a bounded, explicitly selected original JSON file set.
// This does not execute the original application or read paths from the host.
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const id = (x) =>
  typeof x === "string" &&
  /^[A-Za-z0-9_-]{1,200}$/.test(x) &&
  !["__proto__", "constructor", "prototype", "index"].includes(x);
export function isApipostDirectoryDocument(value) {
  return object(value) && value.format === "apipost-offline-directory-v1";
}
export function assembleApipostDirectory(document) {
  if (
    !isApipostDirectoryDocument(document) ||
    Object.keys(document).some((k) => !["format", "files"].includes(k)) ||
    !Array.isArray(document.files) ||
    !document.files.length ||
    document.files.length > 5000
  )
    throw Error("Apipost目录文件清单无效或超过5000项");
  const files = new Map();
  let bytes = 0;
  for (const entry of document.files) {
    if (
      !object(entry) ||
      Object.keys(entry).some((k) => !["path", "text"].includes(k)) ||
      typeof entry.path !== "string" ||
      entry.path.length > 300 ||
      typeof entry.text !== "string"
    )
      throw Error("Apipost目录条目无效");
    const path = entry.path;
    if (
      !/^[A-Za-z0-9_/-]+\.json$/.test(path) ||
      path.startsWith("/") ||
      path.includes("//") ||
      files.has(path)
    )
      throw Error("Apipost目录路径不安全或重复");
    const allowed = allowedDirectoryPath(path);
    if (!allowed)
      throw Error("Apipost目录暂不支持文件: " + path + "；不会忽略未迁移数据");
    bytes += new TextEncoder().encode(entry.text).length + path.length;
    if (bytes > 4 * 1024 * 1024) throw Error("Apipost目录JSON合计最多4MiB");
    let value;
    try {
      value = JSON.parse(entry.text);
    } catch {
      throw Error("Apipost目录JSON损坏: " + path);
    }
    files.set(path, value);
  }
  const project = files.get("project.json");
  if (
    !object(project) ||
    !id(project.project_id) ||
    typeof project.name !== "string" ||
    !project.name.trim()
  )
    throw Error("Apipost目录缺少有效project.json");
  const projectId = project.project_id;
  const artifact = document.files.find(
    (file) => file.path === directoryArtifactPath,
  );
  if (artifact)
    normalizeDirectoryArtifacts([
      { sourceProjectId: projectId, files: [artifact] },
    ]);
  const collection = (dir, field, wrapped) => {
    const index = files.get(dir + "/index.json");
    const paths = [...files.keys()].filter(
      (p) => p.startsWith(dir + "/") && p !== dir + "/index.json",
    );
    if (index === undefined && paths.length === 0) return [];
    if (
      !object(index) ||
      index.project_id !== projectId ||
      !Array.isArray(index.items)
    )
      throw Error("Apipost目录索引缺失或项目不匹配: " + dir);
    const seen = new Set();
    const rows = index.items.map((item) => {
      if (!object(item) || !id(item[field]) || seen.has(item[field]))
        throw Error("Apipost目录索引标识无效或重复: " + dir);
      const key = item[field];
      seen.add(key);
      const row = files.get(dir + "/" + key + ".json");
      if (!object(row) || row[field] !== key || row.project_id !== projectId)
        throw Error("Apipost目录记录缺失或身份不匹配: " + dir + "/" + key);
      for (const name of [
        "name",
        "parent_id",
        "sort",
        "target_type",
        "method",
        "url",
        "mark_id",
        "model_type",
        "type",
      ])
        if (
          Object.hasOwn(item, name) &&
          Object.hasOwn(row, name) &&
          JSON.stringify(item[name]) !== JSON.stringify(row[name])
        )
          throw Error(
            "Apipost目录索引与记录不一致，请先在原版完成保存: " +
              dir +
              "/" +
              key,
          );
      if (!wrapped) return structuredClone(row);
      if (!object(row.data))
        throw Error("Apipost目录记录缺少data对象: " + dir + "/" + key);
      const data = structuredClone(row.data);
      for (const name of [
        field,
        "project_id",
        "name",
        "parent_id",
        "sort",
        "target_type",
        "method",
        "url",
        "mark_id",
        "model_type",
        "type",
      ])
        if (Object.hasOwn(row, name)) {
          if (
            Object.hasOwn(data, name) &&
            !(
              name === "sort" &&
              data.sort === 0 &&
              [
                "websocket2",
                "socket",
                "socket_method",
                "sse",
                "socketio",
                "grpc",
              ].includes(row.target_type)
            ) &&
            JSON.stringify(data[name]) !== JSON.stringify(row[name])
          )
            throw Error(
              "Apipost目录内部记录身份或元数据冲突: " + dir + "/" + key,
            );
          data[name] = row[name];
        }
      return data;
    });
    if (paths.length !== seen.size)
      throw Error("Apipost目录存在未列入索引的记录: " + dir);
    return rows;
  };
  const flows = executionRecords(files, "flows", projectId);
  executionRecords(files, "runs", projectId);
  const envs = collection("envs", "env_id", false);
  const servers = new Map();
  for (const env of envs) {
    if (!Array.isArray(env.server_list || []))
      throw Error("Apipost目录环境服务表无效");
    for (const server of env.server_list || []) {
      if (!object(server) || !id(server.server_id))
        throw Error("Apipost目录服务标识无效");
      if (!servers.has(server.server_id))
        servers.set(server.server_id, {
          server_id: server.server_id,
          name: server.name || "服务 " + server.server_id,
        });
    }
  }
  const global = {
    envs,
    servers: [...servers.values()],
    global_vars: files.get("global_vars.json") ?? {},
    global_param: files.get("global_params.json") ?? {},
  };
  for (const [file, field] of Object.entries(settings))
    global[field] = files.get("settings/" + file + ".json") ?? [];
  const apis = collection("apis", "target_id", true);
  for (const [path, value] of files) {
    const targetId = nativeMockTargetId(path);
    if (!targetId) continue;
    const target = apis.find(
      (node) => node.target_id === targetId && node.target_type === "api",
    );
    if (
      !id(targetId) ||
      !target ||
      !object(value) ||
      value.project_id !== projectId ||
      value.target_id !== targetId ||
      target.nativeMockConfig !== undefined
    )
      throw Error("Apipost Mock文件身份冲突、重复或引用不存在的接口");
    if (target.ai_expect !== undefined) {
      const mirror = (tree) =>
        object(tree)
          ? { ...tree, none_math_example: tree.none_math_example ?? null }
          : tree;
      if (!isDeepStrictEqual(mirror(target.ai_expect), mirror(value.ai_expect)))
        throw Error("Apipost内联与独立Mock条件配置冲突");
    }
    for (const key of [
      "mock_server_enable",
      "mock_ip_white_list_enable",
      "mock_ip_white_list",
      "mock_show_target_id",
    ])
      if (
        Object.hasOwn(target, key) &&
        !isDeepStrictEqual(target[key], value[key])
      )
        throw Error("Apipost内联与独立Mock开关配置冲突");
    target.nativeMockConfig = structuredClone(value);
  }
  return {
    ...(flows.length ? { nativeExecutionFlows: flows } : {}),
    project_id: projectId,
    name: project.name,
    intro: project.intro || "",
    global,
    apis,
    samples: collection("samples", "sample_id", true),
    models: collection("schemas", "model_id", true),
    automated_testings: [],
  };
}
