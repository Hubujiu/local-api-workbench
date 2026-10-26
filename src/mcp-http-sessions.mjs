import { randomUUID } from "node:crypto";
export const requestKey = (id) => {
  if (typeof id === "string" && Buffer.byteLength(id) <= 256) return "s:" + id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return "n:" + id;
  throw Error("Invalid MCP request ID");
};
// Session IDs are ephemeral routing identifiers, not project permissions.
export class MCPHTTPSessions {
  #sessions = new Map();
  #epoch = 0;
  constructor({
    now = Date.now,
    maxSessions = 32,
    idleMs = 900000,
    maxRequests = 1024,
  } = {}) {
    this.now = now;
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.maxRequests = maxRequests;
  }
  capture() {
    return this.#epoch;
  }
  #prune() {
    for (const [id, session] of this.#sessions)
      if (!session.inflight && this.now() - session.lastUsed > this.idleMs)
        this.#sessions.delete(id);
  }
  create(requestId) {
    // Validate initialization before allocating a bounded session slot.
    if (requestId !== undefined) requestKey(requestId);
    this.#prune();
    if (this.#sessions.size >= this.maxSessions)
      throw Error("MCP session limit reached");
    const id = randomUUID();
    this.#sessions.set(id, {
      lastUsed: this.now(),
      seen: new Set(),
      inflight: 0,
      active: new Map(),
    });
    return id;
  }
  get(id) {
    this.#prune();
    const session = typeof id === "string" ? this.#sessions.get(id) : undefined;
    if (session) session.lastUsed = this.now();
    return session;
  }
  begin(id, requestId, cancellable) {
    const session = this.get(id);
    if (!session) throw Error("Unknown MCP session");
    const key = requestKey(requestId);
    if (session.seen.has(key))
      throw Error("MCP request ID cannot be reused in this session");
    if (session.seen.size >= this.maxRequests)
      throw Error(
        "MCP session request limit reached; initialize a new session",
      );
    session.seen.add(key);
    session.inflight++;
    const controller = cancellable ? new AbortController() : undefined;
    const active = { controller, epoch: this.#epoch, notified: false };
    if (controller) session.active.set(key, active);
    let finished = false;
    return {
      signal: controller?.signal,
      get cancelledByNotification() {
        return active.notified;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        session.inflight--;
        if (controller && session.active.get(key)?.controller === controller)
          session.active.delete(key);
        session.lastUsed = this.now();
      },
    };
  }
  cancel(id, requestId) {
    const session = this.get(id);
    if (!session) return;
    let key;
    try {
      key = requestKey(requestId);
    } catch {
      return;
    }
    const active = session.active.get(key);
    if (active?.epoch === this.#epoch) {
      active.notified = true;
      active.controller.abort();
    }
  }
  delete(id) {
    const session = this.get(id);
    if (!session) return false;
    for (const { controller } of session.active.values()) controller.abort();
    this.#sessions.delete(id);
    return true;
  }
  advance({ dropSessions = false } = {}) {
    this.#epoch++;
    for (const session of this.#sessions.values()) {
      for (const { controller } of session.active.values()) controller.abort();
      session.active.clear();
    }
    if (dropSessions) this.#sessions.clear();
  }
}
