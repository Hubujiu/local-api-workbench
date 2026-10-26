import { sseHeaders } from "./protocol-handshake.mjs";
import { protocolRequestOptions } from "./protocol-request-options.mjs";
import { protocolPayload } from "./protocol-payload.mjs";
import { openWebSocket } from "./websocket-client.mjs";
import { boundedSSEParser, validSSEHandshake } from "./sse-parser.mjs";
import net from "node:net";

export async function captureSSE(
  { url, headers = {}, duration = 3000, maxEvents = 20, method, body },
  signal,
) {
  signal?.throwIfAborted();
  const options = protocolRequestOptions({ type: "sse", method, body });
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol))
    throw Error("SSE 仅支持 HTTP/HTTPS");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(30000, Math.max(100, Number(duration) || 3000)),
  );
  const events = [];
  let status = 0,
    timedOut = false;
  try {
    const response = await fetch(target, {
      ...options,
      headers: sseHeaders(headers),
      signal: controller.signal,
      redirect: "manual",
    });
    status = response.status;
    if (!validSSEHandshake(response))
      throw Error("SSE 握手失败: " + response.status);
    const limit = Number.isFinite(Number(maxEvents))
      ? Math.min(100, Math.max(1, Math.floor(Number(maxEvents))))
      : 20;
    const reached = Symbol("SSE event limit");
    const parser = boundedSSEParser((event) => {
      events.push({ ...event, receivedAt: new Date().toISOString() });
      if (events.length >= limit) throw reached;
    });
    try {
      for await (const chunk of response.body) parser.feed(chunk);
      parser.finish();
    } catch (error) {
      if (error === reached) return { status, events, limited: true };
      throw error;
    }
  } catch (e) {
    if (controller.signal.aborted && !signal?.aborted) timedOut = true;
    else throw e;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    signal?.removeEventListener("abort", abort);
  }
  return { status, events, timedOut, cancelled: signal?.aborted || false };
}

export function exchangeTCP(
  { host, port, message = "", duration = 3000, completion },
  signal,
) {
  if (!host || !Number.isInteger(Number(port)) || port < 1 || port > 65535)
    throw Error("TCP 地址或端口无效");
  if (signal?.aborted) return Promise.reject(Error("TCP 请求已取消"));
  protocolRequestOptions({ type: "tcp", completion });
  const payload = protocolPayload(message);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      done = false,
      timedOut = false;
    const socket = net.connect({ host, port: Number(port) });
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        const buffer = Buffer.concat(chunks);
        let decoded, decodeError;
        if (payload.decode) {
          try {
            decoded = payload.decode(buffer);
          } catch (error) {
            decodeError = error.message;
          }
        }
        resolve({
          ...(decoded ? { decoded } : {}),
          ...(decodeError ? { decodeError } : {}),
          body: buffer.toString("utf8"),
          base64: buffer.toString("base64"),
          size,
          timedOut,
          partial: timedOut,
        });
      }
    };
    const abort = () => finish(Error("TCP 请求已取消"));
    const timer = setTimeout(
      () => {
        timedOut = true;
        chunks.length ? finish() : finish(Error("TCP 请求超时"));
      },
      Math.min(30000, Math.max(100, Number(duration) || 3000)),
    );
    socket.on("connect", () => {
      if (!done) socket.write(payload.buffer);
    });
    socket.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > 1024 * 1024) finish(Error("TCP 响应超过 1 MiB"));
      else {
        chunks.push(chunk);
        if (completion === "first-data") finish();
      }
    });
    socket.on("end", () => finish());
    socket.on("error", finish);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function exchangeWebSocket(input, signal) {
  const { message = "", duration = 3000, maxMessages = 20 } = input;
  if (signal?.aborted) return Promise.reject(Error("WebSocket 已取消"));
  const payload = protocolPayload(message),
    socket = openWebSocket(input);
  return new Promise((resolve, reject) => {
    const messages = [];
    let done = false,
      size = 0,
      timedOut = false,
      limited = false,
      closeCode,
      closeReason;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.terminate();
      if (error) reject(error);
      else
        resolve({
          messages,
          protocol: socket.protocol,
          timedOut,
          limited,
          ...(closeCode !== undefined ? { closeCode, closeReason } : {}),
        });
    };
    const abort = () => finish(Error("WebSocket 已取消"));
    const timer = setTimeout(
      () => {
        timedOut = true;
        finish();
      },
      Math.min(30000, Math.max(100, Number(duration) || 3000)),
    );
    const limit = Number.isFinite(Number(maxMessages))
      ? Math.min(100, Math.max(1, Math.floor(Number(maxMessages))))
      : 20;
    socket.once("open", () => {
      if (done) return;
      if (
        payload.buffer.length ||
        typeof message !== "string" ||
        input.templateMode === "literal"
      )
        socket.send(payload.buffer, { binary: payload.binary }, (error) => {
          if (error) finish(error);
        });
    });
    socket.on("message", (buffer, binary) => {
      if (done) return;
      const data = buffer.toString(binary ? "base64" : "utf8");
      size += Buffer.byteLength(data);
      if (size > 1024 * 1024) return finish(Error("WebSocket 响应超过 1 MiB"));
      messages.push({
        data,
        encoding: binary ? "base64" : "utf8",
        receivedAt: new Date().toISOString(),
      });
      if (messages.length >= limit) {
        limited = true;
        finish();
      }
    });
    socket.once("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString("utf8");
      finish();
    });
    socket.on("error", (error) =>
      finish(Error("WebSocket 连接或消息失败: " + error.message)),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}
