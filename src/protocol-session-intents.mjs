import { randomUUID, createHash } from "node:crypto";
import { validateProtocolTemplate } from "./protocol-text-templates.mjs";
import { protocolRequestOptions } from "./protocol-request-options.mjs";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(status, message) {
  throw Object.assign(Error(message), { intentStatus: status });
}
function canonical(value, depth = 0) {
  if (depth > 40) fail(400, "协议定义嵌套过深");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k], depth + 1))
      .join(",") +
    "}"
  );
}
// Non-secret correlation keys, never authority. Entries survive for this instance's
// lifetime: expiry, unknown results and cancellation never make a key reusable.
export class ProtocolSessionIntents {
  constructor(sessions) {
    this.sessions = sessions;
    this.instanceId = randomUUID();
    this.entries = new Map();
    this.closing = false;
  }
  validateId(id) {
    if (typeof id !== "string" || !uuid.test(id))
      fail(400, "连接意图须为随机 UUID v4");
  }
  instance(id) {
    if (id !== this.instanceId)
      fail(409, "服务实例已变化；旧连接结果不能恢复，请勿重放");
  }
  claim(id, phase, digest = null) {
    if (this.closing || this.sessions.closing)
      fail(503, "协议会话管理器正在关闭");
    if (this.entries.size >= 256)
      fail(429, "本服务实例连接意图已达256项上限；已有连接仍可查询和停止");
    const entry = { phase, digest, sessionId: null };
    this.entries.set(id, entry);
    return entry;
  }
  read(id) {
    this.validateId(id);
    const entry = this.entries.get(id);
    if (!entry) fail(404, "连接意图不存在");
    let session = null;
    if (entry.sessionId) {
      const current = this.sessions.sessions.get(entry.sessionId);
      if (current?.projectId) fail(403, "项目会话不能通过全局意图访问");
      if (current) session = this.sessions.snapshot(entry.sessionId);
      else if (entry.phase !== "unknown") entry.phase = "expired";
    }
    return {
      instanceId: this.instanceId,
      intentId: id,
      phase: entry.phase,
      sessionId: entry.sessionId,
      session,
      retry_safe: false,
    };
  }
  start(id, instanceId, definition) {
    this.validateId(id);
    this.instance(instanceId);
    if (this.closing || this.sessions.closing)
      fail(503, "协议会话管理器正在关闭");
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    )
      fail(400, "协议定义须为对象");
    if (!["tcp", "websocket", "sse"].includes(definition.type))
      fail(400, "协议无效");
    for (const key of ["projectId", "templateMode", "environmentId"])
      if (definition[key] !== undefined)
        fail(400, "项目会话请使用项目专属入口");
    const encoded = canonical(definition);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) fail(400, "协议定义过大");
    validateProtocolTemplate(definition);
    protocolRequestOptions(definition);
    const digest = createHash("sha256").update(encoded).digest("hex");
    const previous = this.entries.get(id);
    if (previous) {
      if (previous.digest && previous.digest !== digest)
        fail(409, "同一连接意图不能改变协议定义");
      return this.read(id);
    }
    const entry = this.claim(id, "unknown", digest);
    // No await between claim and start. Never retain definition or exception text.
    try {
      this.sessions.start(definition, {
        onAllocated: (sessionId) => {
          entry.sessionId = sessionId;
        },
      });
      entry.phase = "started";
    } catch {
      entry.phase = "unknown";
    }
    return this.read(id);
  }
  stop(id, instanceId) {
    this.validateId(id);
    this.instance(instanceId);
    let entry = this.entries.get(id);
    if (!entry) entry = this.claim(id, "cancelled");
    if (entry.sessionId) {
      const current = this.sessions.sessions.get(entry.sessionId);
      if (current?.projectId) fail(403, "项目会话不能通过全局意图访问");
      if (!current) {
        if (entry.phase !== "unknown") entry.phase = "expired";
        return this.read(id);
      }
      try {
        this.sessions.stop(entry.sessionId);
        entry.phase = "cancelled";
      } catch {
        entry.phase = "unknown";
      }
    }
    // Unknown pre-allocation failures are not proof that stop succeeded.
    return this.read(id);
  }
  close() {
    this.closing = true;
  }
}
