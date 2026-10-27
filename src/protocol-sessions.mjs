import { sseHeaders } from "./protocol-handshake.mjs";
import {
  resolveProtocolText,
  validateProtocolTemplate,
} from "./protocol-text-templates.mjs";
import { protocolRequestOptions } from "./protocol-request-options.mjs";
import { recordSaveFailure } from "./execution-evidence.mjs";

import { StringDecoder } from "node:string_decoder";
import { protocolPayload } from "./protocol-payload.mjs";
import { openWebSocket } from "./websocket-client.mjs";
import {
  boundedSSEParser,
  validSSEHandshake,
  sseEventText,
} from "./sse-parser.mjs";
import { randomUUID, createHash } from "node:crypto";
import net from "node:net";

/** Bounded interactive connections. No connection starts without a UI/API action. */
export class ProtocolSessions {
  constructor({ onFinish } = {}) {
    this.onFinish = onFinish;
    this.sessions = new Map();
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw Error("会话不存在或已过期");
    return session;
  }
  snapshot(id) {
    const session = this.get(id);
    return structuredClone({
      id: session.id,
      type: session.type,
      state: session.state,
      events: session.events,
      createdAt: session.createdAt,
      finishedAt: session.finishedAt,
      closeReason: session.closeReason,
      totalEvents: session.totalEvents,
      droppedEvents: Math.max(0, session.totalEvents - session.events.length),
      dataBytes: session.bytes,
      overflow: session.overflow === true,
      ...(session.error ? { error: session.error } : {}),
    });
  }
  finish(session, reason) {
    delete session.templateContext;
    if (!session.finishedAt) {
      session.finishedAt = new Date().toISOString();
      session.closeReason = reason;
      session.finalSnapshot = this.snapshot(session.id);
      // A persistence observer must never interrupt socket cleanup or surface
      // as an unhandled transport rejection. Production observer also handles
      // its own errors, while these guards cover synchronous hook failures.
      try {
        const pending = this.onFinish?.(session);
        if (pending?.catch)
          session.recordPromise = pending.catch((error) => {
            session.receipt = recordSaveFailure(
              session.projectId,
              session.finalRecord?.id ?? null,
              error,
            );
            session.recordPending = false;
            return session.receipt;
          });
      } catch (error) {
        session.receipt = recordSaveFailure(
          session.projectId,
          session.finalRecord?.id ?? null,
          error,
        );
        session.recordPending = false;
        session.recordPromise = Promise.resolve(session.receipt);
      }
    }
    clearTimeout(session.deadline);
  }
  event(session, direction, data) {
    const text = String(data).toWellFormed(),
      bytes = Buffer.byteLength(text);
    if (session.bytes + bytes > 8 * 1024 * 1024) {
      session.overflow = true;
      throw Error("会话数据超过 8 MiB");
    }
    session.bytes += bytes;
    session.totalEvents++;
    let preview = text.slice(0, 100000);
    const last = preview.charCodeAt(preview.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) preview = preview.slice(0, -1);
    session.events.push({
      id: randomUUID(),
      direction,
      data: preview,
      dataBytes: bytes,
      dataHash: createHash("sha256").update(text).digest("hex"),
      truncated: text.length > 100000,
      at: new Date().toISOString(),
    });
    session.events = session.events.slice(-200);
  }
  discard(session) {
    if (session.projectId && !session.recordSaved) return false;
    clearTimeout(session.expiry);
    this.sessions.delete(session.id);
    return true;
  }
  start(
    input,
    { templateContext, templateProvenance, projectId, definition } = {},
  ) {
    if (this.closing) throw Error("协议会话管理器正在关闭");
    if (input.templateMode === "variables")
      throw Error("协议模板会话须由项目入口解析");
    validateProtocolTemplate(input);
    if (this.sessions.size >= 50)
      for (const old of this.sessions.values()) {
        if (!["open", "connecting"].includes(old.state)) {
          this.stop(old.id);
          this.discard(old);
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
      totalEvents: 0,
      createdAt: new Date().toISOString(),
      ...(templateContext ? { templateContext } : {}),
      ...(projectId
        ? { projectId, definition: structuredClone(definition) }
        : {}),
      ...(templateProvenance
        ? { templateProvenance: structuredClone(templateProvenance) }
        : {}),
    };
    this.sessions.set(session.id, session);
    session.deadline = setTimeout(
      () => this.stop(session.id, "deadline"),
      15 * 60 * 1000,
    );
    session.expiry = setTimeout(
      () => {
        this.stop(session.id);
        this.discard(session);
      },
      60 * 60 * 1000,
    );
    const failed = (error) => {
      if (session.finishedAt || session.state === "closed") return;
      session.state = "error";
      session.error = String(error.message || error).slice(0, 1000);
      try {
        this.event(session, "error", error.message || error);
      } catch {}
      session.socket?.destroy?.();
      session.socket?.terminate?.();
      session.socket?.close?.();
      session.controller?.abort();
      this.finish(session, "error");
    };
    try {
      if (type === "websocket") {
        const socket = openWebSocket(input);
        session.socket = socket;
        socket.once("open", () => {
          if (session.state !== "connecting") {
            socket.terminate();
            return;
          }
          session.state = "open";
        });
        socket.on("message", (buffer, binary) => {
          if (session.state !== "open") return;
          try {
            this.event(
              session,
              "received",
              buffer.toString(binary ? "base64" : "utf8"),
            );
            session.events.at(-1).encoding = binary ? "base64" : "utf8";
          } catch (error) {
            failed(error);
          }
        });
        socket.on("error", (error) =>
          failed(Error("WebSocket 连接或消息失败: " + error.message)),
        );
        socket.once("close", () => {
          if (session.state !== "error") session.state = "closed";
          this.finish(session, session.state === "error" ? "error" : "remote");
          session.socket = null;
        });
      } else if (type === "tcp") {
        const receiveEncoding = input.receiveEncoding ?? "utf8";
        if (!["utf8", "hex", "base64"].includes(receiveEncoding))
          throw Error("TCP 接收编码无效");
        const decoder = new StringDecoder("utf8");
        const port = Number(input.port);
        if (!input.host || !Number.isInteger(port) || port < 1 || port > 65535)
          throw Error("TCP 地址无效");
        const socket = net.connect({ host: input.host, port });
        session.socket = socket;
        socket.setTimeout(15000, () => {
          if (session.state === "connecting") failed(Error("TCP 连接超时"));
        });
        socket.on("connect", () => {
          if (session.state !== "connecting") {
            socket.destroy();
            return;
          }
          session.state = "open";
          socket.setTimeout(0);
        });
        socket.on("data", (data) => {
          try {
            if (session.state !== "open") return;
            const text =
              receiveEncoding === "utf8"
                ? decoder.write(data)
                : data.toString(receiveEncoding);
            if (text) {
              this.event(session, "received", text);
              session.events.at(-1).encoding = receiveEncoding;
            }
          } catch (error) {
            failed(error);
          }
        });
        socket.on("end", () => {
          if (receiveEncoding === "utf8" && session.state === "open") {
            try {
              const text = decoder.end();
              if (text) {
                this.event(session, "received", text);
                session.events.at(-1).encoding = "utf8";
              }
            } catch (error) {
              failed(error);
            }
          }
        });
        socket.on("error", failed);
        socket.on("close", () => {
          if (session.state !== "error") session.state = "closed";
          this.finish(session, session.state === "error" ? "error" : "remote");
          session.socket = null;
        });
      } else {
        if (!["http:", "https:"].includes(new URL(input.url).protocol))
          throw Error("SSE 仅支持 HTTP/HTTPS");
        const options = protocolRequestOptions({ ...input, type: "sse" });
        session.controller = new AbortController();
        (async () => {
          const response = await fetch(input.url, {
            ...options,
            headers: sseHeaders(input.headers),
            signal: session.controller.signal,
            redirect: "manual",
          });
          if (!validSSEHandshake(response))
            throw Error("SSE 握手失败: " + response.status);
          if (session.state !== "connecting") {
            session.controller.abort();
            return;
          }
          session.state = "open";
          const parser = boundedSSEParser(
            (event) => {
              if (session.state !== "open") return;
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
          this.stop(session.id, "remote");
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
    const context = session.templateContext;
    message =
      message !== undefined
        ? message
        : ((context ? context.defaultMessage : session.definition?.message) ??
          "");
    if (context) message = resolveProtocolText(message, context.variables);
    else if (session.definition?.templateMode === "literal")
      validateProtocolTemplate(session.definition, message);
    const payload = protocolPayload(message);
    this.event(
      session,
      "sent",
      payload.buffer.toString(payload.binary ? "base64" : "utf8"),
    );
    const recorded = session.events.at(-1);
    recorded.encoding = payload.binary ? "base64" : "utf8";
    recorded.sendState = "queued";
    const complete = (error) => {
      if (session.state !== "open") return;
      recorded.sendState = error ? "failed" : "written";
      if (error) {
        session.state = "error";
        session.error = "协议发送失败，远端结果未确认，不会自动重试";
        session.socket?.destroy?.();
        session.socket?.terminate?.();
        this.finish(session, "error");
      }
    };
    if (session.type === "websocket")
      session.socket.send(payload.buffer, { binary: payload.binary }, complete);
    else session.socket.write(payload.buffer, complete);
    return this.snapshot(id);
  }
  stop(id, reason = "manual") {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.state !== "error") session.state = "closed";
    this.finish(session, session.state === "error" ? "error" : reason);
    session.socket?.destroy?.();
    session.socket?.terminate?.();
    session.socket?.close?.();
    session.socket = null;
    session.controller?.abort();
  }
  async close() {
    this.closing = true;
    for (const session of this.sessions.values()) {
      this.stop(session.id);
      clearTimeout(session.expiry);
    }
    await Promise.all(
      [...this.sessions.values()].map((session) => session.recordPromise),
    );
    const receipts = [...this.sessions.values()]
      .filter((session) => session.projectId)
      .map((session) => ({
        projectId: session.projectId,
        sessionId: session.id,
        ...structuredClone(
          session.receipt ||
            recordSaveFailure(
              session.projectId,
              session.finalRecord?.id ?? null,
              Error("保存未确认"),
            ),
        ),
      }));
    // Retain failed receipts for callers inspecting graceful shutdown.
    for (const session of this.sessions.values()) this.discard(session);
    return receipts;
  }
}
