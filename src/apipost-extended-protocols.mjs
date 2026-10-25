import { normalizeSocketIODefinition } from "./socketio.mjs";
import { snapshotSocketIOStep } from "./socketio-plan.mjs";
import { normalizeGrpcDefinition, inspectGrpcSchema } from "./grpc.mjs";
import { snapshotGrpcStep } from "./grpc-plan.mjs";
export function prepareExtendedProtocol(
  node,
  { resource, text, no, keys, fail, noInherited, noHTTPExtras, rawBody },
) {
  if (Buffer.byteLength(JSON.stringify(node)) > 1024 * 1024)
    fail("扩展协议来源超过1MiB");
  const definitions = [],
    plans = [],
    notes = [];
  const plan = (suffix, name, step) =>
    plans.push({
      id: resource("native-message-plan", suffix),
      name: "导入消息 / " + name,
      description:
        "从原生已保存协议消息生成的单次冻结执行入口；不是原版执行计划或既有运行结果，不自动执行。",
      steps: [step],
    });
  if (node.target_type === "socketio") {
    keys(
      node.request ?? {},
      ["header", "query", "cookie", "event"],
      "Socket.IO请求",
    );
    noHTTPExtras(node.request);
    no(node.request.query?.parameter, "Socket.IO Query");
    keys(
      node.config ?? {},
      [
        "certificate_verification",
        "reconnect_num",
        "reconnect_time",
        "shake_hands_path",
        "shake_hands_timeout",
        "socket_version",
      ],
      "Socket.IO配置",
    );
    const c = node.config;
    if (
      ![-1, 1].includes(c.certificate_verification) ||
      c.reconnect_num !== 5 ||
      c.reconnect_time !== 5000 ||
      c.shake_hands_timeout !== 0 ||
      !["v2", "v4"].includes(c.socket_version)
    )
      fail("Socket.IO非默认配置/版本");
    if (![-1, 1].includes(node.ack) || typeof node.msg_data !== "string")
      fail("Socket.IO消息设置");
    if (node.msg_data.includes("{{") || node.url?.includes("{{"))
      fail("Socket.IO事件/地址模板");
    const rows = node.request.event?.parameter ?? [];
    if (!Array.isArray(rows) || rows.length > 100) fail("Socket.IO监听事件");
    // Nonempty native listener row semantics require separate evidence.
    no(rows, "Socket.IO监听事件行");
    const definition = normalizeSocketIODefinition({
      id: resource("socketio", node.target_id),
      name: node.name,
      url: text(node.url, "Socket.IO地址", 8192),
      path: c.shake_hands_path,
      events: [],
      version: Number(c.socket_version.slice(1)),
      transport: "auto",
    });
    definitions.push(definition);
    if (!Array.isArray(node.message) || node.message.length > 100)
      fail("Socket.IO消息列表");
    const ids = new Set();
    for (const m of node.message) {
      keys(m, ["name", "param_id", "request", "response"], "Socket.IO消息");
      if (typeof m.param_id !== "string" || ids.has(m.param_id))
        fail("Socket.IO消息ID");
      ids.add(m.param_id);
      if (m.request?.mode !== "text") fail("Socket.IO正文模式");
      const payload = rawBody(m.request, "Socket.IO正文");
      const step = snapshotSocketIOStep({
        id: resource("native-message-step", node.target_id + ":" + m.param_id),
        type: "socketio",
        socketio: {
          definition,
          timeoutMs: 5000,
          commands: [
            {
              type: "emit",
              event: node.msg_data || "message",
              args: [payload ?? ""],
              ...(node.ack === 1 ? { ackTimeoutMs: 3000 } : {}),
            },
          ],
        },
      });
      plan(
        node.target_id + ":" + m.param_id,
        node.name + " / " + text(m.name, "消息名称", 200),
        step,
      );
    }
    return { socketio: definitions, grpc: [], plans };
  }
  keys(node.request ?? {}, ["description"], "gRPC资源请求");
  if (
    !Array.isArray(node.protos) ||
    !node.protos.length ||
    node.protos.length > 20
  )
    fail("gRPC Proto列表");
  const protoIds = new Set(),
    methodIds = new Set();
  for (const proto of node.protos) {
    keys(
      proto,
      [
        "include_dirs",
        "include_files",
        "proto_content",
        "proto_id",
        "proto_is_cloud",
        "proto_name",
        "proto_path",
        "services",
        "url",
      ],
      "gRPC Proto",
    );
    if (typeof proto.proto_id !== "string" || protoIds.has(proto.proto_id))
      fail("gRPC Proto ID");
    protoIds.add(proto.proto_id);
    no(proto.include_dirs, "gRPC文件系统依赖目录");
    no(proto.include_files, "gRPC外部依赖文件");
    no(proto.proto_path, "gRPC文件系统路径");
    if (proto.proto_is_cloud !== -1) fail("gRPC云端Proto");
    no(proto.url, "gRPC共享端点");
    const content = text(proto.proto_content, "gRPC内联Proto"),
      schema = inspectGrpcSchema({ proto: content });
    if (!Array.isArray(proto.services) || proto.services.length > 100)
      fail("gRPC服务列表");
    const serviceIds = new Set();
    for (const service of proto.services) {
      keys(service, ["service_id", "service_name", "methods"], "gRPC服务");
      if (
        typeof service.service_id !== "string" ||
        serviceIds.has(service.service_id)
      )
        fail("gRPC服务ID");
      serviceIds.add(service.service_id);
      const known = schema.services.find(
        (s) => s.name === service.service_name,
      );
      if (
        !known ||
        !Array.isArray(service.methods) ||
        service.methods.length > 100
      )
        fail("gRPC服务");
      const names = new Set();
      for (const method of service.methods) {
        keys(
          method,
          [
            "grpc_method_id",
            "name",
            "reconnect_num",
            "request",
            "request_stream",
            "response",
            "response_stream",
            "ssl",
            "tls",
            "url",
          ],
          "gRPC方法",
        );
        if (
          typeof method.grpc_method_id !== "string" ||
          methodIds.has(method.grpc_method_id) ||
          names.has(method.name)
        )
          fail("gRPC方法ID");
        methodIds.add(method.grpc_method_id);
        names.add(method.name);
        const actual = known.methods.find((m) => m.name === method.name);
        if (
          !actual ||
          ![-1, 1].includes(method.request_stream) ||
          ![-1, 1].includes(method.response_stream) ||
          actual.requestStream !== (method.request_stream === 1) ||
          actual.responseStream !== (method.response_stream === 1)
        )
          fail("gRPC流类型与Proto不匹配");
        if (
          method.ssl !== -1 ||
          method.tls !== -1 ||
          method.reconnect_num !== 0
        )
          fail("gRPC TLS/重连配置");
        keys(method.request ?? {}, ["message", "metadata"], "gRPC方法请求");
        keys(method.request.metadata ?? {}, ["parameter"], "gRPC Metadata");
        no(method.request.metadata.parameter, "gRPC Metadata行");
        const messages = method.request.message;
        if (!Array.isArray(messages) || messages.length > 100)
          fail("gRPC消息列表");
        const messageIds = new Set(),
          parsed = [];
        for (const message of messages) {
          keys(
            message,
            ["name", "param_id", "raw", "raw_parameter"],
            "gRPC消息",
          );
          if (
            typeof message.param_id !== "string" ||
            messageIds.has(message.param_id)
          )
            fail("gRPC消息ID");
          messageIds.add(message.param_id);
          no(message.raw_parameter, "gRPC参数生成规则");
          const raw = text(message.raw, "gRPC消息");
          if (raw.includes("{{")) fail("gRPC消息模板");
          if (!raw.trim()) {
            parsed.push(null);
            continue;
          }
          let value;
          try {
            value = JSON.parse(raw);
          } catch {
            fail("gRPC消息JSON");
          }
          let count = 0;
          const check = (x, depth = 0) => {
            if (++count > 10000 || depth > 32) fail("gRPC消息结构");
            if (
              typeof x === "number" &&
              (!Number.isFinite(x) ||
                (Number.isInteger(x) && !Number.isSafeInteger(x)))
            )
              fail("gRPC消息精确数字");
            if (x && typeof x === "object")
              for (const [k, v] of Object.entries(x)) {
                if (["__proto__", "prototype", "constructor"].includes(k))
                  fail("gRPC消息保留字段");
                check(v, depth + 1);
              }
          };
          check(value);
          if (!value || typeof value !== "object" || Array.isArray(value))
            fail("gRPC消息对象");
          parsed.push(value);
        }
        const endpoint = text(method.url, "gRPC端点", 8192);
        if (!endpoint) {
          if (parsed.some((v) => v !== null)) fail("有消息但无gRPC端点");
          continue;
        }
        if (endpoint.includes("{{") || endpoint.includes("://"))
          fail("gRPC端点模板/前缀");
        const definition = normalizeGrpcDefinition({
          id: resource("grpc", node.target_id + ":" + method.grpc_method_id),
          name: node.name + " / " + service.service_name + "/" + method.name,
          target: "grpc://" + endpoint,
          proto: content,
          service: service.service_name,
          method: method.name,
          timeoutMs: 5000,
        });
        definitions.push(definition);
        if (actual.requestStream) {
          notes.push(
            service.service_name +
              "/" +
              method.name +
              "：原版当前不支持客户端/双向流调用；定义与消息仅保留，不生成发送计划，不猜测消息顺序。",
          );
          continue;
        }
        if (parsed.every((v) => v === null)) continue;
        if (parsed.some((v) => v === null)) fail("gRPC空消息混排");
        // Native message tabs are saved alternatives for unary calls, not a stream.

        for (let i = 0; i < parsed.length; i++) {
          const suffix =
            node.target_id +
            ":" +
            method.grpc_method_id +
            ":" +
            messages[i].param_id;
          const step = snapshotGrpcStep({
            id: resource("native-message-step", suffix),
            type: "grpc",
            grpc: { definition, messages: [parsed[i]] },
          });
          plan(
            suffix,
            definition.name +
              " / " +
              text(messages[i].name, "gRPC消息名称", 200),
            step,
          );
        }
      }
    }
  }
  if (definitions.length > 100 || plans.length > 1000) fail("gRPC导入数量");
  return { socketio: [], grpc: definitions, plans, notes };
}
