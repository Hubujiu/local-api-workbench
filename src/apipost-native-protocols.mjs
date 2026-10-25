import { prepareExtendedProtocol } from "./apipost-extended-protocols.mjs";
import { normalizeProtocol } from "./protocol-definitions.mjs";
const types = new Set([
  "websocket2",
  "socket",
  "socket_method",
  "sse",
  "socketio",
  "grpc",
]);
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const empty = (x) =>
  x == null ||
  x === "" ||
  (Array.isArray(x) && !x.length) ||
  (object(x) && !Object.keys(x).length);
function fail(label) {
  throw Error(
    "Apipost原生协议暂不支持或无效: " + label + "；不会静默丢弃执行语义",
  );
}
function text(x, label, max = 65536) {
  if (typeof x !== "string" || !x.isWellFormed() || Buffer.byteLength(x) > max)
    fail(label);
  return x;
}
function no(value, label) {
  if (!empty(value)) fail(label);
}
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    fail(label);
}
function noTasks(request, label) {
  no(request?.pre_tasks, label + "前置任务");
  no(request?.post_tasks, label + "后置任务");
}
function noAuth(request) {
  if (request?.auth && !["inherit", "noauth"].includes(request.auth.type))
    fail("认证需显式运行时提供");
}
function noInherited(request) {
  if (request !== undefined)
    keys(
      request,
      [
        "auth",
        "header",
        "query",
        "cookie",
        "restful",
        "body",
        "pre_tasks",
        "post_tasks",
      ],
      "协议继承配置",
    );
  no(request?.body?.raw, "继承正文");
  noTasks(request, "继承");
  noAuth(request);
  for (const k of ["header", "query", "cookie", "restful", "body"])
    no(request?.[k]?.parameter, "继承" + k);
}
function urlQuery(node) {
  const value = text(node.url, "URL", 8192);
  if (value.includes("{{")) fail("URL模板");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("URL");
  }
  const query = node.request?.query;
  if (query !== undefined)
    keys(query, ["parameter", "query_add_equal"], "Query");
  if (query?.query_add_equal !== undefined && query.query_add_equal !== 1)
    fail("Query等号策略");
  const rows = query?.parameter ?? [];
  if (!Array.isArray(rows) || rows.length > 1000) fail("Query行");
  // Consume the exact URL mirror as a multiset; append only additional rows.
  const mirrors = new Map();
  for (const [k, v] of url.searchParams) {
    const key = JSON.stringify([k, v]);
    mirrors.set(key, (mirrors.get(key) || 0) + 1);
  }
  for (const row of rows) {
    keys(
      row,
      [
        "description",
        "field_type",
        "is_checked",
        "key",
        "not_null",
        "param_id",
        "value",
      ],
      "Query行",
    );
    const k = text(row.key ?? "", "Query键", 8192),
      v = text(row.value ?? "", "Query值", 8192);
    if (!k) continue;
    if (row.is_checked !== undefined && row.is_checked !== 1)
      fail("停用Query行");
    if (k.includes("{{") || v.includes("{{")) fail("Query模板");
    const key = JSON.stringify([k, v]),
      count = mirrors.get(key) || 0;
    if (count) mirrors.set(key, count - 1);
    else {
      const encoded = new URLSearchParams([[k, v]]).toString();
      url.search += (url.search ? "&" : "?") + encoded;
    }
  }
  return url.href;
}
function noHTTPExtras(request) {
  noAuth(request);
  noTasks(request, "协议");
  for (const k of ["header", "cookie", "restful"]) {
    if (request?.[k] !== undefined)
      keys(
        request[k],
        k === "cookie" ? ["parameter", "cookie_encode"] : ["parameter"],
        k + "配置",
      );
    no(request?.[k]?.parameter, k + "参数");
  }
}
function rawBody(body, label) {
  if (!object(body)) fail(label);
  if (
    !["text", "raw", "json", "xml", "html", "javascript", "none"].includes(
      body.mode,
    )
  )
    fail(label + "模式");
  if (body.mode === "none") {
    no(body.raw, label);
    no(body.parameter, label);
    return undefined;
  }
  no(body.binary, label + "二进制");
  const rows = body.parameter ?? [];
  if (!Array.isArray(rows) || rows.some((r) => !object(r) || r.key || r.value))
    fail(label + "结构参数");
  const raw = text(body.raw ?? "", label);
  if (raw.includes("{{")) fail(label + "模板");
  return raw;
}
export function prepareNativeProtocols(source, resource) {
  const nodes = source.apis,
    native = nodes.filter((n) => types.has(n?.target_type));
  if (!native.length)
    return {
      nodes,
      protocols: [],
      sources: [],
      socketio: [],
      grpc: [],
      plans: [],
    };
  if (native.length > 1000) fail("资源数量");
  const ids = new Map();
  for (const n of nodes) {
    if (!object(n) || typeof n.target_id !== "string" || ids.has(n.target_id))
      fail("资源ID");
    ids.set(n.target_id, n);
  }
  const protocols = [],
    sources = [],
    socketio = [],
    grpc = [],
    plans = [];
  const folder = (node) => {
    const names = [],
      seen = new Set([node.target_id]);
    let id = node.parent_id;
    while (id && id !== "0") {
      if (seen.has(id) || seen.size > 30) fail("父目录环");
      seen.add(id);
      const parent = ids.get(id);
      if (!parent || !["folder", "socket"].includes(parent.target_type))
        fail("父目录");
      if (parent.target_type === "folder") noInherited(parent.request);
      names.unshift(text(parent.name, "目录名称", 200));
      id = parent.parent_id;
    }
    return names.join("/");
  };
  noInherited(source.global?.global_param);
  for (const node of native) {
    keys(
      node,
      [
        "target_id",
        "target_type",
        "project_id",
        "name",
        "parent_id",
        "sort",
        "version",
        "status",
        "mark_id",
        "method",
        "url",
        "description",
        "tags",
        "attribute_info",
        "is_locked",
        "is_exampled",
        "is_socket",
        "protocol",
        "request",
        "response",
        "config",
        "message",
        "ack",
        "msg_data",
        "protos",
      ],
      "资源字段",
    );
    if (node.project_id !== undefined && node.project_id !== source.project_id)
      fail("项目身份");
    no(node.tags, "标签");
    no(node.attribute_info, "属性");
    const name = text(node.name, "名称", 200),
      path = folder(node),
      request = node.request ?? {};
    if (!["websocket2", "socketio"].includes(node.target_type)) {
      no(node.config, "非WebSocket配置");
      no(node.message, "非WebSocket消息");
    } else if (node.method !== undefined && node.method !== "")
      fail("WebSocket方法");
    const sourceNotes = [];
    const sourceCopy = structuredClone(node);
    // Inactive provider editors can contain credentials; never retain them.
    if (sourceCopy.request?.auth)
      sourceCopy.request.auth = { type: sourceCopy.request.auth.type };
    const add = (suffix, definition) =>
      protocols.push(
        normalizeProtocol({
          id: resource("protocol", suffix),
          name,
          folder: path,
          ...definition,
        }),
      );
    if (["socketio", "grpc"].includes(node.target_type)) {
      const extended = prepareExtendedProtocol(node, {
        resource,
        text,
        no,
        keys,
        fail,
        noInherited,
        noHTTPExtras,
        rawBody,
      });
      socketio.push(...extended.socketio);
      grpc.push(...extended.grpc);
      plans.push(...extended.plans);
      sourceNotes.push(...(extended.notes || []));
    } else if (node.target_type === "socket") {
      keys(request, ["end_func", "timeout"], "TCP客户端");
      keys(request.end_func ?? {}, ["name", "option"], "TCP结束条件");
      if (request.end_func?.name !== "none" || !empty(request.end_func.option))
        fail("TCP结束条件");
      if (
        !Number.isInteger(request.timeout) ||
        request.timeout < 1 ||
        request.timeout > 30
      )
        fail("TCP超时");
      if (node.method !== "TCP") fail("TCP客户端类型");
      // Connection containers are retained as folders plus inert source metadata.
      const endpoint = text(node.url, "TCP地址", 8192);
      if (endpoint.includes("{{")) fail("TCP地址模板");
      let u;
      try {
        u = new URL("tcp://" + endpoint);
      } catch {
        fail("TCP地址");
      }
      if (
        !u.port ||
        u.username ||
        u.password ||
        u.pathname ||
        u.search ||
        u.hash
      )
        fail("TCP地址");
    } else if (node.target_type === "socket_method") {
      keys(request, ["body", "configs", "post_tasks"], "TCP方法");
      noTasks(request, "TCP");
      const parent = ids.get(node.parent_id);
      if (parent?.target_type !== "socket") fail("TCP方法父客户端");
      if (node.method !== "TCP") fail("TCP方法类型");
      keys(request.configs ?? {}, ["charset", "func"], "TCP配置");
      if (request.configs.charset !== "utf8") fail("TCP字符集");
      keys(request.configs.func ?? {}, ["request", "response"], "TCP加工");
      no(request.configs.func.request, "TCP请求加工");
      no(request.configs.func.response, "TCP响应加工");
      const u = new URL("tcp://" + parent.url),
        message = rawBody(request.body, "TCP正文");
      add(node.target_id, {
        type: "tcp",
        url: u.hostname.replace(/^\[|\]$/g, ""),
        port: Number(u.port),
        message: message ?? "",
        completion: "first-data",
        duration: parent.request.timeout * 1000,
      });
    } else if (node.target_type === "websocket2") {
      keys(request, ["header", "query", "cookie"], "WebSocket请求");
      noHTTPExtras(request);
      keys(
        node.config ?? {},
        [
          "certificate_verification",
          "information_size",
          "reconnect_num",
          "reconnect_time",
          "shake_hands_timeout",
        ],
        "WebSocket配置",
      );
      const config = node.config;
      if (
        ![-1, 1].includes(config.certificate_verification) ||
        config.information_size !== 5 ||
        config.reconnect_num !== 5 ||
        config.reconnect_time !== 5000 ||
        config.shake_hands_timeout !== 0
      )
        fail("WebSocket非默认配置");
      if (
        !Array.isArray(node.message) ||
        !node.message.length ||
        node.message.length > 100
      )
        fail("WebSocket消息");
      const seen = new Set();
      for (const message of node.message) {
        keys(
          message,
          ["param_id", "name", "request", "response"],
          "WebSocket消息",
        );
        if (typeof message.param_id !== "string" || seen.has(message.param_id))
          fail("WebSocket消息ID");
        seen.add(message.param_id);
        const payload = rawBody(message.request, "WebSocket正文");
        if (message.request.mode !== "text") fail("WebSocket消息模式");
        add(node.target_id + ":" + message.param_id, {
          type: "websocket",
          url: urlQuery(node),
          message: payload ?? "",
          name: name + " / " + text(message.name, "消息名称", 200),
        });
      }
    } else {
      keys(
        request,
        [
          "auth",
          "body",
          "cookie",
          "header",
          "post_tasks",
          "pre_tasks",
          "query",
          "restful",
        ],
        "SSE请求",
      );
      noHTTPExtras(request);
      if (!["", "http/1.1", undefined].includes(node.protocol))
        fail("SSE协议版本");
      const body = rawBody(request.body, "SSE正文");
      add(node.target_id, {
        type: "sse",
        url: urlQuery(node),
        method: node.method,
        ...(body !== undefined ? { body } : {}),
      });
    }
    sources.push({
      id: resource("protocol-source", node.target_id),
      sourceProjectId: source.project_id,
      sourceTargetId: node.target_id,
      source: sourceCopy,
      notes: [
        ...sourceNotes,
        "原生协议受限迁移；源描述/响应示例与配置保留为惰性元数据，不执行。",
        "不导入认证编辑器中的停用提供方秘密；不自动继承Header/Cookie/认证/脚本。",
        "保持TLS校验与有界采集，不沿用无限握手或关闭证书校验；重连配置仅保留，不自动重连。",
        "TCP客户端超时转换为有界毫秒默认时限；固定计划冻结实际所选时限。",
      ],
    });
  }
  if (Buffer.byteLength(JSON.stringify(sources)) > 1024 * 1024)
    fail("来源元数据超过1MiB");
  return {
    protocols,
    sources,
    socketio,
    grpc,
    plans,
    nodes: nodes.flatMap((n) =>
      !types.has(n.target_type)
        ? [n]
        : n.target_type === "socket"
          ? [
              {
                target_id: n.target_id,
                target_type: "folder",
                parent_id: n.parent_id,
                name: n.name,
                sort: n.sort,
                request: {},
              },
            ]
          : [],
    ),
  };
}
