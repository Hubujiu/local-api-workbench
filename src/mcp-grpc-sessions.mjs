import { createHash } from "node:crypto";
import { selectGrpcMethod, normalizeGrpcDefinition } from "./grpc.mjs";

const identifier = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(v);
const fields = {
  start: ["projectId", "definitionId", "operationId"],
  send: ["projectId", "sessionId", "operationId", "message"],
  half_close: ["projectId", "sessionId", "operationId"],
  get: ["projectId", "sessionId", "afterMessage", "limit"],
  cancel: ["projectId", "sessionId"],
  operation: ["projectId", "operationId"],
};
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Stateful ownership adapter. The host supplies the existing GrpcSessions and
// its shared GrpcSlots; no transport, credentials or authority comes from JSON.
export class MCPGrpcSessions {
  constructor({ sessions, store, owns }) {
    Object.assign(this, { sessions, store, owns });
    this.owners = new Map();
  }
  state(owner) {
    if (!owner || !this.owns(owner))
      throw Error("gRPC requires a live initialized HTTP or stdio MCP owner");
    let state = this.owners.get(owner);
    if (!state) {
      state = {
        closed: false,
        blocked: new Set(),
        operations: new Map(),
        connections: new Map(),
        pending: new Set(),
      };
      this.owners.set(owner, state);
    }
    this.assertLive(owner, state);
    return state;
  }
  assertLive(owner, state, projectId) {
    if (state.closed || !this.owns(owner) || state.blocked.has(projectId))
      throw Error("gRPC ownership or project grant was revoked");
  }
  async dispose(owner) {
    const state = this.owners.get(owner);
    if (!state) return;
    state.closed = true;
    const closing = [...state.connections].map(([id, c]) =>
      this.end(c.projectId, id),
    );
    await Promise.allSettled([...closing, ...state.pending]);
    this.owners.delete(owner);
  }
  async revokeProject(projectId) {
    const pending = [];
    for (const state of this.owners.values()) {
      state.blocked.add(projectId);
      for (const [id, c] of state.connections)
        if (c.projectId === projectId) pending.push(this.end(projectId, id));
      for (const op of state.operations.values())
        if (op.projectId === projectId && op.task) pending.push(op.task);
    }
    await Promise.allSettled(pending);
  }
  end(projectId, id) {
    if (!this.sessions.sessions.has(id)) return Promise.resolve();
    return this.sessions.cancel(projectId, id, { retryStorage: false });
  }
  connection(state, args) {
    const c = state.connections.get(args.sessionId);
    if (!c || c.projectId !== args.projectId)
      throw Error("gRPC session does not belong to this owner and project");
    return c;
  }
  operationReceipt(op) {
    return {
      operationId: op.id,
      projectId: op.projectId,
      action: op.action,
      state: op.state,
      ...(op.sessionId ? { sessionId: op.sessionId } : {}),
      ...(op.error ? { error: op.error } : {}),
      remoteConfirmed: false,
      retrySafe: false,
    };
  }
  receipt(args) {
    const s = this.sessions.get(args.projectId, args.sessionId);
    this.sessions.checkDeadline(s);
    const v = s.finalSnapshot || s.view;
    return {
      sessionId: s.id,
      projectId: s.projectId,
      lifecycle: v.lifecycle,
      requestState: v.requestState,
      createdAt: v.createdAt,
      finishedAt: v.finishedAt,
      deadlineAt: v.deadlineAt,
      status: structuredClone(v.status),
      remoteStatus: structuredClone(v.remoteStatus),
      terminationReason: v.terminationReason,
      totalMessages: v.messages.length,
      requestCount: v.requestMessages.length,
      requestBytes: v.requestBytes,
      responseBytes: v.responseBytes,
      truncated: v.truncated,
      pendingSend: !!s.pending,
      receiptState: s.receiptState,
      ...(s.receipt || {
        recordSaved: false,
        recordPending: !!s.recordPromise,
      }),
    };
  }
  call(action, owner, input) {
    if (
      !fields[action] ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !fields[action].includes(k))
    )
      throw Error("Unsupported gRPC tool arguments");
    for (const key of fields[action].filter(
      (k) => !["message", "afterMessage", "limit"].includes(k),
    ))
      if (!identifier(input[key])) throw Error("Invalid gRPC " + key);
    if (
      action === "send" &&
      (!input.message ||
        typeof input.message !== "object" ||
        Array.isArray(input.message))
    )
      throw Error("gRPC message must be a JSON object");
    if (
      action === "get" &&
      ((input.afterMessage !== undefined &&
        (!Number.isSafeInteger(input.afterMessage) ||
          input.afterMessage < 0)) ||
        (input.limit !== undefined &&
          (!Number.isInteger(input.limit) ||
            input.limit < 1 ||
            input.limit > 20)))
    )
      throw Error("Invalid bounded gRPC message page");
    const args = structuredClone(input);
    const state = this.state(owner);
    this.assertLive(owner, state, args.projectId);
    if (action === "operation") {
      const op = state.operations.get(args.operationId);
      if (!op || op.projectId !== args.projectId)
        throw Error("gRPC operation does not belong to this owner and project");
      return this.operationReceipt(op);
    }
    if (["start", "send", "half_close"].includes(action)) {
      const fingerprint = hash(
        JSON.stringify([action, ...fields[action].map((k) => args[k])]),
      );
      const existing = state.operations.get(args.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw Error("gRPC operation ID already used with different content");
        return this.operationReceipt(existing);
      }
      if (state.operations.size >= 200)
        throw Error(
          "gRPC operation ledger is full; read or cancel existing sessions",
        );
      const op = {
        id: args.operationId,
        projectId: args.projectId,
        action,
        fingerprint,
        state: "pending",
      };
      state.operations.set(op.id, op);
      const task = this.perform(action, owner, state, args, op)
        .catch(() => {
          if (!op.submitted && op.state === "pending")
            op.state = "failed-before-submit";
          else if (op.state === "pending") op.state = "unknown";
          op.error =
            "gRPC operation failed; inspect stored evidence. No automatic network retry.";
        })
        .then(() => this.operationReceipt(op));
      op.task = task;
      state.pending.add(task);
      task.finally(() => {
        state.pending.delete(task);
        delete op.task;
      });
      return task;
    }
    this.connection(state, args);
    if (action === "cancel")
      return this.end(args.projectId, args.sessionId).then(() =>
        this.receipt(args),
      );
    const receipt = this.receipt(args);
    const s = this.sessions.get(args.projectId, args.sessionId),
      v = s.finalSnapshot || s.view;
    const after = args.afterMessage ?? 0;
    const messages = v.messages
      .slice(after, after + (args.limit ?? 20))
      .map((message, index) => {
        const json = JSON.stringify(message);
        let preview = json.slice(0, 4096);
        if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
        return {
          sequence: after + index + 1,
          jsonBytes: Buffer.byteLength(json),
          hash: hash(json),
          truncated: preview.length !== json.length,
          ...(preview.length === json.length
            ? { message: structuredClone(message) }
            : { preview }),
        };
      });
    const nextAfterMessage = messages.at(-1)?.sequence ?? after;
    return {
      ...receipt,
      messages,
      nextAfterMessage,
      hasMore: nextAfterMessage < v.messages.length,
    };
  }
  async perform(action, owner, state, args, op) {
    let connection;
    if (action !== "start") {
      connection = this.connection(state, args);
      if (connection.pending)
        throw Error(
          "gRPC operation is already awaiting admission or completion",
        );
      connection.pending = true;
    }
    try {
      const project = await this.store.get(args.projectId);
      this.assertLive(owner, state, args.projectId);
      if (!project || project.archived) throw Error("gRPC project unavailable");
      if (action === "start") {
        const source = project.settings?.grpcDefinitions?.find(
          (d) => d.id === args.definitionId,
        );
        if (!source) throw Error("Saved gRPC definition not found");
        const definition = normalizeGrpcDefinition(source);
        const { desc } = selectGrpcMethod(definition);
        if (!desc.requestStream || !desc.responseStream)
          throw Error(
            "Only bidirectional streaming gRPC methods are supported",
          );
        const result = this.sessions.start(
          project.id,
          definition,
          {},
          {
            onSubmitted: () => {
              op.submitted = true;
              op.state = "unknown";
            },
          },
        );
        op.sessionId = result.id;
        state.connections.set(result.id, {
          projectId: project.id,
          pending: false,
        });
        op.state = "started";
        return;
      }
      const observers = {
        onSubmitted: () => {
          op.submitted = true;
          op.sessionId = args.sessionId;
        },
        onComplete: ({ state: status }) => {
          op.state = status;
          connection.pending = false;
        },
      };
      if (action === "send")
        this.sessions.send(
          args.projectId,
          args.sessionId,
          args.message,
          observers,
        );
      else this.sessions.halfClose(args.projectId, args.sessionId, observers);
    } catch (error) {
      if (connection) connection.pending = false;
      throw error;
    }
  }
}
