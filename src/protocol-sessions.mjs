import {
  boundedSSEParser,
  validSSEHandshake,
  sseEventText,
} from "./sse-parser.mjs";
import { randomUUID } from "node:crypto";
import net from "node:net";

/** Bounded interactive connections. No connection starts without a UI/API action. */
export class ProtocolSessions {
  constructor() {
    this.sessions = new Map();
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw Error("会话不存在或已过期");
    return session;
  }
  snapshot(id) {
    const { id: sessionId, type, state, events, createdAt } = this.get(id);
    return { id: sessionId, type, state, events, createdAt };
  }
  event(session, direction, data) {
    const text = String(data);
    session.bytes += Buffer.byteLength(text);
    if (session.bytes > 8 * 1024 * 1024) {
      this.stop(session.id);
      throw Error("会话数据超过 8 MiB");
    }
    session.events.push({
      id: randomUUID(),
      direction,
      data: text.slice(0, 100000),
      at: new Date().toISOString(),
    });
    session.events = session.events.slice(-200);
  }
  start(input) {
    if (this.sessions.size >= 50)
      for (const old of this.sessions.values()) {
        if (!["open", "connecting"].includes(old.state)) {
          this.stop(old.id);
          clearTimeout(old.expiry);
          this.sessions.delete(old.id);
          if (this.sessions.size < 50) break;
        }
      }
    if (this.sessions.size >= 50) throw Error("协议会话记录已达到上限");
    if (
      [...this.sessions.values()].filter(
        (s) => s.state === "open" || s.state === "connecting",
      ).length >= 5
    )
      throw Error("最多同时打开 5 个连接");
    const type = input.type;
    if (!["websocket", "tcp", "sse"].includes(type)) throw Error("协议无效");
    const session = {
      id: randomUUID(),
      type,
      state: "connecting",
      events: [],
      bytes: 0,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    session.deadline = setTimeout(() => this.stop(session.id), 15 * 60 * 1000);
    session.expiry = setTimeout(
      () => {
        this.stop(session.id);
        this.sessions.delete(session.id);
      },
      60 * 60 * 1000,
    );
    const failed = (error) => {
      if (session.state === "closed") return;
      session.state = "error";
      try {
        this.event(session, "error", error.message || error);
      } catch {}
      session.socket?.destroy?.();
      session.socket?.close?.();
      session.controller?.abort();
      clearTimeout(session.deadline);
    };
    try {
      if (type === "websocket") {
        if (!["ws:", "wss:"].includes(new URL(input.url).protocol))
          throw Error("必须使用 ws:// 或 wss://");
        const socket = new WebSocket(input.url, input.protocols || []);
        session.socket = socket;
        socket.addEventListener("open", () => {
          session.state = "open";
        });
        socket.addEventListener("message", async (event) => {
          try {
            this.event(
              session,
              "received",
              typeof event.data === "string"
                ? event.data
                : Buffer.from(await event.data.arrayBuffer()).toString(
                    "base64",
                  ),
            );
          } catch (error) {
            failed(error);
          }
        });
        socket.addEventListener("error", () =>
          failed(Error("WebSocket 连接失败")),
        );
        socket.addEventListener("close", () => {
          if (session.state !== "error") session.state = "closed";
          clearTimeout(session.deadline);
        });
      } else if (type === "tcp") {
        const port = Number(input.port);
        if (!input.host || !Number.isInteger(port) || port < 1 || port > 65535)
          throw Error("TCP 地址无效");
        const socket = net.connect({ host: input.host, port });
        session.socket = socket;
        socket.setTimeout(15000, () => {
          if (session.state === "connecting") failed(Error("TCP 连接超时"));
        });
        socket.on("connect", () => {
          session.state = "open";
          socket.setTimeout(0);
        });
        socket.on("data", (data) => {
          try {
            this.event(session, "received", data.toString("utf8"));
          } catch (error) {
            failed(error);
          }
        });
        socket.on("error", failed);
        socket.on("close", () => {
          if (session.state !== "error") session.state = "closed";
          clearTimeout(session.deadline);
        });
      } else {
        if (!["http:", "https:"].includes(new URL(input.url).protocol))
          throw Error("SSE 仅支持 HTTP/HTTPS");
        session.controller = new AbortController();
        (async () => {
          const response = await fetch(input.url, {
            headers: { Accept: "text/event-stream", ...(input.headers || {}) },
            signal: session.controller.signal,
            redirect: "manual",
          });
          if (!validSSEHandshake(response))
            throw Error("SSE 握手失败: " + response.status);
          session.state = "open";
          const parser = boundedSSEParser(
            (event) => {
              const text = sseEventText(event);
              this.event(session, "received", text);
              const recorded = session.events.at(-1);
              recorded.sse = {
                event: event.event,
                id: event.id,
                ...(event.retry !== undefined ? { retry: event.retry } : {}),
              };
              recorded.truncated = text.length > 100000;
            },
            { maxWireBytes: 8 * 1024 * 1024 },
          );
          for await (const chunk of response.body) parser.feed(chunk);
          parser.finish();
          this.stop(session.id);
        })().catch(failed);
      }
    } catch (error) {
      failed(error);
    }
    return this.snapshot(session.id);
  }
  send(id, message) {
    const session = this.get(id);
    if (session.state !== "open" || session.type === "sse")
      throw Error("当前会话不可发送消息");
    if (typeof message !== "string" || Buffer.byteLength(message) > 1024 * 1024)
      throw Error("消息超过 1 MiB");
    if (session.type === "websocket") session.socket.send(message);
    else session.socket.write(message);
    this.event(session, "sent", message);
    return this.snapshot(id);
  }
  stop(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.state = "closed";
    clearTimeout(session.deadline);
    session.socket?.destroy?.();
    session.socket?.close?.();
    session.controller?.abort();
  }
  close() {
    for (const session of this.sessions.values()) {
      this.stop(session.id);
      clearTimeout(session.expiry);
    }
    this.sessions.clear();
  }
}
