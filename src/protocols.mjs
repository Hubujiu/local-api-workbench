import { boundedSSEParser, validSSEHandshake } from "./sse-parser.mjs";
import net from "node:net";

export async function captureSSE(
  { url, headers = {}, duration = 3000, maxEvents = 20 },
  signal,
) {
  signal?.throwIfAborted();
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
      headers: { Accept: "text/event-stream", ...headers },
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
  { host, port, message = "", duration = 3000 },
  signal,
) {
  if (!host || !Number.isInteger(Number(port)) || port < 1 || port > 65535)
    throw Error("TCP 地址或端口无效");
  if (Buffer.byteLength(message) > 1024 * 1024) throw Error("消息超过 1 MiB");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      done = false;
    const socket = net.connect({ host, port: Number(port) });
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ body: Buffer.concat(chunks).toString("utf8"), size });
    };
    const abort = () => finish(Error("TCP 请求已取消"));
    const timer = setTimeout(
      () => (chunks.length ? finish() : finish(Error("TCP 请求超时"))),
      Math.min(30000, Math.max(100, Number(duration) || 3000)),
    );
    socket.on("connect", () => socket.write(message));
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(Error("TCP 响应超过 1 MiB"));
      else chunks.push(chunk);
    });
    socket.on("end", () => finish());
    socket.on("error", finish);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function exchangeWebSocket(
  { url, message = "", protocols = [], duration = 3000, maxMessages = 20 },
  signal,
) {
  const target = new URL(url);
  if (!["ws:", "wss:"].includes(target.protocol))
    throw Error("必须使用 ws:// 或 wss://");
  if (Buffer.byteLength(message) > 1024 * 1024) throw Error("消息超过 1 MiB");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols),
      messages = [];
    let done = false,
      size = 0;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.close();
      if (error) reject(error);
      else resolve({ messages, protocol: socket.protocol });
    };
    const abort = () => finish(Error("WebSocket 已取消"));
    const timer = setTimeout(
      () => finish(),
      Math.min(30000, Math.max(100, Number(duration) || 3000)),
    );
    socket.addEventListener("open", () => {
      if (message) socket.send(message);
    });
    socket.addEventListener("message", async (event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(await event.data.arrayBuffer()).toString("base64");
      size += Buffer.byteLength(data);
      if (size > 1024 * 1024) return finish(Error("WebSocket 响应超过 1 MiB"));
      messages.push({ data, receivedAt: new Date().toISOString() });
      if (messages.length >= Math.min(100, Math.max(1, maxMessages))) finish();
    });
    socket.addEventListener("close", () => finish());
    socket.addEventListener("error", () => finish(Error("WebSocket 连接失败")));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
