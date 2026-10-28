import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { unbracketHost } from "./proxy-tunnel.mjs";
export function http2Connection(target, request, tlsOptions, tunnel) {
  let session, transportSocket;
  return {
    url: target,
    options: {},
    cleanup: () => {
      session?.destroy();
      transportSocket?.destroy();
      tunnel?.destroy();
    },
    client: {
      request(url, options, callback) {
        const headers = { ...options.headers };
        const authority = headers.host || target.host;
        delete headers.host;
        for (const name of Object.keys(headers))
          if (name.startsWith(":"))
            throw Error("请使用URL和方法字段设置HTTP/2伪头");
        const host = unbracketHost(target.hostname);
        if (tunnel)
          transportSocket =
            target.protocol === "https:"
              ? tls.connect({
                  ...tlsOptions,
                  socket: tunnel,
                  host,
                  servername: net.isIP(host) ? "" : host,
                  ALPNProtocols: ["h2"],
                })
              : tunnel;
        session = http2.connect(target.origin, {
          ...tlsOptions,
          servername: net.isIP(host) ? undefined : host,
          ...(transportSocket
            ? { createConnection: () => transportSocket }
            : {}),
        });
        let stream,
          responded = false;
        session.on("error", (error) => stream?.destroy(error));
        try {
          stream = session.request(
            {
              ...headers,
              ":method": options.method,
              ":path": options.path ?? target.pathname + target.search,
              ":authority": authority,
            },
            { endStream: false, signal: options.signal },
          );
        } catch (error) {
          session.destroy();
          throw error;
        }
        stream.once("response", (responseHeaders, _flags, rawHeaders) => {
          stream.rawHeaders = rawHeaders || [];
          responded = true;
          stream.statusCode = Number(responseHeaders[":status"]);
          stream.statusMessage = "";
          stream.httpVersion = "2.0";
          stream.headers = Object.fromEntries(
            Object.entries(responseHeaders).filter(
              ([key]) => !key.startsWith(":"),
            ),
          );
          callback(stream);
        });
        stream.once("close", () => {
          if (!responded)
            stream.emit("error", Error("HTTP/2连接在返回响应前关闭"));
        });
        return stream;
      },
    },
  };
}
