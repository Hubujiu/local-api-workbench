import { http2Connection } from "./http2-connection.mjs";
import {
  openProxyTunnel,
  proxyOptions,
  unbracketHost,
} from "./proxy-tunnel.mjs";
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
  if (request.auth?.type === "ntlm") {
    if (request.httpVersion !== "1.1") throw Error("NTLM仅支持HTTP/1.1");
    if (request.proxy) throw Error("NTLM暂不支持代理连接");
    const client = target.protocol === "https:" ? https : http;
    const agent = new client.Agent({
      keepAlive: true,
      maxSockets: 1,
      maxFreeSockets: 1,
    });
    return {
      client,
      url: target,
      options: { ...tlsOptions, agent },
      cleanup: () => agent.destroy(),
    };
  }
  if (request.httpVersion === "2") {
    const tunnel = request.proxy
      ? await openProxyTunnel(target, request, signal)
      : undefined;
    return http2Connection(target, request, tlsOptions, tunnel);
  }
  if (!request.proxy)
    return {
      client: target.protocol === "https:" ? https : http,
      url: target,
      options: tlsOptions,
      cleanup: () => {},
    };
  const proxy = proxyOptions(request);
  if (target.protocol === "http:")
    return {
      client: proxy.transport,
      url: proxy.proxy,
      options: {
        ...proxy.tlsOptions,
        path: target.href,
        headers: {
          ...headers,
          host: headers.host || target.host,
          ...proxy.headers,
        },
      },
      cleanup: () => {},
    };
  const socket = await openProxyTunnel(target, request, signal),
    agent = new https.Agent({ keepAlive: false });
  const host = unbracketHost(target.hostname);
  agent.createConnection = (options) =>
    tls.connect({
      ...options,
      ...tlsOptions,
      socket,
      host,
      servername: net.isIP(host) ? "" : host,
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
