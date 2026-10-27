// Keep existing persisted IDs stable, but reject ambiguous legacy ':' tuples
// before equal definitions can be deduplicated. This inspects identities only;
// archived credential-redacted payloads are never converted or executed again.
export function assertNativeProtocolIdentities(source, archived = []) {
  const seen = new Map();
  function visit(node, projectId) {
    if (
      !["grpc", "socketio", "websocket2", "socket_method", "sse"].includes(
        node?.target_type,
      )
    )
      return;
    function claim(kind, parts) {
      if (parts.some((part) => typeof part !== "string"))
        throw Error("原生协议身份字段无效");
      const key = JSON.stringify([projectId, kind, parts.join(":")]);
      const tuple = JSON.stringify([node.target_type, ...parts]);
      if (seen.has(key) && seen.get(key) !== tuple)
        throw Error("原生协议身份拼接歧义；不会合并不同来源定义或消息");
      seen.set(key, tuple);
    }
    if (node.target_type === "websocket2") {
      for (const message of node.message || [])
        claim("protocol", [node.target_id, message.param_id]);
    } else if (["socket_method", "sse"].includes(node.target_type)) {
      claim("protocol", [node.target_id]);
    } else if (node.target_type === "socketio") {
      claim("socketio", [node.target_id]);
      for (const message of node.message || []) {
        claim("native-message-plan", [node.target_id, message.param_id]);
        claim("native-message-step", [node.target_id, message.param_id]);
      }
    } else {
      for (const proto of node.protos || [])
        for (const service of proto.services || [])
          for (const method of service.methods || []) {
            const parts = [node.target_id, method.grpc_method_id];
            claim("grpc", parts);
            for (const message of method.request?.message || []) {
              claim("native-message-plan", [...parts, message.param_id]);
              claim("native-message-step", [...parts, message.param_id]);
            }
          }
    }
  }
  // Different source projects already have independent resource namespaces.
  for (const record of archived)
    if (record.sourceProjectId === source.project_id)
      visit(record.source, record.sourceProjectId);
  for (const node of source.apis) visit(node, source.project_id);
}
