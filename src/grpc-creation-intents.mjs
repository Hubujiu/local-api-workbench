import { randomUUID, createHash } from "node:crypto";
const fail = (message) => {
  throw Error(message);
};
const digest = (definition) =>
  createHash("sha256").update(JSON.stringify(definition)).digest("hex");
// Owner-only correlation, not authority. No credentials or messages are retained.
export class SessionCreationIntents {
  constructor(sessions, { now = Date.now } = {}) {
    this.sessions = sessions;
    this.now = now;
    this.instanceId = randomUUID();
    this.entries = new Map();
  }
  acquire(projectId, definition) {
    for (const [id, e] of this.entries) {
      if (this.entries.size < 256) break;
      if (e.phase !== "reserved" || e.expiresAt <= this.now())
        this.entries.delete(id);
    }
    if (this.entries.size >= 256)
      fail("创建意图暂满，请等待未提交意图过期");
    const intentId = randomUUID();
    this.entries.set(intentId, {
      projectId,
      definitionId: definition.id,
      digest: digest(definition),
      phase: "reserved",
      sessionId: null,
      expiresAt: this.now() + 300000,
    });
    return this.read(projectId, intentId, this.instanceId);
  }
  entry(projectId, intentId, instanceId) {
    if (instanceId !== this.instanceId) fail("服务实例已变化，禁止重放");
    const e = this.entries.get(intentId);
    if (!e || e.projectId !== projectId)
      fail("创建意图不存在或不属于此项目，禁止重放");
    return e;
  }
  read(projectId, intentId, instanceId) {
    const e = this.entry(projectId, intentId, instanceId);
    let session = null;
    if (e.sessionId) {
      try {
        session = this.sessions.snapshot(projectId, e.sessionId);
      } catch {}
    }
    return {
      instanceId: this.instanceId,
      intentId,
      definitionId: e.definitionId,
      phase:
        e.phase === "reserved" && e.expiresAt <= this.now()
          ? "expired"
          : e.phase,
      sessionId: e.sessionId,
      session,
      retry_safe: false,
    };
  }
  start(projectId, definition, options, correlation) {
    const e = this.entry(
      projectId,
      correlation.intentId,
      correlation.instanceId,
    );
    if (e.definitionId !== definition.id || e.digest !== digest(definition))
      fail("创建定义已变化，禁止重放");
    if (e.phase !== "reserved" || e.expiresAt <= this.now())
      fail("创建意图已消费或过期，禁止重放；请只读查询");
    e.phase = "unknown";
    try {
      const result = this.sessions.start(projectId, definition, options, {
        onSubmitted: ({ sessionId }) => {
          e.sessionId = sessionId;
        },
      });
      e.sessionId = result.id;
      e.phase = "created";
      return result;
    } catch (error) {
      if (!e.sessionId) e.phase = "failed-before-submit";
      throw error;
    }
  }
}
export { SessionCreationIntents as GrpcCreationIntents };
