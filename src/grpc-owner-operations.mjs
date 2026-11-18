import { randomUUID } from "node:crypto";
const fail = (message) => {
  throw Error(message);
};
// Ephemeral owner receipts are bounded by the session manager lifetime/retention.
// A watermark prevents retired IDs from ever being accepted again.
export class GrpcOwnerOperations {
  constructor(sessions) {
    this.sessions = sessions;
    this.instanceId = randomUUID();
    this.entries = new WeakMap();
  }
  entry(projectId, sessionId) {
    const session = this.sessions.get(projectId, sessionId);
    let entry = this.entries.get(session);
    if (!entry) {
      entry = { sequence: 0, receipts: new Map() };
      this.entries.set(session, entry);
    }
    return entry;
  }
  snapshot(projectId, sessionId) {
    return this.withReceipts(
      projectId,
      this.sessions.snapshot(projectId, sessionId),
    );
  }
  withReceipts(projectId, session) {
    const e = this.entry(projectId, session.id);
    return {
      ...session,
      ownerOperations: {
        instanceId: this.instanceId,
        sequence: e.sequence,
        receipts: [...e.receipts.values()].map((r) => ({ ...r })),
      },
    };
  }
  execute(projectId, sessionId, kind, message, correlation) {
    const e = this.entry(projectId, sessionId);
    if (!correlation || correlation.instanceId !== this.instanceId)
      fail("gRPC操作实例不匹配，禁止重放");
    const match =
      /^(\d+):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
        correlation.operationId,
      );
    const sequence = Number(match?.[1]);
    if (
      !match ||
      !Number.isSafeInteger(sequence) ||
      String(sequence) !== match[1] ||
      sequence !== e.sequence + 1
    )
      fail("gRPC操作序列已消费或无效，禁止重放；请只读查询");
    if (!["send", "half-close"].includes(kind)) fail("gRPC操作类型无效");
    if (e.receipts.size >= 128) {
      const retired = [...e.receipts].find(([, r]) => r.state !== "pending");
      if (!retired) fail("gRPC本地操作回执暂满");
      e.receipts.delete(retired[0]);
    }
    const receipt = {
      operationId: correlation.operationId,
      kind,
      state: "pending",
    };
    e.sequence = sequence;
    e.receipts.set(receipt.operationId, receipt);
    let submitted = false;
    const observer = {
      onSubmitted: () => {
        submitted = true;
      },
      onComplete: ({ state }) => {
        if (receipt.state === "pending") receipt.state = state;
      },
    };
    try {
      if (kind === "send")
        this.sessions.send(projectId, sessionId, message, observer);
      else this.sessions.halfClose(projectId, sessionId, observer);
    } catch (error) {
      if (receipt.state === "pending")
        receipt.state = submitted ? "unknown" : "failed-before-submit";
      throw error;
    }
    return this.snapshot(projectId, sessionId);
  }
}
