import http2 from "node:http2";
import net from "node:net";
export function http2Connection(target, request, tlsOptions) {
  if (request.proxy)
    throw Error("HTTP/2模式暂不支持代理，请改用直连或HTTP/1.1");
  let session;
  return {
    url: target,
    options: {},
    cleanup: () => session?.destroy(),
    client: {
      request(url, options, callback) {
        const headers = { ...options.headers };
        const authority = headers.host || target.host;
        delete headers.host;
        for (const name of Object.keys(headers))
          if (name.startsWith(":"))
            throw Error("请使用URL和方法字段设置HTTP/2伪头");
        session = http2.connect(target.origin, {
          ...tlsOptions,
          servername: net.isIP(target.hostname) ? undefined : target.hostname,
        });
        let stream,
          responded = false;
        session.on("error", (error) => stream?.destroy(error));
        try {
          stream = session.request(
            {
              ...headers,
              ":method": options.method,
              ":path": target.pathname + target.search,
              ":authority": authority,
            },
            { endStream: false, signal: options.signal },
          );
        } catch (error) {
          session.destroy();
          throw error;
        }
        stream.once("response", (responseHeaders) => {
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
