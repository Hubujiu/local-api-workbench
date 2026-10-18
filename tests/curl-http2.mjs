// Linux integration: execute only generated commands for fixed local fixtures.
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toCurl } from "../src/core.mjs";
const exec = promisify(execFile),
  sessions = new Set(),
  sockets = new Set();
let connections = 0,
  requests = 0;
const target = http2.createServer();
target.on("session", (session) => {
  sessions.add(session);
  session.on("close", () => sessions.delete(session));
});
target.on("stream", (stream, headers) => {
  requests++;
  let body = "";
  stream.on("data", (chunk) => (body += chunk));
  stream.on("end", () => {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(
      JSON.stringify({
        path: headers[":path"],
        method: headers[":method"],
        body,
        authorization: headers.authorization,
        proxyAuthorization: headers["proxy-authorization"],
      }),
    );
  });
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
const proxy = http.createServer();
proxy.on("connect", (request, client) => {
  connections++;
  assert.equal(
    request.headers["proxy-authorization"],
    "Basic " + Buffer.from("fixture:password").toString("base64"),
  );
  const upstream = net.connect(target.address().port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
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
try {
  const version = await exec("curl", ["--version"]);
  assert.match(version.stdout, /HTTP2/);
  console.log(version.stdout.split("\n")[0]);
  for (const throughProxy of [false, true]) {
    const body = JSON.stringify({ name: "O'Brien [literal]" });
    const command = toCurl({
      url: "http://127.0.0.1:" + target.address().port + "/literal[1]",
      httpVersion: "2",
      method: "POST",
      bodyType: "json",
      body,
      auth: { type: "bearer", token: "origin-token" },
      proxy: throughProxy
        ? "http://fixture:password@127.0.0.1:" + proxy.address().port
        : "",
    });
    const { stdout } = await exec("/bin/sh", ["-c", command], {
      timeout: 5000,
      maxBuffer: 65536,
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        https_proxy: "http://127.0.0.1:1",
        NO_PROXY: "*",
        no_proxy: "*",
      },
    });
    const response = JSON.parse(stdout);
    assert.equal(response.path, "/literal[1]");
    assert.equal(response.method, "POST");
    assert.equal(response.body, body);
    assert.equal(response.authorization, "Bearer origin-token");
    assert.equal(response.proxyAuthorization, undefined);
  }
  assert.equal(connections, 1);
  assert.equal(requests, 2);
  console.log("CURL_HTTP2_DIRECT_AND_PROXY_PASSED");
} finally {
  for (const session of sessions) session.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => target.close(resolve)),
  ]);
}
