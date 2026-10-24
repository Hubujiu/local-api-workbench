import { legacySocket } from "./socketio-legacy.mjs";
import { BoundedPolling, BoundedWebSocket } from "./socketio-polling.mjs";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { io } from "socket.io-client";
import { randomUUID } from "node:crypto";
import { createSecureContext } from "node:tls";
const MAX = 1024 * 1024;
const reserved = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);
const plain = (x) =>
  x !== null &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
function eventName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    reserved.has(value)
  )
    throw Error("Socket.IO事件名称无效或属于保留事件");
  return value;
}
function eventFilter(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 100)
    throw Error("Socket.IO监听事件最多100项");
  return [...new Set(value.map(eventName))];
}
function jsonData(value, decode = false) {
  let nodes = 0;
  const walk = (x, depth) => {
    if (++nodes > 10000 || depth > 32) throw Error("Socket.IO消息结构超限");
    if (
      Buffer.isBuffer(x) ||
      x instanceof Uint8Array ||
      x instanceof ArrayBuffer
    ) {
      const b = x instanceof ArrayBuffer ? Buffer.from(x) : Buffer.from(x);
      if (b.length > MAX) throw Error("Socket.IO二进制消息超限");
      return decode ? b : { $binary: b.toString("base64") };
    }
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string" && x.isWellFormed()) return x;
    if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
    if (!plain(x)) throw Error("Socket.IO消息须为有限JSON数据");
    if (decode && Object.hasOwn(x, "$binary")) {
      if (Object.keys(x).length !== 1 || typeof x.$binary !== "string")
        throw Error("Socket.IO二进制格式无效");
      const b = Buffer.from(x.$binary, "base64");
      if (b.toString("base64") !== x.$binary || b.length > MAX)
        throw Error("Socket.IO二进制编码无效或超限");
      return b;
    }
    return Object.fromEntries(
      Object.entries(x).map(([k, v]) => {
        if (["__proto__", "prototype", "constructor"].includes(k))
          throw Error("Socket.IO消息包含保留字段");
        return [k, walk(v, depth + 1)];
      }),
    );
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX)
    throw Error("Socket.IO消息超过1MiB");
  return result;
}
function urlDefinition(input) {
  let url;
  if (typeof input.url !== "string" || input.url.length > 8192)
    throw Error("Socket.IO地址过长或无效");
  try {
    url = new URL(input.url);
  } catch {
    throw Error("Socket.IO地址无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Socket.IO仅接受无凭据及查询参数的HTTP/HTTPS地址");
  const path = input.path ?? "/socket.io/";
  if (
    typeof path !== "string" ||
    path.length > 300 ||
    !/^\/[A-Za-z0-9_./-]*$/.test(path) ||
    path.split("/").some((x) => x === ".." || x === ".")
  )
    throw Error("Socket.IO传输路径无效");
  return { url: url.href, path };
}
export function normalizeSocketIODefinition(input) {
  if (
    !plain(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "id",
          "name",
          "url",
          "path",
          "events",
          "transport",
          "version",
        ].includes(k),
    )
  )
    throw Error("Socket.IO定义不保存认证信息或额外字段");
  if (
    input.transport !== undefined &&
    !["websocket", "polling", "auto"].includes(input.transport)
  )
    throw Error("Socket.IO传输类型无效");
  if (input.version !== undefined && ![2, 4].includes(input.version))
    throw Error("Socket.IO版本须为2或4");
  const id = input.id || randomUUID();
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(id))
    throw Error("Socket.IO定义ID无效");
  return {
    id,
    name: String(input.name || "Socket.IO").slice(0, 200),
    ...urlDefinition(input),
    events: eventFilter(input.events),
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.transport !== undefined ? { transport: input.transport } : {}),
  };
}
export function normalizeSocketIODefinitions(values = []) {
  if (!Array.isArray(values) || values.length > 100)
    throw Error("Socket.IO定义最多100个");
  const result = values.map(normalizeSocketIODefinition);
  if (new Set(result.map((x) => x.id)).size !== result.length)
    throw Error("Socket.IO定义ID重复");
  return result;
}
function connection(input) {
  if (
    !plain(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "id",
          "name",
          "url",
          "path",
          "events",
          "auth",
          "query",
          "headers",
          "tls",
          "connectTimeoutMs",
          "transport",
          "version",
        ].includes(k),
    )
  )
    throw Error("Socket.IO连接字段无效");
  const definition = normalizeSocketIODefinition(
    Object.fromEntries(
      ["id", "name", "url", "path", "events", "transport", "version"]
        .filter((k) => input[k] !== undefined)
        .map((k) => [k, input[k]]),
    ),
  );
  const timeout = input.connectTimeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 30000)
    throw Error("Socket.IO连接超时须为50至30000毫秒");
  const transport = input.transport ?? "websocket";
  if (!["websocket", "polling", "auto"].includes(transport))
    throw Error("Socket.IO传输类型无效");
  const auth = input.auth ?? {};
  if (!plain(auth) || Buffer.byteLength(JSON.stringify(auth)) > 8192)
    throw Error("Socket.IO认证信息无效或超过8KiB");
  jsonData(auth);
  if (definition.version === 2 && Object.keys(auth).length)
    throw Error("Socket.IO v2不支持v4 auth，请显式使用query或headers认证");
  const query = input.query ?? {},
    headers = input.headers ?? {};
  for (const [obj, label] of [
    [query, "query"],
    [headers, "headers"],
  ]) {
    if (
      !plain(obj) ||
      Object.keys(obj).length > 100 ||
      Buffer.byteLength(JSON.stringify(obj)) > 8192
    )
      throw Error("Socket.IO " + label + "无效或超限");
    for (const [k, v] of Object.entries(obj)) {
      if (
        !k ||
        typeof v !== "string" ||
        /[\r\n]/.test(k + v) ||
        ["__proto__", "constructor", "prototype"].includes(k)
      )
        throw Error("Socket.IO " + label + "字段无效");
      if (
        label === "query" &&
        ["EIO", "transport", "sid", "t", "b64", "j"].includes(k)
      )
        throw Error("Socket.IO内部传输查询参数不可覆盖");
      if (label === "headers") {
        if (
          [
            "content-type",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "connection",
            "upgrade",
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
          ].includes(k.toLowerCase())
        )
          throw Error("Socket.IO协议控制头不可覆盖");
        try {
          validateHeaderName(k);
          validateHeaderValue(k, v);
        } catch {
          throw Error("Socket.IO头字段无效");
        }
      }
      if (label === "headers" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k))
        throw Error("Socket.IO头名称无效");
    }
  }
  const tls = input.tls ?? {};
  if (
    !plain(tls) ||
    Object.keys(tls).some((k) => !["ca", "key", "cert"].includes(k))
  )
    throw Error("Socket.IO TLS配置无效");
  if (Object.keys(tls).length && !definition.url.startsWith("https:"))
    throw Error("明文Socket.IO不能携带TLS配置");
  for (const x of Object.values(tls))
    if (typeof x !== "string" || !x || Buffer.byteLength(x) > 65536)
      throw Error("Socket.IO证书须为有界PEM");
  if (Boolean(tls.key) !== Boolean(tls.cert))
    throw Error("Socket.IO双向TLS须同时提供证书和私钥");
  if (Object.keys(tls).length) createSecureContext(tls);
  return {
    definition,
    options: {
      autoConnect: false,
      legacyTransport: transport,
      forceNew: true,
      multiplex: false,
      reconnection: false,
      timeout,
      path: definition.path,
      transports:
        transport === "websocket"
          ? [BoundedWebSocket]
          : transport === "polling"
            ? [BoundedPolling]
            : [BoundedPolling, BoundedWebSocket],
      withCredentials: false,
      maxPayload: MAX,
      perMessageDeflate: false,
      auth: structuredClone(auth),
      query: structuredClone(query),
      extraHeaders: structuredClone(headers),
      ...tls,
      rejectUnauthorized: true,
    },
  };
}
export class SocketIOSessions {
  constructor() {
    this.sessions = new Map();
  }
  get(projectId, id) {
    const s = this.sessions.get(id);
    if (!s || s.projectId !== projectId)
      throw Error("Socket.IO会话不存在或不属于此项目");
    return s;
  }
  snapshot(projectId, id) {
    const s = this.get(projectId, id);
    return structuredClone({
      id: s.id,
      type: "socketio",
      state: s.state,
      definition: s.definition,
      createdAt: s.createdAt,
      events: s.events,
      bytes: s.bytes,
      truncated: s.truncated,
      error: s.error,
      transport: s.socket?.io.engine?.transport?.name || s.transport || null,
      connected: !!s.connected,
    });
  }
  record(s, direction, event, args, extra = {}) {
    if (s.sequence >= 10000) throw Error("Socket.IO会话事件总数超过10000项");
    const data = jsonData(args);
    const bytes =
      Buffer.byteLength(JSON.stringify(data)) + Buffer.byteLength(event);
    if (s.bytes + bytes > 8 * MAX) throw Error("Socket.IO会话数据超过8MiB");
    s.bytes += bytes;
    s.events.push({
      id: randomUUID(),
      sequence: ++s.sequence,
      at: new Date().toISOString(),
      direction,
      event,
      args: data,
      ...extra,
    });
    while (
      s.events.length > 200 ||
      Buffer.byteLength(JSON.stringify(s.events)) > 2 * MAX
    ) {
      s.events.shift();
      s.truncated = true;
    }
  }
  release(s) {
    const socket = s.socket;
    if (!socket) return;
    s.transport = socket.io.engine?.transport?.name || s.transport;
    socket.disconnect();
    socket.removeAllListeners();
    s.socket = null;
  }
  list(projectId) {
    return [...this.sessions.values()]
      .filter((s) => s.projectId === projectId)
      .map((s) => this.snapshot(projectId, s.id));
  }
  fail(s, error) {
    if (["closed", "error"].includes(s.state)) return;
    s.error = (
      String(error.message || error) +
      (error.description?.message ? ": " + error.description.message : "")
    ).slice(0, 1000);
    s.state = "error";
    s.pending.clear();
    clearTimeout(s.deadline);
    this.release(s);
  }
  start(projectId, input) {
    if (typeof projectId !== "string" || !projectId || projectId.length > 200)
      throw Error("Socket.IO项目标识无效");
    const { definition, options } = connection(input);
    for (const s of this.sessions.values())
      if (
        this.sessions.size >= 50 &&
        !["open", "connecting"].includes(s.state)
      ) {
        this.sessions.delete(s.id);
      }
    if (
      this.sessions.size >= 50 ||
      [...this.sessions.values()].filter((s) =>
        ["open", "connecting"].includes(s.state),
      ).length >= 5
    )
      throw Error("最多同时打开5个Socket.IO会话，保留50个会话记录");
    const socket =
      definition.version === 2
        ? legacySocket(definition.url, options)
        : io(definition.url, options);
    const s = {
      id: randomUUID(),
      projectId,
      definition,
      createdAt: new Date().toISOString(),
      state: "connecting",
      events: [],
      bytes: 0,
      sequence: 0,
      truncated: false,
      pending: new Map(),
      socket,
      filter: definition.events,
    };
    this.sessions.set(s.id, s);
    s.deadline = setTimeout(() => this.stop(projectId, s.id), 15 * 60 * 1000);
    s.deadline.unref?.();
    socket.on("connect", () => {
      if (s.state === "connecting") {
        s.state = "open";
        s.connected = true;
      } else socket.disconnect();
    });
    socket.on("connect_error", (error) => this.fail(s, error));
    socket.on("disconnect", (reason) => {
      if (!["closed", "error"].includes(s.state)) {
        s.state = reason === "io server disconnect" ? "closed" : "error";
        if (s.state === "error") s.error = String(reason).slice(0, 1000);
      }
      s.pending.clear();
      clearTimeout(s.deadline);
      this.release(s);
    });
    socket.onAny((event, ...args) => {
      if (s.state !== "open") return;
      try {
        eventName(event);
        if (s.filter && !s.filter.includes(event)) return;
        const callback = typeof args.at(-1) === "function" ? args.pop() : null;
        const extra = {};
        if (callback) {
          for (const [id, p] of s.pending)
            if (p.deadline <= Date.now()) s.pending.delete(id);
          if (s.pending.size >= 100)
            throw Error("Socket.IO待确认事件超过100项");
          extra.ackId = randomUUID();
          s.pending.set(extra.ackId, {
            callback,
            deadline: Date.now() + 30000,
          });
        }
        this.record(s, "received", event, args, extra);
      } catch (error) {
        this.fail(s, error);
      }
    });
    socket.connect();
    return this.snapshot(projectId, s.id);
  }
  watch(projectId, id, events) {
    const s = this.get(projectId, id);
    s.filter = eventFilter(events);
    return this.snapshot(projectId, id);
  }
  async send(projectId, id, input) {
    const s = this.get(projectId, id);
    if (s.state !== "open" || !s.socket.connected)
      throw Error("Socket.IO会话当前不可发送");
    if (
      !plain(input) ||
      Object.keys(input).some(
        (k) => !["event", "args", "ackTimeoutMs"].includes(k),
      )
    )
      throw Error("Socket.IO发送字段无效");
    const event = eventName(input.event);
    if (!Array.isArray(input.args) || input.args.length > 100)
      throw Error("Socket.IO参数必须为至多100项的数组");
    const args = jsonData(input.args, true);
    const timeout = input.ackTimeoutMs;
    if (
      timeout !== undefined &&
      (!Number.isInteger(timeout) || timeout < 50 || timeout > 30000)
    )
      throw Error("Socket.IO确认超时须为50至30000毫秒");
    try {
      this.record(s, "sent", event, input.args);
    } catch (error) {
      this.fail(s, error);
      throw error;
    }
    if (timeout === undefined) {
      s.socket.emit(event, ...args);
      return { status: "sent", remoteOutcome: "unknown" };
    }
    return await new Promise((resolve) => {
      s.socket.timeout(timeout).emit(event, ...args, (error, ...values) => {
        if (error) {
          const status = s.state === "open" ? "ack-timeout" : "disconnected";
          try {
            this.record(s, status, event, []);
          } catch (e) {
            this.fail(s, e);
          }
          resolve({ status, remoteOutcome: "unknown" });
          return;
        }
        try {
          const data = jsonData(values);
          this.record(s, "acknowledged", event, data);
          resolve({
            status: "acknowledged",
            args: data,
            remoteOutcome: "acknowledged",
          });
        } catch (error) {
          this.fail(s, error);
          resolve({
            status: "ack-rejected",
            remoteOutcome: "acknowledged",
            error: s.error,
          });
        }
      });
    });
  }
  acknowledge(projectId, id, input) {
    const s = this.get(projectId, id);
    if (
      s.state !== "open" ||
      !plain(input) ||
      Object.keys(input).some((k) => !["ackId", "args"].includes(k)) ||
      !Array.isArray(input.args) ||
      input.args.length > 100
    )
      throw Error("Socket.IO确认参数无效");
    const pending = s.pending.get(input.ackId);
    if (!pending || pending.deadline <= Date.now())
      throw Error("Socket.IO确认标识不存在或已过期");
    const args = jsonData(input.args, true);
    this.record(s, "ack-sent", "ack", input.args, { ackId: input.ackId });
    s.pending.delete(input.ackId);
    pending.callback(...args);
    return { acknowledged: true };
  }
  stop(projectId, id) {
    const s = this.get(projectId, id);
    if (s.state !== "error") s.state = "closed";
    clearTimeout(s.deadline);
    s.pending.clear();
    this.release(s);
    return this.snapshot(projectId, id);
  }
  close() {
    for (const s of this.sessions.values()) this.stop(s.projectId, s.id);
    this.sessions.clear();
  }
}

export function validateSocketIORecord(record) {
  const r = record?.result;
  if (
    !plain(record) ||
    record.type !== "socketio" ||
    !plain(r) ||
    r.id !== record.id ||
    r.type !== "socketio" ||
    !["closed", "error"].includes(r.state) ||
    typeof r.connected !== "boolean" ||
    typeof r.truncated !== "boolean" ||
    !Number.isInteger(r.bytes) ||
    r.bytes < 0 ||
    r.bytes > 8 * MAX ||
    !Array.isArray(r.events) ||
    r.events.length > 200
  )
    throw Error("Socket.IO历史格式无效");
  const definition = normalizeSocketIODefinition(record.definition);
  if (
    JSON.stringify(normalizeSocketIODefinition(r.definition)) !==
    JSON.stringify(definition)
  )
    throw Error("Socket.IO历史定义快照不一致");
  const ids = new Set();
  for (const event of r.events) {
    if (
      !plain(event) ||
      typeof event.id !== "string" ||
      !event.id ||
      event.id.length > 200 ||
      ids.has(event.id) ||
      ![
        "received",
        "sent",
        "acknowledged",
        "ack-sent",
        "ack-timeout",
        "disconnected",
      ].includes(event.direction) ||
      !Array.isArray(event.args) ||
      !Number.isFinite(Date.parse(event.at))
    )
      throw Error("Socket.IO历史事件无效");
    eventName(event.event);
    jsonData(event.args);
    ids.add(event.id);
  }
}

export function validateSocketIOConnection(input) {
  connection(input);
}
export function validateSocketIOEvent(value) {
  return eventName(value);
}
export function validateSocketIOArgs(value) {
  if (!Array.isArray(value) || value.length > 100)
    throw Error("Socket.IO参数必须为至多100项的数组");
  jsonData(value, true);
}
