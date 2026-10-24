import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { readFile } from "node:fs/promises";
import { executeRequest } from "../src/runtime.mjs";
test("HTTP/2 sends real request body and returns status, headers and response bytes", async (t) => {
  const server = http2.createServer();
  const sessions = new Set();
  server.on("session", (s) => sessions.add(s));
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => {
      stream.respond({
        ":status": 201,
        "content-type": "application/json",
        "x-http2": "yes",
      });
      stream.end(JSON.stringify({ method: headers[":method"], body }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const session of sessions) session.destroy();
    server.close();
  });
  const response = await executeRequest({
    url: "http://127.0.0.1:" + server.address().port + "/h2",
    method: "POST",
    httpVersion: "2",
    bodyType: "json",
    body: '{"ok":true}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers["x-http2"], "yes");
  assert.equal(JSON.parse(response.body).body, '{"ok":true}');
});
test("HTTP/2 TLS verification remains on and custom CA is supported", async (t) => {
  const key = await readFile(
    new URL("./fixtures/localhost.key", import.meta.url),
  );
  const cert = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
  );
  const server = http2.createSecureServer({ key, cert });
  const sessions = new Set();
  server.on("session", (s) => sessions.add(s));
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("secure-h2");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const session of sessions) session.destroy();
    server.close();
  });
  const url = "https://127.0.0.1:" + server.address().port;
  await assert.rejects(
    executeRequest({ url, httpVersion: "2" }),
    /certificate|self.signed/i,
  );
  assert.equal(
    (
      await executeRequest({
        url,
        httpVersion: "2",
        tls: { ca: cert.toString() },
      })
    ).body,
    "secure-h2",
  );
});
