import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { executeRequest } from "../src/runtime.mjs";
const key = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const cert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
async function fixture(t, secureTarget, secureProxy, mutual = false) {
  const target = secureTarget
      ? http2.createSecureServer({
          key,
          cert,
          ...(mutual
            ? { requestCert: true, rejectUnauthorized: true, ca: cert }
            : {}),
        })
      : http2.createServer(),
    sessions = new Set(),
    sockets = new Set(),
    seen = {};
  target.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  target.on("stream", (stream, headers) => {
    seen.origin = headers;
    seen.clientAuthorized = stream.session.socket.authorized;
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end(
        JSON.stringify({
          method: headers[":method"],
          path: headers[":path"],
          body,
        }),
      );
    });
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const proxy = secureProxy
    ? https.createServer({ key, cert })
    : http.createServer();
  proxy.on("connect", (request, client, head) => {
    seen.connect = { url: request.url, headers: request.headers };
    const upstream = net.connect(target.address().port, "127.0.0.1", () => {
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
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ]);
  });
  return {
    url:
      (secureTarget ? "https" : "http") +
      "://127.0.0.1:" +
      target.address().port +
      "/h2?x=1",
    proxy:
      (secureProxy ? "https" : "http") +
      "://fixture:password@127.0.0.1:" +
      proxy.address().port,
    seen,
  };
}
for (const secureTarget of [false, true])
  for (const secureProxy of [false, true])
    test(`HTTP2 ${secureTarget ? "TLS" : "cleartext"} through ${secureProxy ? "TLS" : "plain"} CONNECT proxy preserves protocol and separates credentials`, async (t) => {
      const f = await fixture(t, secureTarget, secureProxy);
      const result = await executeRequest({
        url: f.url,
        proxy: f.proxy,
        httpVersion: "2",
        method: "POST",
        bodyType: "json",
        body: '{"value":7}',
        auth: { type: "bearer", token: "origin-token" },
        tls: { ca: cert, proxyCa: cert },
      });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).body, '{"value":7}');
      assert.equal(JSON.parse(result.body).path, "/h2?x=1");
      assert.match(f.seen.connect.headers["proxy-authorization"], /^Basic /);
      assert.equal(f.seen.origin["proxy-authorization"], undefined);
      assert.equal(f.seen.connect.headers.authorization, undefined);
      assert.equal(f.seen.origin.authorization, "Bearer origin-token");
      assert.equal(f.seen.origin[":method"], "POST");
    });
test("HTTP2 proxy and origin trust stay independent and target hostname is checked inside the tunnel", async (t) => {
  const f = await fixture(t, true, true);
  await assert.rejects(
    executeRequest({
      url: f.url,
      proxy: f.proxy,
      httpVersion: "2",
      tls: { ca: cert },
    }),
    /certificate|self.signed/i,
  );
  await assert.rejects(
    executeRequest({
      url: f.url,
      proxy: f.proxy,
      httpVersion: "2",
      tls: { proxyCa: cert },
    }),
    /certificate|self.signed/i,
  );
  await assert.rejects(
    executeRequest({
      url: f.url.replace("127.0.0.1", "wrong-host.invalid"),
      proxy: f.proxy,
      httpVersion: "2",
      tls: { ca: cert, proxyCa: cert },
    }),
    /altname|hostname|not.*cert/i,
  );
});

test(
  "HTTP2 CONNECT honors timeout and cancellation before origin traffic",
  { timeout: 5000 },
  async (t) => {
    const sockets = new Set(),
      proxy = http.createServer();
    let notify;
    proxy.on("connect", (_request, socket) => {
      sockets.add(socket);
      notify?.();
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      proxy.close();
    });
    const input = {
      url: "http://example.invalid/h2",
      proxy: "http://127.0.0.1:" + proxy.address().port,
      httpVersion: "2",
      timeout: 100,
    };
    await assert.rejects(executeRequest(input), /超时/);
    const controller = new AbortController(),
      seen = new Promise((resolve) => {
        notify = resolve;
      });
    const pending = executeRequest(
      { ...input, timeout: 1500 },
      controller.signal,
    );
    pending.catch(() => {});
    await seen;
    controller.abort();
    await assert.rejects(pending, /abort/i);
  },
);
test("cURL protocol export uses strict HTTP2 and retains tunnel semantics on import", async () => {
  const { toCurl, importCurl } = await import("../src/core.mjs");
  const command = toCurl({
    url: "http://localhost/path[1]",
    httpVersion: "2",
    proxy: "http://user:pass@localhost:8888",
    method: "POST",
    bodyType: "json",
    body: '{"ok":true}',
  });
  assert.match(command, /--http2-prior-knowledge/);
  assert.match(command, /^curl --disable /);
  assert.match(command, /--globoff/);
  assert.throws(
    () => importCurl("curl --http1.1 --disable http://one.invalid"),
    /首位/,
  );
  assert.match(command, /--proxytunnel/);
  const restored = importCurl(command);
  assert.equal(restored.httpVersion, "2");
  assert.equal(restored.proxy, "http://user:pass@localhost:8888");
  assert.equal(restored.url, "http://localhost/path[1]");
  assert.match(toCurl({ url: "https://localhost" }), /--http1\.1/);
  assert.throws(
    () => importCurl("curl http://one.invalid http://two.invalid"),
    /多个/,
  );
});

test("HTTP2 origin client certificates remain usable through a CONNECT tunnel", async (t) => {
  const f = await fixture(t, true, false, true);
  await assert.rejects(
    executeRequest({
      url: f.url,
      proxy: f.proxy,
      httpVersion: "2",
      tls: { ca: cert },
    }),
    /certificate|alert|cancel|closed/i,
  );
  assert.equal(f.seen.origin, undefined);
  const result = await executeRequest({
    url: f.url,
    proxy: f.proxy,
    httpVersion: "2",
    tls: { ca: cert, cert, key },
  });
  assert.equal(result.status, 200);
  assert.equal(f.seen.clientAuthorized, true);
});
