import http from "node:http";
import https from "node:https";
import { Fetch, NodeWebSocket } from "engine.io-client";
import { checkedEngineIOPacket } from "./socketio-handshake.mjs";
const MAX_BYTES = 1024 * 1024;
const active = new Set();
export const boundedPollingUsage = () => ({ active: active.size, limit: 20 });
// Keep Engine.IO's framing, handshake, polling and upgrade state machine.
// Replace only the unbounded HTTP body acquisition used by the default transport.
export class BoundedPolling extends Fetch {
  constructor(options) {
    super(options);
    this.requests = new Map();
    this.closing = false;
  }
  async _fetch(data) {
    const post = data !== undefined,
      closing = post && this.closing;
    if (this.readyState === "closed" && !closing)
      return Promise.reject(Error("Socket.IO polling transport closed"));
    if (active.size >= 20)
      return Promise.reject(Error("Socket.IO polling请求达到20项上限"));
    if (
      post &&
      (typeof data !== "string" || Buffer.byteLength(data) > MAX_BYTES)
    )
      return Promise.reject(Error("Socket.IO polling请求超过1MiB"));
    const uri = this.uri();
    if (uri.length > 16384) throw Error("Socket.IO polling请求地址超过16KiB");
    const target = new URL(uri);
    const headers = Object.fromEntries(
      Object.entries(this.opts.extraHeaders || {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    headers["accept-encoding"] = "identity";
    headers.accept = "*/*";
    delete headers["transfer-encoding"];
    delete headers["content-length"];
    if (post) {
      headers["content-type"] = "text/plain;charset=UTF-8";
      headers["content-length"] = String(Buffer.byteLength(data));
    }
    return new Promise((resolve, reject) => {
      let settled = false,
        timer,
        request;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(request);
        this.requests.delete(request);
        error ? reject(error) : resolve(response);
      };
      try {
        request = (target.protocol === "https:" ? https : http).request(
          target,
          {
            method: post ? "POST" : "GET",
            headers,
            agent: false,
            maxHeaderSize: 16384,
            rejectUnauthorized: true,
            ...Object.fromEntries(
              ["ca", "key", "cert"]
                .filter((k) => this.opts[k] !== undefined)
                .map((k) => [k, this.opts[k]]),
            ),
          },
          (response) => {
            const fail = (error) => {
              finish(error);
              response.destroy();
              request.destroy();
            };
            const status = response.statusCode || 0;
            if (status < 200 || status >= 300)
              return fail(Error("Socket.IO polling HTTP " + status));
            const encoding = response.headers["content-encoding"];
            if (encoding && String(encoding).toLowerCase() !== "identity")
              return fail(Error("Socket.IO polling拒绝未经协商的压缩响应"));
            const length = response.headers["content-length"];
            if (
              length !== undefined &&
              (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)
            )
              return fail(Error("Socket.IO polling响应超过1MiB"));
            const chunks = [];
            let bytes = 0;
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > MAX_BYTES) {
                fail(Error("Socket.IO polling响应超过1MiB"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("aborted", () =>
              finish(Error("Socket.IO polling响应中断")),
            );
            response.on("error", (error) => finish(error));
            response.on("end", () => {
              if (settled) return;
              try {
                const text = new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(chunks),
                );
                finish(
                  null,
                  new Response([204, 205].includes(status) ? null : text, {
                    status,
                    headers: { "content-type": "text/plain;charset=UTF-8" },
                  }),
                );
              } catch (error) {
                fail(error);
              }
            });
          },
        );
        active.add(request);
        this.requests.set(request, closing);
        request.on("error", (error) => finish(error));
        request.on("close", () => {
          if (!settled) finish(Error("Socket.IO polling请求已关闭"));
        });
        request.on("upgrade", (_response, socket) => {
          socket.destroy();
          finish(Error("Socket.IO polling拒绝意外协议升级"));
          request.destroy();
        });
        timer = setTimeout(
          () => request.destroy(Error("Socket.IO polling请求超时")),
          closing ? 2000 : 30000,
        );
        timer.unref?.();
        request.end(post ? data : undefined);
      } catch (error) {
        finish(error);
        request?.destroy();
      }
    });
  }
  onPacket(packet) {
    let checked;
    try {
      checked = checkedEngineIOPacket(packet, this.socket?.id);
    } catch (error) {
      this.onError("Invalid Engine.IO handshake", error);
      return;
    }
    super.onPacket(checked);
  }
  doClose() {
    this.closing = true;
    super.doClose();
  }
  onClose(details) {
    for (const [request, closing] of this.requests)
      if (!closing)
        request.destroy(Error("Socket.IO polling transport closed"));
    super.onClose(details);
  }
  onData(data) {
    if (this.readyState !== "closed") super.onData(data);
  }
}

export class BoundedWebSocket extends NodeWebSocket {
  onPacket(packet) {
    let checked;
    try {
      checked = checkedEngineIOPacket(packet, this.socket?.id);
    } catch (error) {
      this.onError("Invalid Engine.IO handshake", error);
      return;
    }
    super.onPacket(checked);
  }
}
