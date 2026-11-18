import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { compileOracleRead } from "./oracle-read-contract.mjs";
import { queryOracleRead } from "./oracle-read-process.mjs";

const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const identity = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail("ORACLE_SESSION_SCOPE_INVALID");
  return value;
};
const plain = (value, keys) => {
  if (
    !value ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("ORACLE_SESSION_INPUT_INVALID");
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !Object.hasOwn(d, "value")
    )
      fail("ORACLE_SESSION_INPUT_INVALID");
    out[key] = d.value;
  }
  return out;
};

// Host opt-in only. Never registered in public HTTP, CLI, MCP or GUI.
export class OracleReadSessions {
  #enabled;
  #query;
  #grants = new Map();
  #closed = false;
  constructor({ enabled = false, query = queryOracleRead } = {}) {
    if (typeof enabled !== "boolean" || typeof query !== "function")
      fail("ORACLE_SESSION_CONFIG_INVALID");
    this.#enabled = enabled;
    this.#query = query;
  }
  #scope(ownerId, projectId) {
    identity(ownerId);
    identity(projectId);
    if (!this.#enabled || this.#closed) fail("ORACLE_SESSION_DISABLED");
  }
  #drop(id, item) {
    clearTimeout(item.timer);
    item.controller.abort();
    this.#grants.delete(id);
  }
  #owned(ownerId, projectId, id) {
    this.#scope(ownerId, projectId);
    const item = this.#grants.get(id);
    if (!item || item.ownerId !== ownerId || item.projectId !== projectId)
      fail("ORACLE_SESSION_UNAVAILABLE");
    if (Date.now() >= item.expiresAt) {
      this.#drop(id, item);
      fail("ORACLE_SESSION_UNAVAILABLE");
    }
    return item;
  }
  register(ownerId, projectId, input) {
    this.#scope(ownerId, projectId);
    input = plain(input, ["connection", "relations", "ttlMs"]);
    const ttl = input.ttlMs ?? 900000;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 900000)
      fail("ORACLE_SESSION_INPUT_INVALID");
    const values = input.relations;
    if (
      !Array.isArray(values) ||
      types.isProxy(values) ||
      Object.getPrototypeOf(values) !== Array.prototype ||
      values.length < 1 ||
      values.length > 16 ||
      Reflect.ownKeys(values).length !== values.length + 1
    )
      fail("ORACLE_SESSION_INPUT_INVALID");
    const relations = new Set();
    for (let i = 0; i < values.length; i++) {
      const d = Object.getOwnPropertyDescriptor(values, String(i));
      if (
        !d ||
        !Object.hasOwn(d, "value") ||
        typeof d.value !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,29}\.[A-Za-z_][A-Za-z0-9_]{0,29}$/.test(
          d.value,
        )
      )
        fail("ORACLE_SESSION_INPUT_INVALID");
      relations.add(d.value.toUpperCase());
    }
    if (relations.size !== values.length) fail("ORACLE_SESSION_INPUT_INVALID");
    compileOracleRead({
      connection: input.connection,
      sql: `SELECT id FROM ${values[0]}`,
    });
    const connection = structuredClone(input.connection);
    for (const [id, item] of this.#grants)
      if (Date.now() >= item.expiresAt) this.#drop(id, item);
    if (this.#grants.size >= 20) fail("ORACLE_SESSION_CAPACITY");
    const id = randomUUID();
    const item = {
      ownerId,
      projectId,
      connection,
      relations,
      expiresAt: Date.now() + ttl,
      controller: new AbortController(),
    };
    item.timer = setTimeout(() => this.#drop(id, item), ttl);
    item.timer.unref();
    this.#grants.set(id, item);
    return {
      id,
      type: "oracle",
      expiresAt: item.expiresAt,
      relations: [...relations],
    };
  }
  list(ownerId, projectId) {
    this.#scope(ownerId, projectId);
    const out = [];
    for (const [id, item] of this.#grants) {
      if (Date.now() >= item.expiresAt) this.#drop(id, item);
      else if (item.ownerId === ownerId && item.projectId === projectId)
        out.push({
          id,
          type: "oracle",
          expiresAt: item.expiresAt,
          relations: [...item.relations],
        });
    }
    return out;
  }
  revoke(ownerId, projectId, id) {
    this.#drop(id, this.#owned(ownerId, projectId, id));
  }
  async query(ownerId, projectId, id, request, { signal } = {}) {
    const item = this.#owned(ownerId, projectId, id);
    request = plain(request, ["sql", "parameters"]);
    const input = { connection: item.connection, ...request };
    const plan = compileOracleRead(input);
    if (!item.relations.has(plan.relation))
      fail("ORACLE_SESSION_RELATION_DENIED");
    const snapshot = structuredClone(input);
    const combined = signal
      ? AbortSignal.any([signal, item.controller.signal])
      : item.controller.signal;
    if (combined.aborted) fail("ORACLE_SESSION_CANCELLED");
    let result;
    try {
      result = await this.#query(snapshot, { signal: combined });
    } catch (error) {
      if (error?.code === "ORACLE_READ_CLEANUP_UNCONFIRMED")
        fail("ORACLE_SESSION_CLEANUP_UNCONFIRMED");
      if (combined.aborted) fail("ORACLE_SESSION_CANCELLED");
      fail("ORACLE_SESSION_QUERY_FAILED");
    }
    if (combined.aborted) fail("ORACLE_SESSION_CANCELLED");
    if (this.#owned(ownerId, projectId, id) !== item)
      fail("ORACLE_SESSION_UNAVAILABLE");
    return result;
  }
  close() {
    this.#closed = true;
    for (const [id, item] of this.#grants) this.#drop(id, item);
  }
}
