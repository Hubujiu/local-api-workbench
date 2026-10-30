import { randomUUID, timingSafeEqual } from "node:crypto";
import { nativeWriteDigest } from "./native-redis-write-intent.mjs";
import { validateDatabaseWriteReceipts } from "./database-write-receipts.mjs";

const WINDOW = 300_000;
const SNAPSHOT_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
const TERMINAL_BYTES = 64 * 1024;
const fail = (code = "NATIVE_WRITE_DENIED") => {
  throw Object.assign(Error("原生写入授权无效、已失效或不可用"), { code });
};
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value.isWellFormed();
function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function json(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail();
    return { value: JSON.parse(encoded), bytes: Buffer.byteLength(encoded) };
  } catch {
    fail();
  }
}
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function safeTarget(target) {
  if (
    !target ||
    typeof target.host !== "string" ||
    !target.host ||
    target.host.length > 253 ||
    target.host.trim() !== target.host ||
    !target.host.isWellFormed() ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535 ||
    !Number.isInteger(target.database) ||
    target.database < 0 ||
    target.database > 1023 ||
    typeof target.ssl !== "boolean"
  )
    fail();
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    ssl: target.ssl,
  };
}
function safeReview(input) {
  if (
    !input ||
    !["before", "after"].includes(input.phase) ||
    !Number.isInteger(input.ordinal) ||
    input.ordinal < 0 ||
    input.ordinal >= 16 ||
    !text(input.connectionId) ||
    !text(input.sessionGeneration) ||
    !Array.isArray(input.command) ||
    input.command.length !== 3 ||
    input.command[0] !== "SET" ||
    input.command
      .slice(1)
      .some(
        (v) =>
          typeof v !== "string" ||
          !v.isWellFormed() ||
          Buffer.byteLength(v) > 4096 ||
          /\{\{/.test(v),
      ) ||
    !input.command[1] ||
    (input.taskId !== undefined && !text(input.taskId)) ||
    (input.sourceId !== undefined && !text(input.sourceId))
  )
    fail();
  // Project credentials, raw target config, arbitrary fields and private binding
  // hashes must never participate in a public digest or review response.
  return frozen({
    version: 1,
    phase: input.phase,
    ordinal: input.ordinal,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    connectionId: input.connectionId,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    sessionGeneration: input.sessionGeneration,
    safeTarget: safeTarget(input.safeTarget),
    command: [...input.command],
    warning: "SET replaces the value and removes its prior TTL",
  });
}

/** Host-only ledger. Routes supply authenticated project scope and validated
 * host closures; no input object, imported plan or hash is a capability. */
export class NativeWriteAuthorizations {
  #entries = new Map();
  #preparations = new WeakMap();
  #pendingCount = 0;
  #pendingBytes = 0;
  #handles = new WeakMap();
  #now;
  #closed = false;
  #generation = 0;
  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }
  #release(entry) {
    const release = entry.onRelease;
    entry.onRelease = undefined;
    entry.snapshot = entry.binding = entry.review = undefined;
    entry.checkAdmission = entry.checkLive = undefined;
    try {
      release?.(entry.preparationId);
    } catch {
      /* Cleanup cannot erase a fixed receipt. */
    }
  }
  #sweep() {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.state === "reserved") continue;
      if (now >= (entry.terminalExpiresAt ?? entry.expiresAt)) {
        entry.controller.abort();
        this.#entries.delete(id);
        this.#release(entry);
      }
    }
  }
  #entry(projectId, id) {
    this.#sweep();
    const entry = this.#entries.get(id);
    if (!text(projectId) || !entry || entry.projectId !== projectId) fail();
    return entry;
  }
  #current(entry, state) {
    if (
      this.#closed ||
      this.#entries.get(entry.preparationId) !== entry ||
      entry.state !== state ||
      entry.controller.signal.aborted ||
      (state !== "reserved" && this.#now() >= entry.expiresAt)
    )
      fail();
    try {
      if (entry.checkLive() !== true) fail();
    } catch {
      fail();
    }
  }
  async #admit(entry, state) {
    this.#current(entry, state);
    try {
      if ((await entry.checkAdmission()) !== true) fail();
    } catch {
      fail();
    }
    // Async lookup may race a revoke, expiry, close or competing reservation.
    this.#current(entry, state);
  }
  #reservePreparation(bytes) {
    if (this.#closed) fail();
    this.#sweep();
    const used = [...this.#entries.values()].reduce((n, x) => n + x.bytes, 0);
    if (
      this.#entries.size + this.#pendingCount >= 20 ||
      used + this.#pendingBytes + bytes > TOTAL_BYTES
    )
      fail("NATIVE_WRITE_CAPACITY");
    const ticket = Object.freeze({});
    this.#preparations.set(ticket, { bytes, claimed: false });
    this.#pendingCount++;
    this.#pendingBytes += bytes;
    return ticket;
  }
  // Host-only outer preparation reservation, before even asynchronous project
  // reads. Conservative 5 MiB precharge covers a 4 MiB snapshot plus config.
  beginPreparation() {
    return this.#reservePreparation(5 * 1024 * 1024);
  }
  #releasePreparation(ticket) {
    const record = this.#preparations.get(ticket);
    if (record === undefined) return;
    const { bytes } = record;
    this.#preparations.delete(ticket);
    this.#pendingCount--;
    this.#pendingBytes -= bytes;
  }
  cancelPreparation(ticket) {
    const record = this.#preparations.get(ticket);
    if (!record) return;
    record.cancelled = true;
    // A pending async preparation still owns its retained snapshot until it
    // settles; cancellation is not permission to undercount that memory.
    if (!record.active) this.#releasePreparation(ticket);
  }

  async prepare(
    projectId,
    {
      snapshot,
      review,
      binding,
      checkAdmission,
      checkLive,
      onRelease,
      reservation,
    },
  ) {
    if (
      !text(projectId) ||
      this.#closed ||
      typeof checkAdmission !== "function" ||
      typeof checkLive !== "function" ||
      (onRelease !== undefined && typeof onRelease !== "function")
    )
      fail();
    const generation = this.#generation;
    const safe = safeReview(review);
    // A host preparation ticket transfers ownership of its freshly constructed
    // snapshot (the router never accepts tickets). Ordinary callers are cloned.
    if (reservation !== undefined) {
      const reserved = this.#preparations.get(reservation);
      if (!reserved || reserved.claimed) fail();
      reserved.claimed = true;
    }
    const snap =
      reservation === undefined
        ? json(snapshot)
        : {
            value: snapshot,
            bytes: Buffer.byteLength(JSON.stringify(snapshot)),
          };
    if (snap.bytes > SNAPSHOT_BYTES) fail("NATIVE_WRITE_CAPACITY");
    const privateBinding = json(binding ?? null);
    const data = {
      snapshot: snap.value,
      binding: privateBinding.value,
      review: safe,
    };
    const dataBytes = Buffer.byteLength(JSON.stringify(data));
    if (dataBytes > TOTAL_BYTES) fail("NATIVE_WRITE_CAPACITY");
    // Retain one cloned snapshot; do not keep the caller's potentially mutable
    // input or a second JSON clone across asynchronous admission.
    snapshot = binding = review = undefined;
    const entry = {
      preparationId: randomUUID(),
      runId: randomUUID(),
      projectId,
      snapshot: frozen(data.snapshot),
      binding: frozen(data.binding),
      review: safe,
      checkAdmission,
      checkLive,
      onRelease,
      controller: new AbortController(),
      state: "prepared",
      expiresAt: this.#now() + WINDOW,
      consumed: false,
      // Reserve compact outcome space before admitting any effects.
      bytes: Math.max(dataBytes + 2048, TERMINAL_BYTES),
    };
    if (
      reservation !== undefined &&
      (!this.#preparations.has(reservation) ||
        this.#preparations.get(reservation).bytes < entry.bytes)
    )
      fail("NATIVE_WRITE_CAPACITY");
    const ticket = reservation ?? this.#reservePreparation(entry.bytes);
    this.#preparations.get(ticket).claimed = true;
    this.#preparations.get(ticket).active = true;
    try {
      try {
        if (
          checkLive() !== true ||
          (await checkAdmission()) !== true ||
          checkLive() !== true
        )
          fail();
      } catch {
        fail();
      }
      if (
        this.#closed ||
        generation !== this.#generation ||
        !this.#preparations.has(ticket) ||
        this.#preparations.get(ticket).cancelled ||
        this.#now() >= entry.expiresAt
      )
        fail();
    } finally {
      this.#releasePreparation(ticket);
    }
    entry.digest = nativeWriteDigest({
      version: 1,
      projectId,
      preparationId: entry.preparationId,
      review: safe,
    });
    entry.commandDigest = nativeWriteDigest(safe.command);
    this.#entries.set(entry.preparationId, entry);
    return {
      preparationId: entry.preparationId,
      runId: entry.runId,
      review: structuredClone(safe),
      digest: entry.digest,
      expiresAt: entry.expiresAt,
      terminalRetentionMs: WINDOW,
    };
  }
  async authorize(
    projectId,
    id,
    { digest, phase, ordinal, acknowledgeReplacement } = {},
  ) {
    const entry = this.#entry(projectId, id);
    if (
      digest !== entry.digest ||
      phase !== entry.review?.phase ||
      ordinal !== entry.review?.ordinal ||
      acknowledgeReplacement !== true
    )
      fail();
    await this.#admit(entry, "prepared");
    this.#current(entry, "prepared");
    entry.token = randomUUID() + randomUUID();
    entry.state = "authorized";
    return {
      token: entry.token,
      preparationId: id,
      expiresAt: entry.expiresAt,
    };
  }
  async reserve(projectId, id, token) {
    const entry = this.#entry(projectId, id);
    if (!sameSecret(token, entry.token)) fail();
    try {
      await this.#admit(entry, "authorized");
      this.#current(entry, "authorized");
      if (!sameSecret(token, entry.token)) fail();
    } catch (error) {
      // A correct-token execute attempt burns an admission failure. Do not
      // revoke another concurrent caller which already reserved this entry.
      if (this.#entries.get(id) === entry && entry.state === "authorized") {
        this.revoke(projectId, id);
        throw Object.assign(
          Error(
            "写入执行入场核验已拒绝，旧令牌已永久失效；未启动执行，请重新准备并明确授权",
          ),
          { code: "NATIVE_WRITE_ADMISSION_REVOKED" },
        );
      }
      throw error;
    }
    entry.state = "reserved";
    entry.token = undefined;
    const handle = Object.freeze({
      preparationId: id,
      runId: entry.runId,
      projectId,
      get snapshot() {
        return entry.snapshot;
      },
      get binding() {
        return entry.binding;
      },
      get review() {
        return entry.review;
      },
      signal: entry.controller.signal,
      assertLive: () => this.#current(entry, "reserved"),
      consume: () => {
        this.#current(entry, "reserved");
        if (entry.consumed) fail();
        entry.consumed = true;
      },
    });
    this.#handles.set(handle, entry);
    return handle;
  }
  revoke(projectId, id) {
    const entry = this.#entry(projectId, id);
    if (entry.state === "reserved") entry.controller.abort();
    else if (["prepared", "authorized"].includes(entry.state)) {
      entry.controller.abort();
      entry.state = "revoked";
      entry.token = undefined;
      this.#release(entry);
      entry.bytes = 2048;
      entry.terminalExpiresAt = this.#now() + WINDOW;
    }
    return this.status(projectId, id);
  }
  complete(handle, outcome) {
    const entry = this.#handles.get(handle);
    if (!entry || this.#entries.get(entry.preparationId) !== entry) fail();
    if (entry.state === "completed")
      return this.status(entry.projectId, entry.preparationId);
    if (entry.state !== "reserved") fail();
    const receipts = validateDatabaseWriteReceipts(outcome?.writeReceipts);
    if (
      receipts.length !== 1 ||
      receipts[0].projectId !== entry.projectId ||
      receipts[0].preparationId !== entry.preparationId ||
      receipts[0].runId !== entry.runId ||
      receipts[0].phase !== entry.review.phase ||
      receipts[0].ordinal !== entry.review.ordinal ||
      receipts[0].connectionId !== entry.review.connectionId ||
      receipts[0].taskId !== entry.review.taskId ||
      receipts[0].commandDigest !== entry.commandDigest ||
      (!entry.consumed && receipts[0].outcome !== "not-sent")
    )
      fail();
    const compact = {
      writeReceipts: receipts,
      status: ["passed", "failed", "cancelled"].includes(outcome.status)
        ? outcome.status
        : "failed",
      recordSaved: outcome.recordSaved === true,
      ...(text(outcome.attemptedRecordId)
        ? { attemptedRecordId: outcome.attemptedRecordId }
        : {}),
      ...(outcome.recordSaved === true && text(outcome.recordId)
        ? { recordId: outcome.recordId }
        : {}),
      ...(outcome.recordSaved === true
        ? {}
        : {
            persistenceOutcome: {
              code: [
                "PROJECT_COMMIT_UNCERTAIN",
                "PROJECT_RECOVERY_REQUIRED",
                "RECORD_SAVE_FAILED",
              ].includes(outcome.persistenceOutcome?.code)
                ? outcome.persistenceOutcome.code
                : "RECORD_SAVE_FAILED",
              retry_safe: false,
            },
          }),
    };
    const data = json(compact);
    if (data.bytes + 1024 > TERMINAL_BYTES) fail("NATIVE_WRITE_CAPACITY");
    entry.terminal = frozen(data.value);
    entry.state = "completed";
    entry.terminalExpiresAt = this.#now() + WINDOW;
    this.#release(entry);
    entry.bytes = data.bytes + 1024;
    return this.status(entry.projectId, entry.preparationId);
  }
  status(projectId, id) {
    const entry = this.#entry(projectId, id);
    return {
      preparationId: entry.preparationId,
      runId: entry.runId,
      state: entry.state,
      revoked: entry.controller.signal.aborted,
      expiresAt: entry.terminalExpiresAt ?? entry.expiresAt,
      ...(entry.terminal ? structuredClone(entry.terminal) : {}),
    };
  }
  close() {
    this.#closed = true;
    this.#generation++;
    for (const entry of this.#entries.values()) {
      entry.controller.abort();
      if (entry.state !== "reserved") {
        entry.token = undefined;
        this.#release(entry);
        if (entry.state !== "completed") entry.state = "revoked";
        entry.bytes = entry.terminal ? entry.bytes : 2048;
      }
    }
  }
}
