import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { executeRequest } from "../src/runtime.mjs";
import { readHttpRedirectFailure } from "../src/http-redirect.mjs";
const key = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const cert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
const redirect = { mode: "same-origin" };
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function fixture(t, h2, secureOrigin, secureProxy, useProxy = true) {
  const seen = [],
    proxySeen = [],
    sockets = new Set(),
    sessions = new Set();
  const handler = (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === "/first?q=1") {
      res.writeHead(307, { location: "/second?q=2" });
      res.end("hop");
    } else res.end("final");
  };
  const origin = h2
    ? secureOrigin
      ? http2.createSecureServer({ key, cert })
      : http2.createServer()
    : secureOrigin
      ? https.createServer({ key, cert }, handler)
      : http.createServer(handler);
  if (h2) {
    origin.on("session", (s) => {
      sessions.add(s);
      s.on("close", () => sessions.delete(s));
    });
    origin.on("stream", (stream, headers) => {
      seen.push({ url: headers[":path"], headers });
      stream.respond({
        ":status": headers[":path"] === "/first?q=1" ? 307 : 200,
        ...(headers[":path"] === "/first?q=1"
          ? { location: "/second?q=2" }
          : {}),
      });
      stream.end("final");
    });
  }
  const port = await listen(origin);
  const proxy = secureProxy
    ? https.createServer({ key, cert })
    : http.createServer();
  proxy.on("request", (req, res) => {
    proxySeen.push({ method: req.method, url: req.url, headers: req.headers });
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const upstream = http.request(
      req.url,
      { method: req.method, headers },
      (remote) => {
        res.writeHead(remote.statusCode, remote.headers);
        remote.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on("connect", (req, client, head) => {
    proxySeen.push({ method: "CONNECT", url: req.url, headers: req.headers });
    const upstream = net.connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    for (const s of sessions) s.destroy();
    for (const s of sockets) s.destroy();
    origin.closeAllConnections?.();
    proxy.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => origin.close(resolve)),
      new Promise((resolve) => proxy.close(resolve)),
    ]);
  });
  const input = {
    url: `${secureOrigin ? "https" : "http"}://127.0.0.1:${port}/first?q=1#fragment`,
    redirect,
    httpVersion: h2 ? "2" : "1.1",
    auth: { type: "bearer", token: "resource-token" },
    tls: { ca: cert, proxyCa: cert },
    ...(useProxy
      ? {
          proxy: `${secureProxy ? "https" : "http"}://fixture:password@127.0.0.1:${proxyPort}`,
        }
      : {}),
  };
  return { input, seen, proxySeen };
}
for (const h2 of [false, true])
  for (const secureOrigin of [false, true])
    for (const secureProxy of [false, true])
      test(`redirect ${h2 ? "H2" : "H1"} ${secureOrigin ? "TLS" : "HTTP"} origin through ${secureProxy ? "TLS" : "HTTP"} proxy recreates target and separates credentials`, async (t) => {
        const f = await fixture(t, h2, secureOrigin, secureProxy);
        const result = await executeRequest(f.input);
        assert.equal(result.status, 200);
        assert.deepEqual(
          f.seen.map((r) => r.url),
          ["/first?q=1", "/second?q=2"],
        );
        assert.equal(
          result.effectiveUrl,
          new URL("/second?q=2#fragment", f.input.url).href,
        );
        assert.equal(f.proxySeen.length, 2);
        for (const item of f.seen) {
          assert.equal(item.headers.authorization, "Bearer resource-token");
          assert.equal(item.headers["proxy-authorization"], undefined);
        }
        for (const item of f.proxySeen) {
          assert.match(item.headers["proxy-authorization"], /^Basic /);
          if (item.method === "CONNECT")
            assert.equal(item.headers.authorization, undefined);
          assert.ok(!item.url.includes("#"));
        }
      });
test("redirect direct verified HTTPS and H2 TLS do not disable certificate validation", async (t) => {
  for (const h2 of [false, true]) {
    const f = await fixture(t, h2, true, false, false);
    await assert.rejects(executeRequest({ ...f.input, tls: {} }), (error) => {
      const d = readHttpRedirectFailure(error);
      assert.equal(d.failure.reason, "transport");
      assert.equal(d.response, undefined);
      return true;
    });
    assert.equal(f.seen.length, 0);
    assert.equal((await executeRequest(f.input)).status, 200);
    assert.equal(f.seen.length, 2);
  }
});
