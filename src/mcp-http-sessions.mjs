import { randomUUID } from "node:crypto";
export const requestKey = (id) => {
  if (typeof id === "string" && Buffer.byteLength(id) <= 256) return "s:" + id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return "n:" + id;
  throw Error("Invalid MCP request ID");
};
// Session IDs are ephemeral routing identifiers, not project permissions.
export class MCPHTTPSessions {
  #sessions = new Map();
  #transient = new Set();
  #epoch = 0;
  #closed = false;
  #owners = new WeakSet();
  #pendingDisposals = new Set();
  constructor({
    now = Date.now,
    maxSessions = 32,
    idleMs = 900000,
    maxRequests = 1024,
    maxTransient = 32,
    onDispose,
  } = {}) {
    this.onDispose = onDispose;
    this.now = now;
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.maxRequests = maxRequests;
    this.maxTransient = maxTransient;
  }
  capture() {
    return this.#epoch;
  }
  #newOwner() {
    const owner = Object.freeze({ epoch: this.#epoch });
    this.#owners.add(owner);
    return owner;
  }
  owner(id) {
    return this.get(id)?.owner;
  }
  owns(owner) {
    return !!owner && this.#owners.has(owner);
  }
  #dispose(session, reason) {
    const owner = session.owner;
    if (!this.#owners.delete(owner)) return;
    // Revoke synchronously, before any asynchronous socket/storage drain.
    let result;
    try {
      result = this.onDispose?.(owner, reason);
    } catch (error) {
      result = Promise.reject(error);
    }
    const pending = Promise.resolve(result).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    this.#pendingDisposals.add(pending);
    pending.then(() => this.#pendingDisposals.delete(pending));
  }
  async drain() {
    const results = [];
    while (this.#pendingDisposals.size)
      results.push(...(await Promise.all([...this.#pendingDisposals])));
    return results;
  }
  #arm(id, session) {
    clearTimeout(session.idleTimer);
    if (!Number.isFinite(this.idleMs) || session.inflight) return;
    session.idleTimer = setTimeout(
      () => {
        if (this.#sessions.get(id) !== session) return;
        this.#prune();
        if (this.#sessions.get(id) === session) this.#arm(id, session);
      },
      Math.max(1, this.idleMs - (this.now() - session.lastUsed) + 1),
    );
    session.idleTimer.unref?.();
  }
  #prune() {
    for (const [id, session] of this.#sessions)
      if (!session.inflight && this.now() - session.lastUsed > this.idleMs) {
        this.#sessions.delete(id);
        clearTimeout(session.idleTimer);
        this.#dispose(session, "expired");
      }
  }
  create(requestId) {
    if (this.#closed) throw Error("MCP execution ownership is closed");
    // Validate initialization before allocating a bounded session slot.
    if (requestId !== undefined) requestKey(requestId);
    this.#prune();
    if (this.#sessions.size >= this.maxSessions)
      throw Error("MCP session limit reached");
    const id = randomUUID();
    const session = {
      owner: this.#newOwner(),
      lastUsed: this.now(),
      seen: new Set(),
      inflight: 0,
      active: new Map(),
    };
    this.#sessions.set(id, session);
    this.#arm(id, session);
    return id;
  }
  get(id) {
    this.#prune();
    const session = typeof id === "string" ? this.#sessions.get(id) : undefined;
    if (session) {
      session.lastUsed = this.now();
      this.#arm(id, session);
    }
    return session;
  }
  begin(id, requestId, cancellable) {
    if (this.#closed) throw Error("MCP execution ownership is closed");
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
    clearTimeout(session.idleTimer);
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
        if (this.#sessions.get(id) === session) this.#arm(id, session);
      },
    };
  }
  beginTransient() {
    if (this.#closed) throw Error("MCP execution ownership is closed");
    if (this.#transient.size >= this.maxTransient)
      throw Error("MCP transient execution limit reached");
    const active = { controller: new AbortController(), epoch: this.#epoch };
    this.#transient.add(active);
    let finished = false;
    return {
      signal: active.controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        this.#transient.delete(active);
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
    clearTimeout(session.idleTimer);
    this.#dispose(session, "deleted");
    return true;
  }
  advance({ dropSessions = false } = {}) {
    this.#epoch++;
    for (const { controller } of this.#transient) controller.abort();
    for (const session of this.#sessions.values()) {
      for (const { controller } of session.active.values()) controller.abort();
      session.active.clear();
      this.#dispose(session, this.#closed ? "closed" : "authorization-changed");
      if (dropSessions) clearTimeout(session.idleTimer);
      else session.owner = this.#newOwner();
    }
    if (dropSessions) this.#sessions.clear();
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.advance({ dropSessions: true });
  }
}
