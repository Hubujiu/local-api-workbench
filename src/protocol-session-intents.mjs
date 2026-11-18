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
    this.operations = new Map();
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
      sendSequence: entry.sendSequence ?? 0,
      sendReceipts: [...this.operations.values()]
        .filter((op) => op.intentId === id)
        .map(({ operationId, state, eventId }) => ({
          operationId,
          state,
          eventId,
        })),
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
  send(id, instanceId, sessionId, operationId, message) {
    this.validateId(id);
    const parts = typeof operationId === "string" ? operationId.split(":") : [];
    const sequence = Number(parts[1]);
    if (
      parts.length !== 3 ||
      parts[0] !== id ||
      !uuid.test(parts[2]) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      parts[1] !== String(sequence)
    )
      fail(400, "发送操作须为当前意图、递增序号和随机 UUID");
    this.instance(instanceId);
    const intent = this.read(id);
    if (intent.sessionId !== sessionId || !intent.session)
      fail(409, "发送会话与连接意图不匹配");
    const encoded = canonical(message === undefined ? "" : message);
    if (Buffer.byteLength(encoded) > 3 * 1024 * 1024) fail(400, "协议消息过大");
    const digest = createHash("sha256").update(encoded).digest("hex");
    const key = id + ":" + operationId;
    let op = this.operations.get(key);
    if (op && op.digest !== digest) fail(409, "同一发送操作不能改变消息");
    if (!op) {
      if (this.closing || this.sessions.closing)
        fail(503, "协议会话管理器正在关闭");
      const entry = this.entries.get(id);
      const previousSequence = entry.sendSequence ?? 0;
      if (sequence <= previousSequence)
        fail(
          410,
          "发送序号已使用或回执已退役；旧序号不会重新提交，远端结果须另行核对",
        );
      if (sequence !== previousSequence + 1)
        fail(409, "发送序号不连续；请读取当前意图，不会自动重发");
      if (this.operations.size >= 256) {
        const retired = [...this.operations].find(
          ([, receipt]) => receipt.state !== "pending",
        );
        if (!retired)
          fail(429, "待完成发送已达256项；请查询或断开已有会话，不会重发");
        this.operations.delete(retired[0]);
      }
      entry.sendSequence = sequence;
      op = {
        intentId: id,
        operationId,
        digest,
        eventId: null,
        state: "pending",
      };
      this.operations.set(key, op);
      let submitted = false;
      try {
        this.sessions.send(sessionId, message, {
          onSubmitted: ({ eventId }) => {
            submitted = true;
            op.eventId = eventId;
          },
          onComplete: ({ state }) => {
            if (op.state === "pending")
              op.state = state === "locally-written" ? state : "unknown";
          },
        });
      } catch {
        if (op.state === "pending")
          op.state = submitted ? "unknown" : "failed-before-submit";
      }
    }
    return {
      ...this.sessions.snapshot(sessionId),
      sendReceipt: { operationId, state: op.state, eventId: op.eventId },
    };
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
