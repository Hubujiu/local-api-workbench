import { http2Connection } from "./http2-connection.mjs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";

export async function prepareConnection(target, request, headers, signal) {
  const certificates = request.tls || {};
  const tlsOptions = {
    rejectUnauthorized: true,
    ...(certificates.ca ? { ca: certificates.ca } : {}),
    ...(certificates.cert ? { cert: certificates.cert } : {}),
    ...(certificates.key ? { key: certificates.key } : {}),
    ...(certificates.passphrase ? { passphrase: certificates.passphrase } : {}),
  };
  if (request.httpVersion === "2")
    return http2Connection(target, request, tlsOptions);
  if (!request.proxy)
    return {
      client: target.protocol === "https:" ? https : http,
      url: target,
      options: tlsOptions,
      cleanup: () => {},
    };
  const proxy = new URL(request.proxy);
  if (!["http:", "https:"].includes(proxy.protocol))
    throw Error("仅支持 HTTP/HTTPS 代理");
  const proxyHeaders = {};
  if (proxy.username || proxy.password)
    proxyHeaders["Proxy-Authorization"] =
      "Basic " +
      Buffer.from(
        decodeURIComponent(proxy.username) +
          ":" +
          decodeURIComponent(proxy.password),
      ).toString("base64");
  proxy.username = "";
  proxy.password = "";
  const transport = proxy.protocol === "https:" ? https : http;
  if (target.protocol === "http:")
    return {
      client: transport,
      url: proxy,
      options: {
        path: target.href,
        headers: {
          ...headers,
          host: headers.host || target.host,
          ...proxyHeaders,
        },
      },
      cleanup: () => {},
    };
  const authority = target.hostname + ":" + (target.port || "443");
  const socket = await new Promise((resolve, reject) => {
    const connection = transport.request(proxy, {
      method: "CONNECT",
      path: authority,
      headers: { Host: authority, ...proxyHeaders },
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
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options) =>
    tls.connect({
      ...options,
      ...tlsOptions,
      socket,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
    });
  return {
    client: https,
    url: target,
    options: { ...tlsOptions, agent },
    cleanup: () => {
      agent.destroy();
      socket.destroy();
    },
  };
}
