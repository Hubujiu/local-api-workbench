import { createHash } from "node:crypto";
import { prepareWireExecution } from "./wire-evidence.mjs";

const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,200}$/.test(value);
const fields = {
  start: ["projectId", "definitionId", "operationId"],
  send: ["projectId", "sessionId", "operationId", "message"],
  get: ["projectId", "sessionId", "afterEvent", "limit"],
  stop: ["projectId", "sessionId"],
  renew: ["projectId", "sessionId"],
  operation: ["projectId", "operationId"],
};
// One host service with its host-local ProtocolSessions pool. Owner objects
// come exclusively from the host registry, never from JSON or bearer claims.
export class MCPWebSocketSessions {
  constructor({
    sessions,
    store,
    owns,
    now = Date.now,
    leaseMs = 60000,
    maxOperations = 200,
  }) {
    this.sessions = sessions;
    this.store = store;
    this.owns = owns;
    this.now = now;
    this.leaseMs = Math.min(60000, leaseMs);
    this.maxOperations = Math.min(200, maxOperations);
    this.owners = new Map();
  }
  state(owner) {
    if (!owner || !this.owns(owner))
      throw Error(
        "WebSocket requires a live initialized HTTP or stdio MCP session",
      );
    let state = this.owners.get(owner);
    if (!state) {
      state = {
        closed: false,
        blockedProjects: new Set(),
        operations: new Map(),
        connections: new Map(),
        pending: new Set(),
      };
      this.owners.set(owner, state);
    }
    if (state.closed) throw Error("WebSocket ownership was revoked");
    return state;
  }
  assertLive(owner, state) {
    if (state.closed || !this.owns(owner))
      throw Error("WebSocket ownership was revoked");
  }
  async dispose(owner, reason = "ownership-ended") {
    const state = this.owners.get(owner);
    if (!state) return;
    state.closed = true;
    for (const connection of state.connections.values())
      this.end(connection, reason);
    await Promise.allSettled([...state.pending]);
    await Promise.allSettled(
      [...state.connections.keys()].map(
        (id) => this.sessions.sessions.get(id)?.recordPromise,
      ),
    );
    this.owners.delete(owner);
  }
  async revokeProject(projectId) {
    const pending = [];
    for (const state of this.owners.values()) {
      state.blockedProjects.add(projectId);
      for (const connection of state.connections.values()) {
        if (connection.projectId !== projectId) continue;
        this.end(connection, "project-archived");
        pending.push(this.sessions.sessions.get(connection.id)?.recordPromise);
      }
      for (const op of state.operations.values())
        if (op.projectId === projectId && op.task) pending.push(op.task);
    }
    await Promise.allSettled(pending);
  }
  end(connection, reason) {
    clearTimeout(connection.timer);
    connection.ended = true;
    connection.ownershipCloseReason ??= reason;
    this.sessions.stop(
      connection.id,
      reason === "mcp-lease-expired" ? "deadline" : "manual",
    );
  }
  arm(connection) {
    clearTimeout(connection.timer);
    connection.leaseUntil = Math.min(
      this.now() + this.leaseMs,
      connection.absoluteUntil,
    );
    connection.timer = setTimeout(
      () => this.end(connection, "mcp-lease-expired"),
      Math.max(0, connection.leaseUntil - this.now()),
    );
    connection.timer.unref?.();
  }
  connection(state, args, active = false) {
    const connection = state.connections.get(args.sessionId);
    if (!connection || connection.projectId !== args.projectId)
      throw Error(
        "WebSocket session does not belong to this MCP owner and project",
      );
    if (!connection.ended && this.now() >= connection.leaseUntil)
      this.end(connection, "mcp-lease-expired");
    const session = this.sessions.get(connection.id);
    if (
      active &&
      (connection.ended || !["connecting", "open"].includes(session.state))
    )
      throw Error(
        "WebSocket session has ended; it cannot be renewed or sent to",
      );
    return connection;
  }
  receipt(connection) {
    const session = this.sessions.get(connection.id);
    return {
      sessionId: connection.id,
      projectId: connection.projectId,
      state: session.state,
      leaseUntil: new Date(connection.leaseUntil).toISOString(),
      absoluteUntil: new Date(connection.absoluteUntil).toISOString(),
      createdAt: session.createdAt,
      finishedAt: session.finishedAt ?? null,
      closeReason: session.closeReason ?? null,
      ownershipCloseReason: connection.ownershipCloseReason ?? null,
      totalEvents: session.totalEvents,
      dataBytes: session.bytes,
      overflow: session.overflow === true,
      ...(session.receipt || {
        recordSaved: false,
        recordPending: session.recordPending === true,
      }),
    };
  }
  operationReceipt(op) {
    return structuredClone({
      operationId: op.id,
      projectId: op.projectId,
      action: op.action,
      state: op.state,
      ...(op.sessionId ? { sessionId: op.sessionId } : {}),
      ...(op.eventId ? { eventId: op.eventId } : {}),
      ...(op.error ? { error: op.error } : {}),
      remoteConfirmed: false,
      retrySafe: false,
    });
  }
  call(action, owner, args) {
    if (
      !fields[action] ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some((key) => !fields[action].includes(key))
    )
      throw Error("Unsupported WebSocket tool arguments");
    for (const key of fields[action].filter(
      (key) => !["message", "afterEvent", "limit"].includes(key),
    )) {
      if (!identifier(args[key])) throw Error("Invalid WebSocket " + key);
    }
    if (
      action === "send" &&
      (typeof args.message !== "string" ||
        !args.message.isWellFormed() ||
        Buffer.byteLength(args.message) > 1048576)
    )
      throw Error(
        "WebSocket message must be a bounded well-formed text string",
      );
    if (
      action === "get" &&
      ((args.afterEvent !== undefined &&
        (!Number.isSafeInteger(args.afterEvent) || args.afterEvent < 0)) ||
        (args.limit !== undefined &&
          (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)))
    )
      throw Error("Invalid bounded WebSocket event page");
    const state = this.state(owner);
    if (state.blockedProjects.has(args.projectId))
      throw Error("WebSocket project grant has been revoked");
    if (action === "operation") {
      const op = state.operations.get(args.operationId);
      if (!op || op.projectId !== args.projectId)
        throw Error(
          "WebSocket operation does not belong to this owner and project",
        );
      return this.operationReceipt(op);
    }
    if (action === "start" || action === "send") {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([action, ...fields[action].map((key) => args[key])]),
        )
        .digest("hex");
      const existing = state.operations.get(args.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw Error(
            "WebSocket operation ID was already used with different content",
          );
        return this.operationReceipt(existing);
      }
      if (state.operations.size >= this.maxOperations)
        throw Error(
          "WebSocket operation ledger is full; read or stop existing sessions, then initialize a new MCP session",
        );
      // Reserve before the first asynchronous project read or network action.
      const op = {
        id: args.operationId,
        projectId: args.projectId,
        action,
        fingerprint,
        state: "pending",
      };
      state.operations.set(op.id, op);
      const pending = this.perform(action, owner, state, args, op)
        .catch((error) => {
          if (op.state === "pending") op.state = "failed-before-submit";
          op.error =
            "WebSocket operation failed; inspect its state and stored evidence. No automatic network retry.";
        })
        .then(() => this.operationReceipt(op));
      op.task = pending;
      state.pending.add(pending);
      pending.finally(() => {
        state.pending.delete(pending);
        delete op.task;
      });
      return pending;
    }
    const connection = this.connection(state, args, action === "renew");
    if (action === "renew") this.arm(connection);
    if (action === "stop") {
      this.end(connection, "mcp-stop");
      return Promise.resolve(
        this.sessions.get(connection.id).recordPromise,
      ).then(() => this.receipt(connection));
    }
    const receipt = this.receipt(connection);
    if (action !== "get") return receipt;
    const session = this.sessions.get(connection.id);
    const first = session.totalEvents - session.events.length + 1;
    const after = args.afterEvent ?? 0;
    const events = session.events
      .map((event, index) => ({ ...event, sequence: first + index }))
      .filter((event) => event.sequence > after)
      .slice(0, args.limit ?? 20)
      .map((event) => {
        let data = event.data.slice(0, 4096);
        if (/[\uD800-\uDBFF]$/.test(data)) data = data.slice(0, -1);
        return {
          ...event,
          data,
          truncated: event.truncated || data.length < event.data.length,
        };
      });
    return {
      ...receipt,
      events,
      nextAfterEvent: events.at(-1)?.sequence ?? after,
      droppedBeforePage: Math.max(0, first - after - 1),
      hasMore: (events.at(-1)?.sequence ?? after) < session.totalEvents,
    };
  }
  async perform(action, owner, state, args, op) {
    if (action === "start") {
      const project = await this.store.get(args.projectId);
      this.assertLive(owner, state);
      if (state.blockedProjects.has(args.projectId))
        throw Error("WebSocket project grant has been revoked");
      if (!project || project.archived)
        throw Error("WebSocket project unavailable");
      const definition = project.protocols?.find(
        (item) => item.id === args.definitionId,
      );
      if (!definition || definition.type !== "websocket")
        throw Error(
          "Only a saved WebSocket definition is supported; no stdio, gRPC or temporary targets",
        );
      const allowed = [
        "id",
        "name",
        "folder",
        "type",
        "url",
        "port",
        "message",
        "handshake",
        "templateMode",
        "protocols",
        "duration",
      ];
      if (Object.keys(definition).some((key) => !allowed.includes(key)))
        throw Error("Unsupported saved WebSocket definition behavior");
      const prepared = prepareWireExecution(project, {
        definitionId: args.definitionId,
      });
      this.assertLive(owner, state);
      if (state.blockedProjects.has(args.projectId))
        throw Error("WebSocket project grant has been revoked");
      // start may attempt a handshake before returning. Never retry an ambiguous
      // exception or represent it as a definitely-unsent operation.
      op.state = "unknown";
      const result = this.sessions.start(prepared.request, {
        ...prepared,
        projectId: project.id,
      });
      op.sessionId = result.id;
      const connection = {
        id: result.id,
        projectId: project.id,
        absoluteUntil: this.now() + 900000,
        ended: false,
        pendingSend: false,
      };
      state.connections.set(result.id, connection);
      this.arm(connection);
      op.state = "started";
      return;
    }
    const connection = this.connection(state, args, true);
    if (connection.pendingSend)
      throw Error(
        "A WebSocket send is already unconfirmed; no concurrent send or automatic replay",
      );
    this.assertLive(owner, state);
    if (state.blockedProjects.has(args.projectId))
      throw Error("WebSocket project grant has been revoked");
    connection.pendingSend = true;
    try {
      const project = await this.store.get(args.projectId);
      this.assertLive(owner, state);
      if (state.blockedProjects.has(args.projectId))
        throw Error("WebSocket project grant has been revoked");
      if (!project || project.archived)
        throw Error("WebSocket project unavailable");
      this.connection(state, args, true);
      this.sessions.send(connection.id, args.message, {
        onSubmitted: () => {
          op.sessionId = connection.id;
          op.state = "pending";
          op.submitted = true;
        },
        onComplete: ({ state: status, eventId }) => {
          op.state = status;
          op.eventId = eventId;
          connection.pendingSend = false;
        },
      });
    } catch (error) {
      connection.pendingSend = false;
      if (op.submitted) op.state = "unknown";
      throw error;
    }
  }
}
