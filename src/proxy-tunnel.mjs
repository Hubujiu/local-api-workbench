import http from "node:http";
import https from "node:https";
import net from "node:net";
export const unbracketHost = (host) => host.replace(/^\[|\]$/g, "");
export function proxyOptions(request) {
  const proxy = new URL(request.proxy);
  if (!["http:", "https:"].includes(proxy.protocol))
    throw Error("仅支持 HTTP/HTTPS 代理");
  const headers = {};
  if (proxy.username || proxy.password)
    headers["Proxy-Authorization"] =
      "Basic " +
      Buffer.from(
        decodeURIComponent(proxy.username) +
          ":" +
          decodeURIComponent(proxy.password),
      ).toString("base64");
  proxy.username = "";
  proxy.password = "";
  const host = unbracketHost(proxy.hostname);
  return {
    proxy,
    headers,
    transport: proxy.protocol === "https:" ? https : http,
    tlsOptions: {
      rejectUnauthorized: true,
      servername: net.isIP(host) ? "" : host,
      ...(request.tls?.proxyCa ? { ca: request.tls.proxyCa } : {}),
    },
  };
}
export async function openProxyTunnel(target, request, signal) {
  const { proxy, headers, transport, tlsOptions } = proxyOptions(request);
  const authority =
    target.hostname +
    ":" +
    (target.port || (target.protocol === "https:" ? "443" : "80"));
  return new Promise((resolve, reject) => {
    const connection = transport.request(proxy, {
      ...tlsOptions,
      method: "CONNECT",
      path: authority,
      headers: { Host: authority, ...headers },
      signal,
    });
    const timeout = setTimeout(
      () => connection.destroy(Error("代理连接超时")),
      request.timeout,
    );
    connection.once("connect", (response, socket, head) => {
      clearTimeout(timeout);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(Error("代理 CONNECT 失败: " + response.statusCode));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    connection.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    connection.end();
  });
}
