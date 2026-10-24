import { boundLegacyPolling } from "./socketio-legacy-polling.mjs";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { checkedEngineIOPacket } from "./socketio-handshake.mjs";
const require = createRequire(import.meta.url);
const MAX = 1024 * 1024;
const WIRE_BUDGET = Symbol("local legacy wire budget");
let cachedManager;
function legacyManager() {
  if (cachedManager) return cachedManager;
  const Manager = require("socket.io-client-v2/lib/manager");
  const legacyRequire = createRequire(
    require.resolve("socket.io-client-v2/package.json"),
  );
  const Engine = legacyRequire("engine.io-client");
  // This package alias has its own Engine.IO 3 module graph. All of its transports
  // must use bounded acquisition; the modern Engine.IO 4 implementation is untouched.
  const originalCreate = Engine.Socket.prototype.createTransport;
  Engine.Socket.prototype.createTransport = function (name) {
    if (!["websocket", "polling"].includes(name))
      throw Error("Unsupported legacy transport");
    const transport = originalCreate.call(this, name),
      owner = this;
    const packet = transport.onPacket,
      data = transport.onData;
    const budget = (owner[WIRE_BUDGET] ||= { bytes: 0, frames: 0, packets: 0 });
    transport.onPacket = function (value) {
      if (this.readyState === "closed" || ++budget.packets > 10000)
        throw Error("Legacy packet budget exceeded or transport closed");
      try {
        if (value.type === "open") {
          const handshake = JSON.parse(value.data);
          // EIO3 has no maxPayload negotiation. Supply only our own local cap.
          if (!Object.hasOwn(handshake, "maxPayload"))
            handshake.maxPayload = MAX;
          value = checkedEngineIOPacket(
            { ...value, data: JSON.stringify(handshake) },
            owner.id,
          );
        }
        return packet.call(this, value);
      } catch (error) {
        this.onError("Invalid Engine.IO 3 packet", error);
      }
    };
    transport.onData = function (value) {
      if (this.readyState === "closed") return;
      try {
        budget.bytes +=
          typeof value === "string"
            ? Buffer.byteLength(value)
            : (value.byteLength ?? value.length);
        if (
          !Number.isSafeInteger(budget.bytes) ||
          budget.bytes > 8 * MAX ||
          ++budget.frames > 10000
        )
          throw Error("Socket.IO v2 wire budget exceeded");
        return data.call(this, value);
      } catch (error) {
        this.onError("Invalid Engine.IO 3 data", error);
      }
    };
    if (name === "polling") return boundLegacyPolling(transport);
    transport.doOpen = function () {
      try {
        this.ws = new WebSocket(this.uri(), {
          agent: false,
          perMessageDeflate: false,
          maxPayload: MAX,
          followRedirects: false,
          handshakeTimeout: owner.requestTimeout || 5000,
          headers: this.extraHeaders,
          ca: this.ca,
          key: this.key,
          cert: this.cert,
          rejectUnauthorized: true,
        });
        this.ws.binaryType = "arraybuffer";
        this.addEventListeners();
      } catch (error) {
        this.onError("WebSocket setup failed", error);
      }
    };
    transport.doClose = function () {
      this.ws?.terminate();
    };
    return transport;
  };

  cachedManager = Manager;
  return cachedManager;
}

export function legacySocket(url, options) {
  const target = new URL(url);
  const Manager = legacyManager();
  // Do not pass a URI or host option into the old URL-parser call sites. The
  // audited modern parseuri dependency is not API-compatible with those sites.
  const manager = new Manager({
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: target.port || (target.protocol === "https:" ? "443" : "80"),
    secure: target.protocol === "https:",
    path: options.path,
    query: options.query,
    extraHeaders: options.extraHeaders,
    ca: options.ca,
    key: options.key,
    cert: options.cert,
    rejectUnauthorized: true,
    transports:
      options.legacyTransport === "auto"
        ? ["polling", "websocket"]
        : [options.legacyTransport || "websocket"],
    upgrade: options.legacyTransport === "auto",
    transportOptions: { polling: { forceBase64: true } },
    reconnection: false,
    autoConnect: false,
    timeout: options.timeout,
    requestTimeout: options.timeout,
    perMessageDeflate: false,
  });
  const socket = manager.socket(target.pathname || "/");
  socket.on("error", (error) =>
    socket.emit(
      "connect_error",
      error instanceof Error ? error : Error(String(error)),
    ),
  );
  const listeners = [];
  socket.onAny = (fn) => {
    listeners.push(fn);
    return socket;
  };
  socket.offAny = (fn) => {
    if (fn === undefined) listeners.length = 0;
    else {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
    return socket;
  };
  socket.onevent = function (packet) {
    if (!this.connected) {
      this.emit(
        "connect_error",
        Error("Socket.IO v2 event before namespace connect"),
      );
      return;
    }
    const args = [...(packet.data || [])];
    if (packet.id !== null && packet.id !== undefined)
      args.push(this.ack(packet.id));
    for (const fn of [...listeners]) fn(...args);
  };
  socket.timeout = (milliseconds) => ({
    emit(event, ...args) {
      const callback = args.pop(),
        id = socket.ids;
      let settled = false;
      const finish = (error, ...values) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("disconnect", disconnected);
        delete socket.acks[id];
        callback(error, ...values);
      };
      const disconnected = () => finish(Error("Socket.IO v2 disconnected"));
      const timer = setTimeout(
        () => finish(Error("Socket.IO v2 acknowledgement timed out")),
        milliseconds,
      );
      socket.once("disconnect", disconnected);
      socket.emit(event, ...args, (...values) => finish(null, ...values));
    },
  });
  return socket;
}
