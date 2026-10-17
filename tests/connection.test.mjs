import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { executeRequest } from "../src/runtime.mjs";
const key = await readFile(
    new URL("./fixtures/localhost.key", import.meta.url),
    "utf8",
  ),
  cert = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  );
test("custom CA works without disabling TLS verification", async (t) => {
  const server = https.createServer({ key, cert }, (req, res) =>
    res.end("secure"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `https://127.0.0.1:${server.address().port}`;
  await assert.rejects(executeRequest({ url }), /certificate|self.signed/i);
  assert.equal(
    (await executeRequest({ url, tls: { ca: cert } })).body,
    "secure",
  );
});
test("HTTP proxy receives absolute URL and separate proxy authorization", async (t) => {
  let received;
  const proxy = http.createServer((req, res) => {
    received = { url: req.url, headers: req.headers };
    res.end("proxied");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const result = await executeRequest({
    url: "http://example.invalid/path",
    proxy: `http://user:pass@127.0.0.1:${proxy.address().port}`,
    auth: { type: "bearer", token: "origin-token" },
  });
  assert.equal(result.body, "proxied");
  assert.equal(received.url, "http://example.invalid/path");
  assert.equal(received.headers.authorization, "Bearer origin-token");
  assert.match(received.headers["proxy-authorization"], /^Basic /);
});
test("HTTPS proxy CONNECT keeps target TLS validation and does not forward proxy credentials", async (t) => {
  let originHeaders;
  const target = https.createServer({ key, cert }, (req, res) => {
    originHeaders = req.headers;
    res.end("tunneled");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const sockets = new Set(),
    proxy = http.createServer();
  proxy.on("connect", (req, client) => {
    const upstream = net.connect(target.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(client);
    sockets.add(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    target.close();
  });
  const result = await executeRequest({
    url: `https://127.0.0.1:${target.address().port}`,
    proxy: `http://user:pass@127.0.0.1:${proxy.address().port}`,
    tls: { ca: cert },
  });
  assert.equal(result.body, "tunneled");
  assert.equal(originHeaders["proxy-authorization"], undefined);
});
